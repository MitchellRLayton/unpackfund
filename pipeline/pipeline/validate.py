"""Validate a built release against the artifact contract.

    python -m pipeline.validate --release artifacts/releases/2026-10-28.1

Runs offline, on files only — it never fetches. That is deliberate: the same
checks have to run on a release that was built last week, on a checkout with no
network, and in CI after an upload, and a validator that needs EDGAR cannot do
any of those.

Exit status is the gate. ``FAIL`` means the release must not be published;
``WARN`` means publishable but a human should read the number.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

from .artifact import SCHEMA_VERSION

REPO_ROOT = Path(__file__).resolve().parents[2]

REQUIRED_FIELDS = (
    "schema_version",
    "ticker",
    "fund_id",
    "name",
    "issuer",
    "as_of",
    "filed_at",
    "lag_days",
    "source",
    "source_url",
    "coverage_pct",
    "holdings",
    "metrics",
    "warnings",
)
REQUIRED_METRICS = ("hhi", "hhi_pct2", "effective_n", "top10_pct")
ALLOWED_SOURCES = {"SEC N-PORT"}
COVERED_CATEGORIES = {"equity", "debt", "fund"}
WARNING_ENUM = {
    "partial_coverage",
    "unmapped_holding",
    "cash_or_derivative",
    "stale_filing",
    "duplicate_company",
    "negative_weight",
    "fund_of_funds",
}
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
RELEASE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}(\.\d+)?$")
# A CUSIP is 3-digit issuer prefix + 5 alphanumeric + 1 check digit. Bounded so it
# cannot match inside a 10-digit CIK or a series id. Non-US issuers may use letters
# in the prefix, which this misses — hence the belt-and-braces key check.
CUSIP_RE = re.compile(r"(?<![0-9A-Za-z])[0-9]{3}[0-9A-Z]{5}[0-9](?![0-9A-Za-z])")

MIN_TOTAL_BP = 9_000
MAX_TOTAL_BP = 10_500
CONTRACT_WINDOW = (9_900, 10_000)

HHI_TOLERANCE = 1e-6
EFFECTIVE_N_TOLERANCE = 1e-6
PERCENT_TOLERANCE = 1e-4


class Report:
    def __init__(self) -> None:
        self.failures = 0
        self.warnings = 0

    def ok(self, check: str, detail: str = "") -> None:
        print(f"  ok   {check}{': ' + detail if detail else ''}")

    def fail(self, check: str, detail: str) -> None:
        self.failures += 1
        print(f"  FAIL {check}: {detail}")

    def warn(self, check: str, detail: str) -> None:
        self.warnings += 1
        print(f"  WARN {check}: {detail}")


def _load_release(release_dir: Path, report: Report) -> tuple[dict, list[dict]] | None:
    manifest_path = release_dir / "manifest.json"
    if not manifest_path.exists():
        report.fail("manifest", f"{manifest_path} does not exist")
        return None
    manifest = json.loads(manifest_path.read_text())
    funds = []
    for entry in manifest.get("files", []):
        path = release_dir / entry["path"]
        if not path.exists():
            report.fail("manifest.files", f"{entry['path']} listed but missing")
            continue
        payload = path.read_bytes()
        if len(payload) != entry["bytes"]:
            report.fail(
                "manifest.bytes", f"{entry['path']}: {len(payload)} != {entry['bytes']}"
            )
        digest = hashlib.sha256(payload).hexdigest()
        if digest != entry["sha256"]:
            report.fail(
                "manifest.sha256",
                f"{entry['path']}: {digest[:12]}… != {entry['sha256'][:12]}…",
            )
        funds.append(json.loads(payload))
    if not report.failures:
        report.ok("manifest.hashes", f"{len(funds)} files verify")
    return manifest, funds


def _check_manifest(manifest: dict, funds: list[dict], report: Report) -> None:
    if manifest.get("schema_version") != SCHEMA_VERSION:
        report.fail("manifest.schema_version", str(manifest.get("schema_version")))
    if not RELEASE_RE.match(str(manifest.get("as_of", ""))):
        report.fail("manifest.as_of", f"{manifest.get('as_of')!r} is not a release id")
    if manifest.get("fund_count") != len(funds):
        report.fail(
            "manifest.fund_count", f"{manifest.get('fund_count')} != {len(funds)} files"
        )
    if manifest.get("etf_count") is None and not str(
        manifest.get("etf_classifier", "")
    ).startswith("pending"):
        report.fail("manifest.etf_count", "null without a stated reason")
    histogram = manifest.get("coverage_histogram") or {}
    if sum(histogram.values()) != len(funds):
        report.fail("manifest.coverage_histogram", f"sums to {sum(histogram.values())}")
    # A validator that crashes on a malformed release is not a validator: read
    # defensively here, and let the per-fund checks report the missing field.
    companies = {
        row["company_id"]
        for fund in funds
        for row in fund.get("holdings") or []
        if row.get("company_id")
    }
    if manifest.get("company_count") != len(companies):
        report.fail(
            "manifest.company_count", f"{manifest.get('company_count')} != {len(companies)}"
        )
    # Referential integrity: every listed file is a fund, and every fund is listed.
    listed = {entry["path"] for entry in manifest.get("files", [])}
    tickers = {fund.get("ticker", "") for fund in funds}
    if listed != {f"funds/{ticker}.json" for ticker in tickers if ticker}:
        report.fail("manifest.files", "listed paths do not match the fund set")
    if len(tickers) != len(funds):
        report.fail("manifest.unique_tickers", "duplicate ticker in release")


def _check_fund(document: dict, report: Report) -> None:
    ticker = document.get("ticker", "?")
    missing = [field for field in REQUIRED_FIELDS if field not in document]
    if missing:
        report.fail(f"{ticker}.fields", f"missing {missing}")
        return
    if document["schema_version"] != SCHEMA_VERSION:
        report.fail(f"{ticker}.schema_version", str(document["schema_version"]))
    if document["source"] not in ALLOWED_SOURCES:
        report.fail(f"{ticker}.source", str(document["source"]))
    if not str(document["source_url"]).startswith("https://www.sec.gov/"):
        report.fail(f"{ticker}.source_url", "not an https SEC Archives URL")
    for field in ("as_of", "filed_at"):
        if not DATE_RE.match(str(document[field])):
            report.fail(f"{ticker}.{field}", f"{document[field]!r} is not a date")
    if document["filed_at"] < document["as_of"]:
        report.fail(f"{ticker}.lag", "filed_at is before as_of")
    coverage = document["coverage_pct"]
    if not isinstance(coverage, (int, float)) or not 0 <= coverage <= 100:
        report.fail(f"{ticker}.coverage_pct", str(coverage))
    unknown = set(document["warnings"]) - WARNING_ENUM
    if unknown:
        report.fail(f"{ticker}.warnings", f"not in the enum: {sorted(unknown)}")

    holdings = document["holdings"]
    if not holdings:
        report.fail(f"{ticker}.holdings", "empty")
        return

    # Shape and ordering.
    order = [(-row["weight_bp"], row["name"].upper()) for row in holdings]
    if order != sorted(order):
        report.fail(
            f"{ticker}.holdings.order",
            "not sorted by (-weight_bp, name); a rebuild would not be byte-identical",
        )
    for row in holdings:
        if not isinstance(row["weight_bp"], int):
            report.fail(f"{ticker}.weight_bp", f"{row['weight_bp']!r} is not an integer")
            break
        if row["asset_cat"] not in COVERED_CATEGORIES | {"cash", "derivative", "other"}:
            report.fail(f"{ticker}.asset_cat", str(row["asset_cat"]))
            break

    # Duplicates.
    seen = [row["company_id"] for row in holdings if row["company_id"]]
    if len(seen) != len(set(seen)):
        report.fail(f"{ticker}.duplicate_company", "the same company_id appears twice")

    # Weight sum. The contract's ≤10,000 window is a renormalised-fund invariant;
    # as-filed vectors legitimately exceed it when derivatives sit outside NAV, so
    # the hard gate is the wider band and the contract window is a WARN.
    total_bp = sum(row["weight_bp"] for row in holdings)
    if not MIN_TOTAL_BP <= total_bp <= MAX_TOTAL_BP:
        report.fail(f"{ticker}.weight_sum", f"{total_bp} bp outside [{MIN_TOTAL_BP}, {MAX_TOTAL_BP}]")
    elif not CONTRACT_WINDOW[0] <= total_bp <= CONTRACT_WINDOW[1]:
        report.warn(
            f"{ticker}.weight_sum",
            f"{total_bp} bp is outside the contract window {CONTRACT_WINDOW} — "
            f"as-filed residual, reported on the fund page",
        )

    # Metric recompute from weight_bp alone.
    weights = sorted(
        (
            row["weight_bp"] / 10_000
            for row in holdings
            if row["company_id"]
            and row["asset_cat"] in COVERED_CATEGORIES
            and row["weight_bp"] > 0
        ),
        reverse=True,
    )
    metrics = document["metrics"]
    missing_metrics = [field for field in REQUIRED_METRICS if field not in metrics]
    if missing_metrics:
        report.fail(f"{ticker}.metrics", f"missing {missing_metrics}")
        return
    if not weights:
        if any(metrics[field] is not None for field in REQUIRED_METRICS):
            report.fail(f"{ticker}.metrics", "no covered weight but metrics are set")
        return
    if any(metrics[field] is None for field in REQUIRED_METRICS):
        report.fail(f"{ticker}.metrics", "covered weight exists but a metric is null")
        return
    hhi = sum(weight * weight for weight in weights)
    if abs(metrics["hhi"] - hhi) > HHI_TOLERANCE:
        report.fail(f"{ticker}.metrics.hhi", f"{metrics['hhi']!r} != {hhi!r}")
    if abs(metrics["hhi_pct2"] - hhi * 10_000) > PERCENT_TOLERANCE:
        report.fail(f"{ticker}.metrics.hhi_pct2", f"{metrics['hhi_pct2']!r} != {hhi * 10_000!r}")
    if abs(metrics["effective_n"] - 1 / hhi) > EFFECTIVE_N_TOLERANCE:
        report.fail(f"{ticker}.metrics.effective_n", f"{metrics['effective_n']!r} != {1 / hhi!r}")
    if abs(metrics["top10_pct"] - sum(weights[:10]) * 100) > PERCENT_TOLERANCE:
        report.fail(f"{ticker}.metrics.top10_pct", str(metrics["top10_pct"]))


def _check_cusip(release_dir: Path, report: Report) -> None:
    """No CUSIP, ISIN or other licensed identifier may leave the pipeline."""
    offenders = []
    for path in sorted(release_dir.rglob("*.json")):
        text = path.read_text()
        if re.search(r'"(cusip|isin|CUSIP|ISIN)"\s*:', text):
            offenders.append(f"{path.name}: licensed identifier key")
        match = CUSIP_RE.search(text)
        if match:
            offenders.append(f"{path.name}: CUSIP-shaped token {match.group(0)!r}")
    if offenders:
        report.fail("cusip", "; ".join(offenders))
    else:
        report.ok("cusip", "no CUSIP/ISIN keys or CUSIP-shaped tokens")


def _check_budget(release_dir: Path, report: Report) -> None:
    funds = list((release_dir / "funds").glob("*.json"))
    total = sum(path.stat().st_size for path in release_dir.rglob("*") if path.is_file())
    largest = max((path.stat().st_size for path in funds), default=0)
    if largest > 200_000:
        report.fail("budget.per_fund", f"largest fund is {largest:,} bytes")
    else:
        report.ok("budget", f"{len(funds)} funds, largest {largest:,} B, release {total:,} B")


def validate(release_dir: Path) -> int:
    report = Report()
    print(f"validating {release_dir}")
    loaded = _load_release(release_dir, report)
    if loaded is None:
        print(f"\n{report.failures} failure(s)")
        return 1
    manifest, funds = loaded
    _check_manifest(manifest, funds, report)
    for document in funds:
        _check_fund(document, report)
    _check_cusip(release_dir, report)
    _check_budget(release_dir, report)
    print(
        f"\n{len(funds)} funds · {report.failures} failure(s) · "
        f"{report.warnings} warning(s)"
    )
    return 1 if report.failures else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m pipeline.validate", description=__doc__)
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument(
        "--release",
        type=Path,
        help="release directory, e.g. artifacts/releases/2026-10-28.1",
    )
    target.add_argument(
        "--fixtures",
        action="store_true",
        help="build the committed fixture release offline and check it (CI form)",
    )
    args = parser.parse_args(argv)
    if args.fixtures:
        from . import fixtures

        release_dir = fixtures.write_sample_release(
            Path(__file__).resolve().parents[2] / "artifacts" / "fixtures"
        )
        return validate(release_dir)
    release_dir = _resolve_release(args.release)
    if release_dir is None or not release_dir.exists():
        print(f"FAIL: {args.release} does not exist")
        return 1
    return validate(release_dir)


def _resolve_release(target: Path) -> Path | None:
    """Accept a path or a bare release id.

    ``pnpm data:validate`` runs with ``packages/pipeline`` as its working
    directory, so a repo-relative path a human typed at the root would silently
    point at the wrong place. A bare id (``2026-10-28.1``) is resolved against
    ``artifacts/releases/``, and an explicit path is taken as given.
    """
    if target.exists():
        return target
    if target.is_absolute() or len(target.parts) > 1:
        return None
    return REPO_ROOT / "artifacts" / "releases" / target.name


if __name__ == "__main__":
    sys.exit(main())
