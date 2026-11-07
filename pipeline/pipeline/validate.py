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
import gzip
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

from .identifiers import LICENSED_ID_RE, is_licensed
from .gleif import is_issuer_id, is_sec_company_id, LEI_RE

from . import paths
from . import sizes
from . import benchmarks as benchmarks_mod
from . import classification_generated
from . import company_countries as company_countries_mod
from .artifact import LARGE_FUND_BYTES, MAX_FUND_BYTES, SCHEMA_VERSION
from .classify import CATEGORY_ORDER
from .fund_lookthrough import MAX_DEPTH, RUNG_LEI, RUNG_SYMBOL, SLEEVE_MIXED
from .fund_lookthrough import MIN_UNRESOLVED_WARNING_BP

REPO_ROOT = paths.REPO_ROOT

#: A published fund ticker: upper-case, starts alphanumeric, short.
TICKER_RE = re.compile(r"^[A-Z0-9][A-Z0-9.\-]{0,9}$")

#: A published company id: ``c_`` + 10-digit CIK, or ``l_`` + 16 hex (companies.py).
COMPANY_ID_RE = re.compile(r"^(?:c_\d{10}|l_[0-9a-f]{16})$")
#: ``YYYY-MM-DD``, the shape every date in a release carries. The size table is the
#: one object where a date is an argument rather than a filing artefact (ADR-0022).
_DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

#: The statuses a typed-symbol row may carry. Everything that is not ``ok`` is a
#: refusal with the reason the UI names; the client owns the message.
_SECURITY_STATUSES = frozenset({"ok", "fund", "pfd", "wnt", "unit", "rgt", "twin"})

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
    "etf",
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
    "fund_of_funds_unresolved",
}
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
RELEASE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}(\.\d+)?$")
# A CUSIP is 3-digit issuer prefix + 5 alphanumeric + 1 check digit. Bounded so it
# cannot match inside a 10-digit CIK or a series id. Non-US issuers may use letters
# in the prefix, which this misses — hence the belt-and-braces key check.
# Imported rather than restated: the pattern that redacts in ``artifact`` and the
# pattern that fails the release here must be the same rule.
CUSIP_RE = LICENSED_ID_RE

MIN_TOTAL_BP = 9_000
MAX_TOTAL_BP = 10_500
#: A composed vector is a weighted sum of the sleeves' vectors, so it inherits their
#: over-sum: each sleeve is itself allowed up to ``MAX_TOTAL_BP``, and a chain of
#: ``MAX_DEPTH`` hops multiplies that factor that many times. 10,500 × 1.05² ≈ 11,576,
#: which is why the bound is derived rather than chosen — and why it still catches the
#: failure this gate exists for, a weight accidentally multiplied by 10,000.
MAX_COMPOSED_TOTAL_BP = round(MAX_TOTAL_BP * (MAX_TOTAL_BP / 10_000) ** (MAX_DEPTH - 1))
CONTRACT_WINDOW = (9_900, 10_000)

HHI_TOLERANCE = 1e-6
EFFECTIVE_N_TOLERANCE = 1e-6
PERCENT_TOLERANCE = 1e-4
#: The identification fields publish one decimal — ``round(..., 1)``, the same helper
#: ``coverage_pct`` and ``coverage_by_cat`` use — so a correct value is the exact ratio
#: rounded, and comparing against the unrounded recomputation to ``PERCENT_TOLERANCE``
#: alone would fail it by its own rounding. The band is therefore half a rounding unit
#: plus the tolerance: smaller than any disagreement worth a failure, and still ~20×
#: tighter than the one-point inversion this check exists to catch.
IDENTIFIED_PERCENT_SLACK = 0.05 + PERCENT_TOLERANCE
#: The manifest's integers are compared exactly; its percentages use the band above.
MANIFEST_TOLERANCE = 1e-3


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


def _check_manifest(manifest: dict, funds: list[dict], report: Report, release_dir: Path) -> None:
    if manifest.get("schema_version") != SCHEMA_VERSION:
        report.fail("manifest.schema_version", str(manifest.get("schema_version")))
    if not RELEASE_RE.match(str(manifest.get("as_of", ""))):
        report.fail("manifest.as_of", f"{manifest.get('as_of')!r} is not a release id")
    elif manifest.get("as_of") != release_dir.name:
        # The published path is releases/{as_of}/, so a mismatch would publish a
        # release whose directory a pointer cannot name.
        report.fail(
            "manifest.as_of",
            f"{manifest.get('as_of')!r} does not match the release directory {release_dir.name!r}",
        )
    if manifest.get("fund_count") != len(funds):
        report.fail(
            "manifest.fund_count", f"{manifest.get('fund_count')} != {len(funds)} files"
        )
    if manifest.get("etf_count") is None and not str(
        manifest.get("etf_classifier", "")
    ).startswith("pending"):
        report.fail("manifest.etf_count", "null without a stated reason")
    elif manifest.get("etf_count") is not None:
        # The count and the labels are two spellings of one fact. They disagreed
        # once — the count said 3,172, every published label said "no" — and the
        # only reason nobody noticed is that nothing compared them.
        labelled = sum(1 for fund in funds if fund.get("etf") is True)
        if manifest["etf_count"] != labelled:
            report.fail(
                "manifest.etf_count",
                f"{manifest['etf_count']} != {labelled} fund(s) labelled etf",
            )
        elif labelled and labelled == len(funds):
            report.warn("manifest.etf_count", "every fund is labelled an ETF — the test is broken")
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


def _total_ceiling(document: dict) -> int:
    """The band a fund's published weights must sum into.

    A composed vector is a weighted sum of its sleeves' vectors, so it inherits their
    over-sum: 10,587 bp is SSAJX, whose eleven sleeves average 10,380 bp and are then
    weighted by a parent that is itself 10,200 bp. The ceiling is derived from that
    (``MAX_COMPOSED_TOTAL_BP``), not chosen, and it still catches the failure this gate
    exists for — a weight accidentally multiplied by 10,000.
    """
    return MAX_COMPOSED_TOTAL_BP if document.get("lookthrough") else MAX_TOTAL_BP


def _identified_split(holdings: list[dict[str, Any]]) -> dict[str, Any]:
    """``Σ|weight_bp|`` and the identified part of it, overall and per class.

    Recomputed from the rows the document publishes, never read from the document's own
    summary fields: the numbers this gate disagrees with are the summary fields.
    """
    gross = 0
    found = 0
    by_gross: dict[str, int] = {}
    by_found: dict[str, int] = {}
    for row in holdings:
        size = abs(row["weight_bp"])
        name = row.get("asset_cat")
        gross += size
        by_gross[name] = by_gross.get(name, 0) + size
        if row.get("company_id") or row.get("identified"):
            found += size
            by_found[name] = by_found.get(name, 0) + size
    return {"gross": gross, "found": found, "by_gross": by_gross, "by_found": by_found}


def _check_identified(document: dict, report: Report) -> None:
    """Identification is a superset of attribution, and the release publishes both.

    ``coverage_pct`` counts the weight that resolved to a company; ``identified_pct``
    counts the weight that resolved to anything — the same rows, plus every named
    security, fund share, Treasury line and cash sweep. Four promises are held here:

    - the published ratio is the ratio of the rows the document publishes, so it cannot
      claim an identity its own vector does not carry;
    - the per-class split is the same computation inside one class, with ``null`` for a
      class that holds no weight (a percentage of nothing is undefined, not zero);
    - **identification never falls below attribution.** An ``identified_pct`` below
      ``coverage_pct`` is a mis-wired identifier map, and publishing it would print two
      numbers that contradict each other on the same page. This is the gate that catches
      the wiring, not the arithmetic, so it is checked against the published
      ``coverage_pct`` rather than against a recomputation of it;
    - a row carrying ``company_id`` carries ``identified: true``. A weight that reached
      a company was, by that fact, identified.

    Absent, the fields are valid: they are additive to fund schema 1, so a release built
    before the contract asked for them still validates (the ``net_assets`` rule). Half
    present — one field without the other, or a document that publishes the summary and
    rows that do not carry the flag — is the defect, and that is a failure.
    """
    ticker = document.get("ticker", "?")
    holdings = document.get("holdings") or []
    has_pct = "identified_pct" in document
    has_cat = "identified_by_cat" in document
    has_flag = any("identified" in row for row in holdings)
    if not (has_pct or has_cat or has_flag):
        return
    if not (has_pct and has_cat):
        published = "identified_pct" if has_pct else "identified_by_cat"
        report.fail(
            f"{ticker}.identified_by_cat",
            f"missing: the document publishes {published} without it",
        )
        return
    pct = document["identified_pct"]
    if isinstance(pct, bool) or not isinstance(pct, (int, float)) or not 0 <= pct <= 100:
        report.fail(f"{ticker}.identified_pct", f"{pct!r} is not a percentage")
        return

    for row in holdings:
        name = row.get("name")
        if "identified" not in row:
            report.fail(
                f"{ticker}.holdings.identified",
                f"{name!r} ({row.get('weight_bp')} bp) has no identified flag while the "
                "document publishes identified_pct",
            )
            continue
        if not isinstance(row["identified"], bool):
            report.fail(
                f"{ticker}.holdings.identified",
                f"{name!r}: {row['identified']!r} is not a boolean",
            )
        if row.get("company_id") and row["identified"] is False:
            report.fail(
                f"{ticker}.holdings.identified",
                f"{name!r} ({row['weight_bp']} bp) carries company_id {row['company_id']} "
                "with identified: false — attribution implies identification",
            )

    split = _identified_split(holdings)
    exact = 100 * split["found"] / split["gross"] if split["gross"] else 0.0
    if abs(pct - exact) > IDENTIFIED_PERCENT_SLACK:
        report.fail(
            f"{ticker}.identified_pct",
            f"{pct} != {exact:.4f} recomputed from the vector "
            f"({split['found']} of {split['gross']} bp identified)",
        )

    coverage = document.get("coverage_pct")
    if (
        isinstance(coverage, (int, float))
        and not isinstance(coverage, bool)
        and pct < coverage
    ):
        report.fail(
            f"{ticker}.identified_pct",
            f"{pct} < coverage_pct {coverage} — identification is a superset of "
            "attribution, so this document is mis-wired",
        )

    by_cat = document["identified_by_cat"]
    if not isinstance(by_cat, dict):
        report.fail(f"{ticker}.identified_by_cat", f"{by_cat!r} is not an object")
        return
    unknown = sorted(set(by_cat) - set(CATEGORY_ORDER))
    missing = [name for name in CATEGORY_ORDER if name not in by_cat]
    if unknown or missing:
        report.fail(f"{ticker}.identified_by_cat", f"missing {missing}, unknown {unknown}")
        return
    for name in CATEGORY_ORDER:
        published = by_cat[name]
        gross = split["by_gross"].get(name, 0)
        if not gross:
            if published is not None:
                report.fail(
                    f"{ticker}.identified_by_cat.{name}",
                    f"{published!r} for a class with no weight; expected null",
                )
            continue
        if published is None:
            report.fail(
                f"{ticker}.identified_by_cat.{name}",
                f"null for a class holding {gross} bp",
            )
            continue
        if isinstance(published, bool) or not isinstance(published, (int, float)):
            report.fail(
                f"{ticker}.identified_by_cat.{name}", f"{published!r} is not a percentage"
            )
            continue
        expected = 100 * split["by_found"].get(name, 0) / gross
        if abs(published - expected) > IDENTIFIED_PERCENT_SLACK:
            report.fail(
                f"{ticker}.identified_by_cat.{name}",
                f"{published} != {expected:.4f} recomputed "
                f"({split['by_found'].get(name, 0)} of {gross} bp identified)",
            )


def _check_identified_release(
    manifest: dict, funds: list[dict], report: Report
) -> None:
    """The manifest's four identification fields, against every fund document.

    Those fields are derived from the documents precisely so they cannot disagree with
    the files the manifest hashes (the ``etf_count`` rule); this is the check that holds
    the derivation to it. A release states all four or none — half a block is a manifest
    that will be read as a partial claim by whichever consumer reads last.
    """
    failures_before = report.failures
    fields = ("identified_pct", "identified_bp", "total_bp", "identified_by_cat")
    present = [field for field in fields if field in manifest]
    documented = any("identified_pct" in fund for fund in funds)
    if not present:
        if documented:
            report.fail(
                "manifest.identified",
                "the funds publish identified_pct but the manifest states none of the four fields",
            )
        else:
            report.ok("identified", "absent (release predates the field)")
        return
    if len(present) != len(fields):
        absent = [field for field in fields if field not in manifest]
        report.fail("manifest.identified", f"published {present}, missing {absent}")
        return
    if not documented:
        report.fail(
            "manifest.identified",
            "the manifest states identification but no fund document carries it",
        )
        return

    totals = {"gross": 0, "found": 0, "by_gross": {}, "by_found": {}}
    for fund in funds:
        part = _identified_split(fund.get("holdings") or [])
        totals["gross"] += part["gross"]
        totals["found"] += part["found"]
        for name, size in part["by_gross"].items():
            totals["by_gross"][name] = totals["by_gross"].get(name, 0) + size
        for name, size in part["by_found"].items():
            totals["by_found"][name] = totals["by_found"].get(name, 0) + size

    pct = manifest["identified_pct"]
    identified_bp = manifest["identified_bp"]
    total_bp = manifest["total_bp"]
    if isinstance(pct, bool) or not isinstance(pct, (int, float)) or not 0 <= pct <= 100:
        report.fail("manifest.identified_pct", f"{pct!r} is not a percentage")
    for field, value in (("identified_bp", identified_bp), ("total_bp", total_bp)):
        if isinstance(value, bool) or not isinstance(value, int):
            report.fail(f"manifest.{field}", f"{value!r} is not an integer")
    if (
        isinstance(identified_bp, int)
        and isinstance(total_bp, int)
        and identified_bp > total_bp
    ):
        report.fail(
            "manifest.identified_bp",
            f"{identified_bp:,} bp identified exceeds {total_bp:,} bp published",
        )
    # Integers, so the comparison is exact: an bp of difference came from a document
    # the manifest did not read.
    if isinstance(identified_bp, int) and identified_bp != totals["found"]:
        report.fail(
            "manifest.identified_bp",
            f"{identified_bp:,} != {totals['found']:,} recomputed from the funds",
        )
    if isinstance(total_bp, int) and total_bp != totals["gross"]:
        report.fail(
            "manifest.total_bp",
            f"{total_bp:,} != {totals['gross']:,} recomputed from the funds",
        )
    exact = 100 * totals["found"] / totals["gross"] if totals["gross"] else 0.0
    if isinstance(pct, (int, float)) and not isinstance(pct, bool):
        if abs(pct - exact) > IDENTIFIED_PERCENT_SLACK + MANIFEST_TOLERANCE:
            report.fail(
                "manifest.identified_pct",
                f"{pct} != {exact:.4f} recomputed from the funds",
            )

    by_cat = manifest["identified_by_cat"]
    if not isinstance(by_cat, dict):
        report.fail("manifest.identified_by_cat", f"{by_cat!r} is not an object")
        return
    unknown = sorted(set(by_cat) - set(CATEGORY_ORDER))
    missing = [name for name in CATEGORY_ORDER if name not in by_cat]
    if unknown or missing:
        report.fail("manifest.identified_by_cat", f"missing {missing}, unknown {unknown}")
        return
    for name in CATEGORY_ORDER:
        published = by_cat[name]
        gross = totals["by_gross"].get(name, 0)
        if not gross:
            if published is not None:
                report.fail(
                    f"manifest.identified_by_cat.{name}",
                    f"{published!r} for a class with no weight; expected null",
                )
            continue
        if published is None:
            report.fail(
                f"manifest.identified_by_cat.{name}",
                f"null for a class holding {gross} bp",
            )
            continue
        if isinstance(published, bool) or not isinstance(published, (int, float)):
            report.fail(
                f"manifest.identified_by_cat.{name}", f"{published!r} is not a percentage"
            )
            continue
        expected = 100 * totals["by_found"].get(name, 0) / gross
        if abs(published - expected) > IDENTIFIED_PERCENT_SLACK + MANIFEST_TOLERANCE:
            report.fail(
                f"manifest.identified_by_cat.{name}",
                f"{published} != {expected:.4f} recomputed from the funds",
            )
    if report.failures == failures_before:
        report.ok(
            "identified",
            f"{pct}% of gross identified ({identified_bp:,} of {total_bp:,} bp)",
        )


def _check_fund(document: dict, report: Report) -> None:
    ticker = document.get("ticker", "?")
    missing = [field for field in REQUIRED_FIELDS if field not in document]
    if missing:
        report.fail(f"{ticker}.fields", f"missing {missing}")
        return
    if document["schema_version"] != SCHEMA_VERSION:
        report.fail(f"{ticker}.schema_version", str(document["schema_version"]))
    # ``etf`` is additive to schema 1 and required in practice: an absent label
    # counted as "not an ETF" for 8,531 funds once, so absence is a failure now.
    if not isinstance(document.get("etf"), bool):
        report.fail(f"{ticker}.etf", f"{document.get('etf')!r} is not a boolean")
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
    # ``net_assets`` is additive to schema 1, the same rule as ``etf``'s label: absent
    # is valid, because a filing can report none and a release built before 2026-11-02
    # was not asked for it. Present, it must be a non-negative number — the `/funds`
    # directory orders every fund by it, so a string or a negative would sort the list
    # by something that is not a size. ``null`` is the explicit "the filing gave none"
    # state and is not the same as zero.
    if "net_assets" in document:
        net_assets = document["net_assets"]
        if net_assets is not None and (
            isinstance(net_assets, bool)
            or not isinstance(net_assets, (int, float))
            or net_assets < 0
        ):
            report.fail(
                f"{ticker}.net_assets",
                f"{net_assets!r} is not a non-negative number or null",
            )
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
    ceiling = _total_ceiling(document)
    if not MIN_TOTAL_BP <= total_bp <= ceiling:
        report.fail(f"{ticker}.weight_sum", f"{total_bp} bp outside [{MIN_TOTAL_BP}, {ceiling}]")
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

    _check_categories(document, report)
    _check_identified(document, report)
    _check_fund_of_funds(document, report)


#: A fund publishing at least this much in funds must name the sleeves it holds.
#: It is the release's own threshold for "materially a wrapper" (``MIN_LOOKTHROUGH_BP``),
#: restated as a gate rather than imported, because the two mean different things: one
#: decides whether to flatten, this one decides whether a composition is unexplained.
MIN_COMPONENT_BP = 500


def _check_categories(document: dict, report: Report) -> None:
    """ADR-0016 §2–§5: the split must account for the vector, and the labels must be real.

    Recomputed from ``holdings``, never trusted: the whole point of publishing a split is
    that a reader can check it, and a gate that reads the field it is checking cannot.
    """
    ticker = document.get("ticker", "?")
    categories = document.get("categories")
    coverage_by_cat = document.get("coverage_by_cat")
    if categories is None or coverage_by_cat is None:
        report.fail(f"{ticker}.categories", "missing; ADR-0016 requires both objects")
        return
    if set(categories) != set(CATEGORY_ORDER):
        report.fail(f"{ticker}.categories.keys", f"{sorted(categories)}")
    if set(coverage_by_cat) != set(CATEGORY_ORDER):
        report.fail(f"{ticker}.coverage_by_cat.keys", f"{sorted(coverage_by_cat)}")

    recomputed = {name: 0 for name in CATEGORY_ORDER}
    gross = {name: 0 for name in CATEGORY_ORDER}
    mapped = {name: 0 for name in CATEGORY_ORDER}
    for row in document["holdings"]:
        recomputed[row["asset_cat"]] = recomputed.get(row["asset_cat"], 0) + row["weight_bp"]
        size = abs(row["weight_bp"])
        gross[row["asset_cat"]] = gross.get(row["asset_cat"], 0) + size
        if row["company_id"]:
            mapped[row["asset_cat"]] = mapped.get(row["asset_cat"], 0) + size

    if {name: categories.get(name) for name in CATEGORY_ORDER} != recomputed:
        report.fail(
            f"{ticker}.categories",
            f"{categories} != {recomputed} recomputed from the vector",
        )
    for name in CATEGORY_ORDER:
        published = coverage_by_cat.get(name)
        total = gross[name]
        if not total:
            if published is not None:
                report.fail(
                    f"{ticker}.coverage_by_cat.{name}",
                    f"{published!r} for a class with no weight",
                )
            continue
        expected = round(100 * mapped[name] / total, 1)
        if not isinstance(published, (int, float)) or abs(published - expected) > 0.05:
            report.fail(
                f"{ticker}.coverage_by_cat.{name}",
                f"{published!r} != {expected} recomputed from the vector",
            )

    # If we publish ≥5% in funds, the sleeves have to be named — a composition nobody can
    # read is the state ADR-0013 was written to end.
    if abs(categories.get("fund", 0)) >= MIN_COMPONENT_BP and not document.get("components"):
        report.fail(
            f"{ticker}.components",
            f"{categories.get('fund')} bp in funds but no components",
        )


def _check_fund_of_funds(document: dict, report: Report) -> None:
    """A flattened fund's own bookkeeping: the two fields that explain the vector.

    The gate exists because a flattened wrapper is the one place where ``holdings`` is
    not what the filer wrote. If the provenance is wrong, nothing downstream can tell
    a composed weight from a filed one — so the numbers that describe the composition
    are recomputed here from the vector itself, the same way the metrics are.
    """
    ticker = document.get("ticker", "?")
    lookthrough = document.get("lookthrough")
    components = document.get("components")
    warnings = set(document.get("warnings") or [])

    if lookthrough is None and components is None:
        return
    if components is None:
        report.fail(f"{ticker}.components", "lookthrough without components")
        return

    # --- components: the sleeve view
    seen: set[str] = set()
    order = [(-row["weight_bp"], row["name"].upper()) for row in components]
    if order != sorted(order):
        report.fail(f"{ticker}.components.order", "not sorted by (-weight_bp, name)")
    total_components = 0
    for row in components:
        for field in ("ticker", "name", "weight_bp", "coverage_pct", "resolved_by"):
            if field not in row:
                report.fail(f"{ticker}.components.fields", f"missing {field}")
                return
        # A negative sleeve is a short position in a fund (BRMSX is long 1,398 bp of
        # ETFs and short 688 bp of SPY); it is published, not filtered, because the
        # sleeve view has to explain the vector it came from.
        if not isinstance(row["weight_bp"], int) or row["weight_bp"] == 0:
            report.fail(f"{ticker}.components.weight_bp", f"{row['weight_bp']!r}")
            return
        if row["resolved_by"] not in (RUNG_LEI, RUNG_SYMBOL, None):
            report.fail(f"{ticker}.components.resolved_by", str(row["resolved_by"]))
        # ADR-0016 §4. `None` is legal only for a sleeve we could not resolve: we do not
        # know what it holds, so a label would be a guess.
        if row.get("asset_cat") not in (*CATEGORY_ORDER, SLEEVE_MIXED, None):
            report.fail(f"{ticker}.components.asset_cat", str(row.get("asset_cat")))
        elif row.get("asset_cat") is None and row["resolved_by"]:
            report.fail(
                f"{ticker}.components.asset_cat", "resolved sleeve with no label"
            )
        total_components += row["weight_bp"]
        if row["ticker"]:
            if row["ticker"] in seen:
                report.fail(f"{ticker}.components.duplicate", str(row["ticker"]))
            seen.add(row["ticker"])
            if not TICKER_RE.match(str(row["ticker"])):
                report.fail(f"{ticker}.components.ticker", str(row["ticker"]))
        elif row["resolved_by"]:
            report.fail(f"{ticker}.components.resolved_by", "resolved but no ticker")

    # --- lookthrough: how the vector was produced
    if lookthrough is not None:
        for field in (
            "depth",
            "fund_bp",
            "resolved_fund_bp",
            "unresolved_fund_bp",
            "as_of_skew_days",
            "holdings_bp",
            "refused",
        ):
            if field not in lookthrough:
                report.fail(f"{ticker}.lookthrough.fields", f"missing {field}")
                return
        if not 1 <= lookthrough["depth"] <= MAX_DEPTH:
            report.fail(f"{ticker}.lookthrough.depth", str(lookthrough["depth"]))
        if not 0 <= lookthrough["resolved_fund_bp"] <= lookthrough["fund_bp"]:
            report.fail(
                f"{ticker}.lookthrough.resolved_fund_bp",
                f"{lookthrough['resolved_fund_bp']} > fund_bp {lookthrough['fund_bp']}",
            )
        if lookthrough["unresolved_fund_bp"] < 0:
            report.fail(f"{ticker}.lookthrough.unresolved_fund_bp", "negative")
        # The vector is the authority: ``holdings_bp`` must be its own sum, or the
        # provenance describes a different vector than the one published.
        published = sum(row["weight_bp"] for row in document["holdings"])
        if published != lookthrough["holdings_bp"]:
            report.fail(
                f"{ticker}.lookthrough.holdings_bp",
                f"{lookthrough['holdings_bp']} != Σ holdings {published}",
            )
        # And the sleeves the provenance claims to have expanded are the sleeves the
        # flatten was given: a component sum that disagrees with fund_bp means one of
        # the two was filtered differently.
        if total_components != lookthrough["fund_bp"]:
            report.fail(
                f"{ticker}.lookthrough.fund_bp",
                f"components sum {total_components} != fund_bp {lookthrough['fund_bp']}",
            )
        # Coverage is recomputed from the flattened vector, not trusted.
        gross = sum(abs(row["weight_bp"]) for row in document["holdings"])
        mapped = sum(
            abs(row["weight_bp"]) for row in document["holdings"] if row["company_id"]
        )
        expected = round(100 * mapped / gross, 1) if gross else 0.0
        if abs(document["coverage_pct"] - expected) > 0.05:
            report.fail(
                f"{ticker}.lookthrough.coverage",
                f"{document['coverage_pct']} != {expected} recomputed from the vector",
            )
        if "fund_of_funds" not in warnings:
            report.fail(f"{ticker}.warnings", "flattened but not labelled fund_of_funds")
        residual = lookthrough["unresolved_fund_bp"]
        labelled = "fund_of_funds_unresolved" in warnings
        if residual >= MIN_UNRESOLVED_WARNING_BP and not labelled:
            report.fail(
                f"{ticker}.warnings",
                f"{residual} bp unresolved but fund_of_funds_unresolved is missing",
            )
        if labelled and residual < MIN_UNRESOLVED_WARNING_BP:
            report.fail(
                f"{ticker}.warnings",
                f"fund_of_funds_unresolved with only {residual} bp unresolved",
            )


def _check_fund_of_funds_release(funds: list[dict], report: Report) -> None:
    """Release-level: every sleeve a fund names must be a fund the release publishes."""
    published = {str(fund.get("ticker")) for fund in funds}
    flattened = 0
    components = 0
    for document in funds:
        if "lookthrough" in document:
            flattened += 1
        for row in document.get("components") or []:
            components += 1
            if row.get("ticker") and row["ticker"] not in published:
                report.fail(
                    f"{document.get('ticker')}.components",
                    f"sleeve {row['ticker']} is not a published fund",
                )
    if components and not flattened:
        report.warn(
            "fund_of_funds",
            f"{components} sleeves named but no fund was flattened — the flatten is off",
        )
    if flattened:
        report.ok("fund_of_funds", f"{flattened} funds flattened, {components} sleeves named")
    _check_fund_rows_by_name(funds, report)


#: A row this heavy that carries a published fund's name is not a coincidence worth
#: tolerating: it is a fund position the classifier did not see (ADR-0016 §5).
FUND_NAME_ROW_BP = 100

#: How many funds may carry such a row before the release is refused. One is a filer
#: omission (see the docstring); sixty is the Vanguard defect arriving again, and that is
#: what this gate exists to stop. Between the two, the honest signal is a warning: the
#: release publishes, the named funds are visible in the validator output and in the day
#: log, and nobody has to keep a whitelist in the code to get a release out.
MAX_FUND_NAME_ROW_FUNDS = 20


def _check_fund_rows_by_name(funds: list[dict], report: Report) -> None:
    """The tripwire for a fund publishing another fund as a company.

    The Vanguard defect (60 Target Retirement share classes, 176,514 bp of fund positions
    filed ``assetCat=EC``/``issuerCat=CORP``) was invisible to every arithmetic gate: the
    rows were equities, the LEIs resolved, and the coverage was 99.5%. What it was not
    invisible to is the release's own name list. This is not a classifier and does not try
    to be one — exact case-folded name equality against funds this release publishes,
    material rows only, which is narrow enough to be free of false positives and wide
    enough to catch the next filer who declares a fund to be a stock.

    It warns rather than fails below ``MAX_FUND_NAME_ROW_FUNDS`` because the identity model
    (ADR-0016 §1) keys on the row's LEI, and a filer who omits the LEI leaves nothing to
    match on: on release ``2026-11-02.3`` four funds do exactly that — DRAFX, RISE, NCBGX
    and NCBIX publish a fund they hold as an equity, with an ISIN and no LEI. Those rows are
    a real, bounded defect; refusing the whole release over four filers' omissions would
    trade a visible error for an invisible one, and the ceiling still refuses the systematic
    case the gate was built for. Derivatives are excluded: an option on IVV is a contract,
    not a share of IVV, so naming an ETF there is correct classification.
    """
    by_name = {str(fund.get("name") or "").casefold() for fund in funds}
    by_name.discard("")
    if not by_name:
        return
    caught: dict[str, int] = {}
    for document in funds:
        for row in document.get("holdings") or []:
            if row.get("asset_cat") in ("fund", "derivative"):
                continue
            if abs(row.get("weight_bp") or 0) < FUND_NAME_ROW_BP:
                continue
            if str(row.get("name") or "").casefold() in by_name:
                caught[document.get("ticker")] = caught.get(document.get("ticker"), 0) + 1
                if len(caught) <= MAX_FUND_NAME_ROW_FUNDS:
                    report.warn(
                        f"{document.get('ticker')}.fund_row",
                        f"{row['name']!r} at {row['weight_bp']} bp is a published fund "
                        f"but is filed as {row.get('asset_cat')}",
                    )
    if len(caught) > MAX_FUND_NAME_ROW_FUNDS:
        report.fail(
            "fund_rows",
            f"{len(caught)} funds publish a fund-named row that is not classified as a fund "
            f"(ceiling {MAX_FUND_NAME_ROW_FUNDS}) — the identity model is not reaching them",
        )


def _check_benchmarks(release_dir: Path, funds: list[dict], report: Report) -> None:
    """The compact benchmark is derived, so the release has to prove the derivation.

    A rollup nobody recomputes is a number with two sources of truth: the fund
    document would say one thing and the column another, and the column is the one
    a reader sees. Every weight is recomputed here from the fund document beside it
    with the same rule the builder used, and the object is rejected if the two
    disagree by a single basis point.
    """
    descriptor_path = release_dir / "release.json"
    if not descriptor_path.exists():
        report.fail("benchmarks", "release.json is missing, so no benchmark is described")
        return
    try:
        descriptor = json.loads(descriptor_path.read_text())
    except (OSError, ValueError) as error:
        report.fail("benchmarks", f"release.json is unreadable: {error}")
        return
    family = ((descriptor.get("objects") or {}).get("benchmarks") or {})
    advertised = {
        str(ticker).upper(): entry
        for ticker, entry in (family.get("files") or {}).items()
        if isinstance(entry, dict)
    }
    directory = release_dir / "benchmarks"
    on_disk = {path.stem.upper(): path for path in directory.glob("*.json")} if directory.is_dir() else {}
    fund_by_ticker = {str(fund.get("ticker", "")).upper(): fund for fund in funds}

    for ticker in sorted(set(advertised) - set(on_disk)):
        report.fail("benchmarks.present", f"{ticker} is described but benchmarks/{ticker}.json does not exist")
    for ticker in sorted(set(on_disk) - set(advertised)):
        report.fail(
            "benchmarks.described",
            f"benchmarks/{ticker}.json is published but release.json does not describe it",
        )

    for ticker in sorted(set(on_disk) & set(advertised)):
        label = f"benchmarks/{ticker}.json"
        path = on_disk[ticker]
        payload = path.read_bytes()
        entry = advertised[ticker]
        digest = hashlib.sha256(payload).hexdigest()
        if digest != entry.get("sha256") or len(payload) != entry.get("bytes"):
            report.fail("benchmarks.descriptor", f"{label} does not match its descriptor")
        if len(payload) > benchmarks_mod.MAX_BENCHMARK_BYTES:
            report.fail(
                "benchmarks.size",
                f"{label} is {len(payload):,} B, over the {benchmarks_mod.MAX_BENCHMARK_BYTES:,} B ceiling "
                "— the object exists to be smaller than the fund document it replaces",
            )
        source = fund_by_ticker.get(ticker)
        if source is None:
            report.fail("benchmarks.source", f"{label} has no fund document in this release")
            continue
        try:
            document = json.loads(payload)
        except ValueError:
            report.fail("benchmarks.schema", f"{label} is not valid JSON")
            continue
        if not isinstance(document, dict) or document.get("kind") != benchmarks_mod.KIND:
            report.fail("benchmarks.schema", f"{label} kind is {document.get('kind')!r}")
            continue
        if document.get("schema_version") != benchmarks_mod.SCHEMA_VERSION:
            report.fail("benchmarks.schema", f"{label} schema_version {document.get('schema_version')!r}")
        if str(document.get("ticker", "")).upper() != ticker:
            report.fail("benchmarks.ticker", f"{label} names {document.get('ticker')!r}")
        for field in ("fund_id", "name", "as_of", "filed_at", "lag_days", "coverage_pct", "source_url"):
            if document.get(field) != source.get(field):
                report.fail(
                    "benchmarks.provenance",
                    f"{label} {field} {document.get(field)!r} != fund document {source.get(field)!r} "
                    "— the provenance belongs to the filing and is copied, never recomputed",
                )
        weights = document.get("weights")
        if not isinstance(weights, dict) or not weights:
            report.fail("benchmarks.weights", f"{label} has no weights")
            continue
        if any(not isinstance(value, int) or value == 0 for value in weights.values()):
            report.fail(
                "benchmarks.weights",
                f"{label} carries a zero or non-integer weight; zero rows are dropped, never stored",
            )
        if any(value < 0 for value in weights.values()):
            report.warn("benchmarks.weights", f"{label} carries a negative weight (a short in the benchmark)")
        expected = benchmarks_mod.rollup(source)
        if weights != expected:
            missing = sorted(set(expected) - set(weights))[:3]
            extra = sorted(set(weights) - set(expected))[:3]
            differing = sorted(
                company_id
                for company_id in set(expected) & set(weights)
                if expected[company_id] != weights[company_id]
            )[:3]
            report.fail(
                "benchmarks.rollup",
                f"{label} disagrees with the fund document: missing {missing}, extra {extra}, "
                f"differing {[(c, weights[c], expected[c]) for c in differing]}",
            )
            continue
        source_bytes = len((release_dir / f"funds/{source.get('ticker')}.json").read_bytes())
        if source_bytes and len(payload) * 2 >= source_bytes:
            report.warn(
                "benchmarks.size",
                f"{label} is {len(payload):,} B against the fund document's {source_bytes:,} B "
                "— the saving it exists for is gone",
            )
        report.ok("benchmarks.rollup", f"{label} matches the fund document ({len(weights):,} companies)")


def _check_company_countries(release_dir: Path, report: Report) -> None:
    """The country map is an inference, so the release has to show its work.

    Two things are checked, and both are real failures rather than warnings:

    1. **The map is a projection of the company shards.** Every company's shard
       carries its own ``country``, and ``companies/countries.json`` is the same
       decision pre-rolled for the ledger. The two are written from one dict at build
       time, so a disagreement means a second writer exists — which is exactly how a
       column and its source start telling different stories.
    2. **Both halves are present or absent together.** A release whose shards carry
       countries but whose object is missing would publish a fact no page can show; a
       release with an object and no shard country would show a tag no company record
       backs. Either is a release-level mistake, not a consumer's problem to paper over.

    ``counts`` is recomputed from the two sources rather than trusted, because it is
    the number a reader quotes when they ask how much of the release is placed.
    """
    descriptor_path = release_dir / "release.json"
    if not descriptor_path.exists():
        report.fail("countries", "release.json is missing, so no country map is described")
        return
    try:
        descriptor = json.loads(descriptor_path.read_text())
    except (OSError, ValueError) as error:
        report.fail("countries", f"release.json is unreadable: {error}")
        return
    entry = ((descriptor.get("objects") or {}).get("companies") or {}).get("countries")
    path = release_dir / "companies" / "countries.json"
    published = path.exists()

    decided: dict[str, str] = {}
    #: Every company the release publishes a shard for, decided or not. The contested
    #: map is checked against this, not against `decided`: a contested company is by
    #: definition one the vote did not decide, so it has a shard and no country.
    shard_ids: set[str] = set()
    shards = 0
    for shard_path in sorted((release_dir / "companies").glob("*.json")):
        # Only a company shard is a shard. The directory also carries browser objects
        # — ``index.json``, ``countries.json``, and the size table ``sizes.json`` — and
        # counting one of those as a company failed the 2026-11-07 refresh by exactly
        # one company. The id shape is the filter, so a future object cannot do it again.
        if not COMPANY_ID_RE.match(shard_path.stem):
            continue
        try:
            shard = json.loads(shard_path.read_text())
        except (OSError, ValueError):
            report.fail("countries.shard", f"{shard_path.name} is unreadable")
            continue
        shards += 1
        shard_ids.add(shard.get("company_id") or shard_path.stem)
        country = shard.get("country")
        if country is None:
            continue
        company_id = shard.get("company_id") or shard_path.stem
        if not company_countries_mod.is_country_code(country):
            report.fail(
                "countries.shard",
                f"{shard_path.name} carries country {country!r}, which is not ISO alpha-2",
            )
            continue
        decided[company_id] = country

    if not published:
        if entry is not None:
            report.fail("countries.present", "release.json describes companies/countries.json, which does not exist")
        if decided:
            report.fail(
                "countries.described",
                f"{len(decided):,} company shard(s) carry a country but the release publishes no "
                "companies/countries.json — the ledger cannot read a fact the shards carry",
            )
        else:
            report.ok("companies.countries", "no country map published (a valid release)")
        return
    if entry is None:
        report.fail("countries.described", "companies/countries.json is published but release.json does not describe it")
        return

    payload = path.read_bytes()
    if hashlib.sha256(payload).hexdigest() != (entry or {}).get("sha256") or len(payload) != (entry or {}).get("bytes"):
        report.fail("countries.descriptor", "companies/countries.json does not match its descriptor")
    if len(payload) > company_countries_mod.MAX_COUNTRIES_BYTES:
        report.fail(
            "countries.size",
            f"companies/countries.json is {len(payload):,} B, over the "
            f"{company_countries_mod.MAX_COUNTRIES_BYTES:,} B ceiling",
        )
    try:
        document = json.loads(payload)
    except ValueError:
        report.fail("countries.schema", "companies/countries.json is not valid JSON")
        return
    if not isinstance(document, dict) or document.get("kind") != company_countries_mod.KIND:
        report.fail("countries.schema", f"kind is {document.get('kind')!r}, expected {company_countries_mod.KIND!r}")
        return
    if document.get("schema_version") != company_countries_mod.SCHEMA_VERSION:
        report.fail("countries.schema", f"schema_version {document.get('schema_version')!r}")
    if document.get("as_of") != (descriptor.get("as_of") or document.get("as_of")):
        report.fail("countries.as_of", f"{document.get('as_of')!r} != release as_of {descriptor.get('as_of')!r}")

    published_map = document.get("companies")
    if not isinstance(published_map, dict):
        report.fail("countries.map", "companies is not an object")
        return
    for company_id, country in published_map.items():
        if not company_countries_mod.is_country_code(country):
            report.fail("countries.map", f"{company_id} carries {country!r}, which is not ISO alpha-2")
    if published_map != decided:
        missing = sorted(set(decided) - set(published_map))[:3]
        extra = sorted(set(published_map) - set(decided))[:3]
        differing = sorted(
            company_id
            for company_id in set(published_map) & set(decided)
            if published_map[company_id] != decided[company_id]
        )[:3]
        report.fail(
            "countries.projection",
            f"companies/countries.json is not the projection of the company shards: "
            f"missing {missing}, extra {extra}, differing {[(c, published_map[c], decided[c]) for c in differing]}",
        )
        return

    counts = document.get("counts") or {}
    us = sum(1 for code in published_map.values() if code == "US")
    expected = {
        "companies": shards,
        "with_country": len(published_map),
        "us": us,
        "non_us": len(published_map) - us,
        "undecided": shards - len(published_map),
    }
    for name, value in expected.items():
        if counts.get(name) != value:
            report.fail("countries.counts", f"counts.{name} {counts.get(name)!r} != recomputed {value:,}")
    if not isinstance(counts.get("invalid_rows"), int) or counts.get("invalid_rows", -1) < 0:
        report.fail("countries.counts", f"counts.invalid_rows {counts.get('invalid_rows')!r} is not a count")

    # The fallback's provenance, when the release ran one. Absent is valid (an older
    # or control build); present must add up, because `sources` is the number a
    # reader quotes when they ask how much of the map is a registry record rather
    # than an inference over holders.
    sources = document.get("sources")
    if sources is not None:
        unknown = sorted(set(sources) - {"nport", "gleif", "edgar", "cover_page", "override"})
        if unknown:
            report.fail("countries.sources", f"unknown source(s) {unknown[:3]}")
        elif any(not isinstance(value, int) or value < 0 for value in sources.values()):
            report.fail("countries.sources", f"sources {sources!r} are not counts")
        elif sum(sources.values()) != len(published_map):
            report.fail(
                "countries.sources",
                f"sources sum to {sum(sources.values()):,} but the map has "
                f"{len(published_map):,} companies",
            )
        if not isinstance(document.get("fallback_rule"), str) or not document.get("fallback_rule"):
            report.fail("countries.sources", "sources are published without a fallback_rule")
        agreement = document.get("agreement") or {}
        for name in ("gleif_bp", "edgar_bp", "cover_page_bp"):
            rate = agreement.get(name)
            if not isinstance(rate, int) or not 0 <= rate <= 10_000:
                report.fail("countries.agreement", f"agreement.{name} {rate!r} is not basis points")
        for name in ("gleif_compared", "edgar_compared", "cover_page_compared"):
            if not isinstance(agreement.get(name), int) or agreement.get(name, -1) < 0:
                report.fail("countries.agreement", f"agreement.{name} {agreement.get(name)!r} is not a count")

    # The override table is the one step in the cascade that is not derived from a
    # filing, so the release has to show that it was applied and that it was applied
    # *exactly*: every row the table names must carry the table's country, and the
    # published counts must recompute from the table and the map. A row naming a
    # company this release does not publish is a warning, not a failure — a release
    # built from a narrower universe is still a valid release, and the row is a guard
    # for the next one.
    overrides_document = document.get("overrides")
    if overrides_document is not None:
        table = company_countries_mod.load_overrides()
        if not table:
            report.fail(
                "countries.overrides",
                "overrides are published but the table on disk is empty",
            )
        else:
            stale = sorted(set(table) - shard_ids)
            if stale:
                report.warn(
                    "countries.overrides",
                    f"{len(stale)} override row(s) name a company this release does not "
                    f"publish: {stale[:3]}",
                )
            matched = [company_id for company_id in table if company_id in shard_ids]
            wrong = [
                company_id
                for company_id in matched
                if published_map.get(company_id) != table[company_id]["iso2"]
            ]
            if wrong:
                report.fail(
                    "countries.overrides",
                    f"{len(wrong)} overridden company(ies) do not carry the table's "
                    f"country: {[(c, published_map.get(c), table[c]['iso2']) for c in wrong[:3]]}",
                )
            # The release cannot say which rows the vote already agreed with — the
            # published map equals the table for every matched row either way — so the
            # object publishes the count and the check is that the three counts account
            # for every row in the table. A row that is neither applied, redundant nor
            # unmatched is a row the build dropped, which is the failure this catches.
            applied = overrides_document.get("applied")
            redundant = overrides_document.get("redundant")
            if not isinstance(applied, int) or not isinstance(redundant, int):
                report.fail("countries.overrides", "applied and redundant must be counts")
            elif applied + redundant != len(matched):
                report.fail(
                    "countries.overrides",
                    f"applied {applied:,} + redundant {redundant:,} != "
                    f"{len(matched):,} matched row(s)",
                )
            elif applied + redundant + len(stale) != len(table):
                report.fail(
                    "countries.overrides",
                    f"applied + redundant + unmatched != the {len(table):,} row(s) in the table",
                )
            if overrides_document.get("unmatched") != len(stale):
                report.fail(
                    "countries.overrides",
                    f"overrides.unmatched {overrides_document.get('unmatched')!r} != "
                    f"recomputed {len(stale):,}",
                )
            # Which rows were redundant is not recoverable from the release, so the
            # company list is checked for the two things that are: it is as long as
            # `applied`, and every id in it is a row the table matched.
            published_companies = overrides_document.get("companies")
            if not isinstance(published_companies, list):
                report.fail("countries.overrides", "overrides.companies is not a list")
            elif len(published_companies) != applied:
                report.fail(
                    "countries.overrides",
                    f"overrides.companies has {len(published_companies):,} id(s) but "
                    f"applied is {applied:,}",
                )
            elif not set(published_companies) <= set(matched):
                report.fail(
                    "countries.overrides",
                    "overrides.companies names a company the table does not match",
                )
            if not isinstance(document.get("override_rule"), str) or not document.get("override_rule"):
                report.fail("countries.overrides", "overrides are published without an override_rule")
            report.ok(
                "countries.overrides",
                f"{applied:,} applied, {redundant:,} redundant, {len(stale):,} unmatched "
                f"of {len(table):,} row(s); every matched company carries the table's country",
            )

    # The classification block names the convention the tiers are read under. It is
    # published so a consumer cannot apply one publisher's table to another's codes.
    classification = document.get("classification")
    if classification is not None:
        if classification.get("provider") not in classification_generated.PROVIDERS:
            report.fail(
                "countries.classification",
                f"classification.provider {classification.get('provider')!r} is not a known provider",
            )
        if not isinstance(classification.get("as_of"), str) or not classification.get("as_of"):
            report.fail("countries.classification", "classification.as_of is missing")

    # The contested map is a *second* answer to a different question, and the one thing
    # that must never happen is a consumer reading it as the company's country. So it
    # is checked for the two ways that could become true: a code that is not ISO, and a
    # company that already has a decided country (which would make the two maps
    # disagree about the same company).
    contested_map = document.get("contested")
    if contested_map is not None:
        if not isinstance(contested_map, dict):
            report.fail("countries.contested", "contested is not an object")
        else:
            for company_id, country in contested_map.items():
                if not company_countries_mod.is_country_code(country):
                    report.fail(
                        "countries.contested",
                        f"{company_id} carries {country!r}, which is not ISO alpha-2",
                    )
                    break
            overlap = sorted(set(contested_map) & set(published_map))[:3]
            if overlap:
                report.fail(
                    "countries.contested",
                    f"contested names {overlap}, which the map already decided — the two "
                    "answers must be disjoint or a reader cannot tell which is which",
                )
            unknown = sorted(set(contested_map) - shard_ids)[:3]
            if unknown:
                report.fail(
                    "countries.contested",
                    f"contested names {unknown}, which the release publishes no company shard for",
                )
            if not isinstance(document.get("contested_rule"), str) or not document.get("contested_rule"):
                report.fail("countries.contested", "contested is published without a contested_rule")
    if not report.failures:
        report.ok(
            "companies.countries",
            f"{len(published_map):,} of {shards:,} companies placed ({us:,} US), "
            f"{counts.get('invalid_rows', 0):,} unusable row(s) discarded at build time",
        )


def _published_files(release_dir: Path, manifest: dict) -> list[Path]:
    """The objects this release actually publishes, plus the manifest itself.

    ``build-summary.json`` sits beside them as build telemetry: it is not listed in
    ``manifest.files``, is not hashed, and is not uploaded, so scanning it for
    licensed identifiers reports on text no consumer can ever fetch — and did, with
    a holdings total formatted as ``456,871,994`` read as a CUSIP-shaped token.
    """
    listed = [release_dir / entry["path"] for entry in manifest.get("files") or []]
    listed.append(release_dir / "manifest.json")
    # The catalogue objects carry company and fund names too, and they are
    # published — so they are scanned. ``index/`` is not: it holds tickers and
    # 64-character hashes, where the CUSIP pattern cannot match.
    for relative in ("catalogue.json", "tickers.json", "companies/index.json"):
        listed.append(release_dir / relative)
    listed.extend(sorted((release_dir / "companies").glob("*.json")))
    found = [path for path in listed if path.is_file()]
    return found or sorted(release_dir.rglob("*.json"))


def _strings(node: Any):
    """Every string in a parsed document, values and keys alike."""
    if isinstance(node, dict):
        for key, value in node.items():
            yield str(key)
            yield from _strings(value)
    elif isinstance(node, list):
        for value in node:
            yield from _strings(value)
    elif isinstance(node, str):
        yield node


def _check_sizes(release_dir: Path, report: Report) -> None:
    """``companies/sizes.json``: the market-cap table, when the release published one.

    The object is additive — a release built with ``--no-size-buckets`` simply has no
    file and is valid — so everything here fires only when it is present, and each
    refusal is a promise the fund page makes to a reader (ADR-0022):

    - **a cap is never published without its two dates.** ``usd`` is a price at the
      report date multiplied by a share count at ``share_date``; a bare number reads
      as a live quote, and the methodology page says every cap carries both.
    - **a band is one of the published bands**, because the page prints the band's
      name and the table's line, and an unknown key would render nothing.
    - **the thresholds are the pipeline's own**, so a page that recomputes a band
      from the payload cannot disagree with the build that wrote it.
    - **the counts add up**: ``placed`` equals the caps, and the two lane counts
      (``frame``, ``cover``) sum to it, so the log line and the artefact cannot drift.
    """
    path = release_dir / "companies" / "sizes.json"
    if not path.is_file():
        return
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except ValueError:
        report.fail("sizes.json", "companies/sizes.json is not valid JSON")
        return
    if not isinstance(payload, dict):
        report.fail("sizes.shape", "companies/sizes.json is not an object")
        return
    if payload.get("schema_version") != 1:
        report.fail("sizes.schema", "companies/sizes.json is not schema_version 1")
    if payload.get("kind") != "sizes":
        report.fail("sizes.kind", f"companies/sizes.json kind is {payload.get('kind')!r}")
    thresholds = payload.get("thresholds")
    if not isinstance(thresholds, dict) or thresholds != {
        "megacap": 200_000_000_000.0,
        "largecap": 10_000_000_000.0,
        "midcap": 2_000_000_000.0,
        "smallcap": 300_000_000.0,
        "microcap": 0.0,
    }:
        report.fail(
            "sizes.thresholds",
            "companies/sizes.json thresholds are not the published lines "
            f"({thresholds!r})",
        )
    if payload.get("bands") != list(sizes.BAND_ORDER):
        report.fail(
            "sizes.bands",
            f"companies/sizes.json bands are {payload.get('bands')!r}, "
            f"not {list(sizes.BAND_ORDER)!r}",
        )
    caps = payload.get("caps")
    if not isinstance(caps, dict):
        report.fail("sizes.caps", "companies/sizes.json has no caps object")
        return
    allowed = set(sizes.BAND_ORDER)
    for company_id, cap in caps.items():
        if not COMPANY_ID_RE.match(str(company_id)):
            report.fail(
                "sizes.company_id",
                f"companies/sizes.json key {company_id!r} is not a company id",
            )
            break
        if not isinstance(cap, dict):
            report.fail("sizes.cap", f"companies/sizes.json {company_id} is not an object")
            break
        missing = [
            key
            for key in ("usd", "shares", "price", "share_date", "report_date", "basis", "band")
            if key not in cap
        ]
        if missing:
            report.fail(
                "sizes.fields",
                f"companies/sizes.json {company_id} is missing {', '.join(missing)}",
            )
            break
        if cap["band"] not in allowed:
            report.fail("sizes.band", f"companies/sizes.json {company_id} has band {cap['band']!r}")
            break
        if not _DAY_RE.match(str(cap["share_date"])) or not _DAY_RE.match(str(cap["report_date"])):
            report.fail(
                "sizes.dates",
                f"companies/sizes.json {company_id} dates are "
                f"{cap['share_date']!r} / {cap['report_date']!r}",
            )
            break
        if cap["basis"] not in ("frame", "cover"):
            report.fail("sizes.basis", f"companies/sizes.json {company_id} basis is {cap['basis']!r}")
            break
    counts = payload.get("counts") or {}
    if isinstance(counts, dict):
        if counts.get("placed") != len(caps):
            report.fail(
                "sizes.counts",
                f"companies/sizes.json says {counts.get('placed')!r} placed but carries {len(caps)} caps",
            )
        lanes = (counts.get("frame") or 0) + (counts.get("cover") or 0)
        if lanes != len(caps):
            report.fail(
                "sizes.counts",
                f"companies/sizes.json lanes sum to {lanes} but {len(caps)} caps are published",
            )
    band_counts = payload.get("band_counts") or {}
    if isinstance(band_counts, dict) and sum(band_counts.values()) != len(caps):
        report.fail(
            "sizes.band_counts",
            f"companies/sizes.json band_counts sum to {sum(band_counts.values())}, not {len(caps)}",
        )


def _check_cusip(release_dir: Path, manifest: dict, report: Report) -> None:
    """No CUSIP, ISIN or other licensed identifier may leave the pipeline.

    Searches *string values*, not the file's bytes: ``effective_n: 100000000.0`` is a
    number, and a byte scan read it as a CUSIP on two funds whose covered weight is
    one basis point. A licensed identifier in a published artifact is a string.
    """
    offenders = []
    for path in _published_files(release_dir, manifest):
        document = json.loads(path.read_text())
        kept = {"cusip", "isin", "CUSIP", "ISIN"}
        for value in _strings(document):
            if value in kept:
                offenders.append(f"{path.name}: licensed identifier key")
                break
        for value in _strings(document):
            if is_licensed(value):
                offenders.append(f"{path.name}: CUSIP-shaped token {value!r}")
                break
    if offenders:
        report.fail("cusip", "; ".join(offenders))
    else:
        report.ok("cusip", "no CUSIP/ISIN keys or CUSIP-shaped tokens")


def _check_lei(release_dir: Path, manifest: dict, report: Report) -> None:
    """No LEI may leave the pipeline either, and every ``company_id`` must be shaped.

    An LEI is CC0, so the licence is not the reason — the reason is the same one that
    keeps CUSIPs out: a published artifact names a company, it does not hand out an
    identifier a reader can use to re-derive one. The namespace exists so the LEI can
    be the *internal* key; ``l_`` is a hash of it, and the hash is what ships.

    LEIs are 20 alphanumeric characters with a check-digit tail, so they are invisible
    to ``LICENSED_ID_RE`` (9 or 12 characters) and need their own scan. The same pass
    checks the shape of every id: an id in neither namespace means something upstream
    invented one.
    """
    offenders: list[str] = []
    bad_ids: list[str] = []
    for path in _published_files(release_dir, manifest):
        document = json.loads(path.read_text())
        for value in _strings(document):
            if len(value) == 20 and LEI_RE.match(value.strip()):
                offenders.append(f"{path.name}: LEI-shaped token")
                break
        for value in _strings(document):
            if is_sec_company_id(value) or is_issuer_id(value):
                continue
            if value.startswith(("c_", "l_")) and len(value) > 2:
                bad_ids.append(f"{path.name}: malformed company id {value!r}")
                break
    if offenders:
        report.fail("lei", "; ".join(offenders))
    else:
        report.ok("lei", "no LEI-shaped token in any published string")
    if bad_ids:
        report.fail("company_id", "; ".join(bad_ids))
    else:
        report.ok("company_id", "every c_/l_ id matches its namespace's shape")


def _check_budget(release_dir: Path, report: Report) -> None:
    funds = list((release_dir / "funds").glob("*.json"))
    total = sum(path.stat().st_size for path in release_dir.rglob("*") if path.is_file())
    sizes = [(path.stat().st_size, path) for path in funds]
    largest, largest_path = max(sizes, default=(0, None))
    if largest > MAX_FUND_BYTES:
        report.fail("budget.per_fund", f"largest fund is {largest:,} bytes")
        return
    large = sum(1 for size, _ in sizes if size > LARGE_FUND_BYTES)
    gzipped = len(gzip.compress(largest_path.read_bytes())) if largest_path else 0
    report.ok(
        "budget",
        f"{len(funds)} funds, largest {largest:,} B ({gzipped:,} B gzipped), "
        f"{large} over {LARGE_FUND_BYTES:,} B, release {total:,} B",
    )


# -- the objects a browser reads -------------------------------------------
#: `release.json` is the document the pointer publishes; its shape is versioned
#: separately from the fund documents it describes.
RELEASE_SCHEMA_VERSION = 2


def _check_catalogue(release_dir: Path, manifest: dict, funds: list[dict], report: Report) -> None:
    """The pointer, the catalogue, and the reverse index must describe this release.

    These are the objects a browser fetches, and each one is a place a release can
    disagree with itself: a ticker list that omits a fund, a hash shard that names a
    fund the release does not publish, a company shard that credits a holding to the
    wrong fund, a catalogue size that disagrees with the fund document it was derived
    from. The funds are the source of truth; every other object is checked against
    them.
    """
    tickers = sorted(fund.get("ticker", "") for fund in funds if fund.get("ticker"))
    by_ticker = {fund["ticker"]: fund for fund in funds if fund.get("ticker")}

    release_path = release_dir / "release.json"
    if not release_path.is_file():
        report.fail("release.json", "missing — the pointer publishes this object")
        return
    descriptor = json.loads(release_path.read_text())
    if descriptor.get("schema_version") != RELEASE_SCHEMA_VERSION:
        report.fail("release.schema_version", str(descriptor.get("schema_version")))
    if descriptor.get("kind") != "release":
        report.fail("release.kind", repr(descriptor.get("kind")))
    if descriptor.get("as_of") != manifest.get("as_of"):
        report.fail("release.as_of", f"{descriptor.get('as_of')!r} != {manifest.get('as_of')!r}")
    for field in ("fund_count", "company_count", "etf_count", "coverage_histogram", "mapping_rungs"):
        if descriptor.get(field) != manifest.get(field):
            report.fail(f"release.{field}", "disagrees with the manifest")

    objects = descriptor.get("objects") or {}
    for name, entry in objects.items():
        if not isinstance(entry, dict) or "path" not in entry:
            continue
        path = release_dir / entry["path"]
        if not path.is_file():
            report.fail(f"release.objects.{name}", f"{entry['path']} is missing")
            continue
        payload = path.read_bytes()
        if len(payload) != entry.get("bytes"):
            report.fail(f"release.objects.{name}", f"{entry['path']}: {len(payload)} != {entry.get('bytes')}")
        digest = hashlib.sha256(payload).hexdigest()
        if digest != entry.get("sha256"):
            report.fail(f"release.objects.{name}", f"{entry['path']}: sha256 mismatch")

    # tickers.json: exactly the published set, sorted, from this release.
    tickers_path = release_dir / "tickers.json"
    if not tickers_path.is_file():
        report.fail("tickers", "tickers.json is missing")
    else:
        document = json.loads(tickers_path.read_text())
        if document.get("as_of") != manifest.get("as_of"):
            report.fail("tickers.as_of", repr(document.get("as_of")))
        published = document.get("tickers") or []
        if published != tickers:
            missing = sorted(set(tickers) - set(published))[:5]
            extra = sorted(set(published) - set(tickers))[:5]
            report.fail(
                "tickers",
                f"{len(published)} tickers != {len(tickers)} funds (missing {missing}, extra {extra})",
            )
        elif published != sorted(published):
            report.fail("tickers.order", "ticker list is not sorted")

    # catalogue.json: a label for every fund, and no fund it does not publish.
    catalogue_path = release_dir / "catalogue.json"
    if not catalogue_path.is_file():
        report.fail("catalogue", "catalogue.json is missing")
    else:
        document = json.loads(catalogue_path.read_text())
        if document.get("as_of") != manifest.get("as_of"):
            report.fail("catalogue.as_of", repr(document.get("as_of")))
        entries = document.get("funds") or {}
        if set(entries) != set(tickers):
            report.fail("catalogue.funds", f"{len(entries)} entries != {len(tickers)} funds")
        if not document.get("etf_classifier"):
            report.fail("catalogue.etf_classifier", "absent — the flag is a test, not a fact")
        for ticker, entry in entries.items():
            # Four elements is a release built before the size figure existed and
            # stays valid (additive contract); five is the current shape. Anything
            # else is a row a reader would index wrongly, and the app reads position.
            if not isinstance(entry, list) or len(entry) not in (4, 5):
                report.fail(
                    "catalogue.entry",
                    f"{ticker}: expected [name, issuer, etf, coverage_pct, net_assets]",
                )
                break
            if entry[0] != by_ticker.get(ticker, {}).get("name"):
                report.fail("catalogue.name", f"{ticker}: {entry[0]!r} != the fund's own name")
                break
            # The flag this release publishes has to be the fund's own label. It
            # was all zeros once, because the writer read a field the document did
            # not have, and a catalogue saying "no ETFs" is worse than no catalogue.
            expected = 1 if by_ticker.get(ticker, {}).get("etf") else 0
            if entry[2] != expected:
                report.fail(
                    "catalogue.etf",
                    f"{ticker}: catalogue says {entry[2]}, the fund says {expected}",
                )
                break
            if len(entry) == 5:
                # The size in the directory must be the size on the fund's page —
                # a projection gate, the same rule the company→country map answers
                # to. The catalogue is derived from the documents in the same build,
                # so a disagreement here means one of the two writers is reading a
                # different number, and the list would order funds by a figure no
                # fund document states.
                own = by_ticker.get(ticker, {}).get("net_assets")
                if entry[4] != own:
                    report.fail(
                        "catalogue.net_assets",
                        f"{ticker}: catalogue says {entry[4]!r}, the fund says {own!r}",
                    )
                    break

    # index/{L}.json: one entry per fund, hashing the bytes on disk.
    index_dir = release_dir / "index"
    index: dict[str, dict] = {}
    if not index_dir.is_dir():
        report.fail("index", "index/ is missing")
    else:
        for path in sorted(index_dir.glob("*.json")):
            document = json.loads(path.read_text())
            if document.get("as_of") != manifest.get("as_of"):
                report.fail("index.as_of", f"{path.name}: {document.get('as_of')!r}")
            for ticker, entry in (document.get("funds") or {}).items():
                if ticker in index:
                    report.fail("index.duplicate", f"{ticker} appears in two shards")
                index[ticker] = entry
        if set(index) != set(tickers):
            report.fail("index.funds", f"{len(index)} shard entries != {len(tickers)} funds")
        mismatched = [
            ticker
            for ticker, entry in index.items()
            if entry.get("bytes") != (release_dir / "funds" / f"{ticker}.json").stat().st_size
        ]
        if mismatched:
            report.fail("index.bytes", f"{len(mismatched)} fund(s) disagree, e.g. {mismatched[:3]}")
        if not report.failures:
            report.ok("index", f"{len(index)} funds across {len(list(index_dir.glob('*.json')))} shard(s)")

    _check_reverse_index(release_dir, manifest, by_ticker, report)
    _check_aliases(release_dir, manifest, tickers, report)
    _check_securities(release_dir, manifest, tickers, report)


def _check_aliases(
    release_dir: Path, manifest: dict, tickers: list[str], report: Report
) -> None:
    """``aliases.json``: every class ticker points at a page this release has.

    The failure this prevents is a dead end that looks like a feature: an alias to an
    unpublished ticker sends a visitor from "VFIAX" to a 404 with no explanation, and
    an alias that shadows a published ticker silently renames somebody's fund. Both
    are invisible in a spot check and obvious in a diff.
    """
    path = release_dir / "aliases.json"
    if not path.is_file():
        report.fail("aliases", "aliases.json is missing")
        return
    document = json.loads(path.read_text())
    if document.get("as_of") != manifest.get("as_of"):
        report.fail("aliases.as_of", repr(document.get("as_of")))
    targets = document.get("targets") or {}
    published = set(tickers)
    dangling = sorted(alias for alias, target in targets.items() if target not in published)
    if dangling:
        report.fail(
            "aliases.target",
            f"{len(dangling)} alias(es) point at unpublished tickers, e.g. "
            f"{[(alias, targets[alias]) for alias in dangling[:3]]}",
        )
    shadowing = sorted(alias for alias in targets if alias in published)
    if shadowing:
        report.fail(
            "aliases.shadow",
            f"{len(shadowing)} alias(es) collide with a published ticker, e.g. {shadowing[:3]}",
        )
    self_ref = sorted(alias for alias, target in targets.items() if alias == target)
    if self_ref:
        report.fail("aliases.self", f"{len(self_ref)} alias(es) point at themselves, e.g. {self_ref[:3]}")
    bad = sorted(alias for alias in targets if not TICKER_RE.match(alias))
    if bad:
        report.fail("aliases.shape", f"{len(bad)} alias(es) are not tickers, e.g. {bad[:3]}")
    if not report.failures:
        report.ok("aliases", f"{len(targets):,} share-class ticker(s) resolve to a published fund")


def _check_securities(
    release_dir: Path, manifest: dict, tickers: list[str], report: Report
) -> None:
    """``securities/{L}.json``: the typed-symbol object is complete and well-formed.

    Optional — a release built before ADR-0014 has no such object and stays valid,
    which is what keeps the pointer move atomic across a code deploy. When it *is*
    present, the checks are the ones a wrong entry would break: a symbol that does
    not survive the fragment regex cannot be typed back, a value that is not
    ``[company_id, name, exchange, status]`` makes the client read ``undefined``,
    and a symbol published twice means the shard order decides identity.
    """
    descriptor_path = release_dir / "release.json"
    if not descriptor_path.is_file():
        report.fail("release.json", "release.json is missing")
        return
    declared = (json.loads(descriptor_path.read_text()).get("objects") or {}).get("securities")
    directory = release_dir / "securities"
    if not directory.is_dir():
        if declared:
            report.fail("securities", "release.json describes a securities object but securities/ is missing")
        return
    if not declared:
        report.fail("securities", "securities/ exists but release.json does not describe it")
        return

    published = set(tickers)
    seen: dict[str, str] = {}
    duplicates: list[str] = []
    bad_shape: list[str] = []
    bad_id: list[str] = []
    bad_status: list[str] = []
    unknown_status: list[str] = []
    refused_funds: list[str] = []
    for path in sorted(directory.glob("*.json")):
        document = json.loads(path.read_text())
        if document.get("as_of") != manifest.get("as_of"):
            report.fail("securities.as_of", f"{path.name}: {document.get('as_of')!r}")
        for symbol, value in (document.get("securities") or {}).items():
            if symbol in seen:
                duplicates.append(symbol)
            seen[symbol] = path.stem
            if not TICKER_RE.match(symbol):
                bad_shape.append(symbol)
            if not isinstance(value, list) or len(value) != 4:
                bad_shape.append(symbol)
                continue
            company, _name, _exchange, status = value
            if not COMPANY_ID_RE.match(str(company)):
                bad_id.append(symbol)
            if status not in _SECURITY_STATUSES:
                unknown_status.append(f"{symbol}:{status}")
            if status == "fund" and symbol not in published:
                refused_funds.append(symbol)
    if duplicates:
        report.fail("securities.duplicate", f"{len(duplicates)} symbol(s) in two shards, e.g. {duplicates[:3]}")
    if bad_shape:
        report.fail("securities.shape", f"{len(bad_shape)} malformed row(s), e.g. {bad_shape[:3]}")
    if bad_id:
        report.fail("securities.company", f"{len(bad_id)} bad company_id, e.g. {bad_id[:3]}")
    if unknown_status:
        report.fail("securities.status", f"{len(unknown_status)} unknown status, e.g. {unknown_status[:3]}")
    if refused_funds:
        # A symbol is only refused *as a fund* when the release publishes that fund;
        # otherwise the fund path would have accepted it and the label would lie.
        report.fail(
            "securities.fund",
            f"{len(refused_funds)} symbol(s) refused as a fund but not published, e.g. {refused_funds[:3]}",
        )
    if declared.get("count") != len(seen):
        report.fail("securities.count", f"descriptor says {declared.get('count')}, found {len(seen)}")
    declared_shards = declared.get("shards") or {}
    if sorted(declared_shards) != sorted(path.stem for path in directory.glob("*.json")):
        report.fail("securities.shards", "descriptor shard map disagrees with the files on disk")
    for shard, entry in declared_shards.items():
        path = directory / f"{shard}.json"
        if not path.is_file():
            continue
        body = path.read_bytes()
        if entry.get("bytes") != len(body) or entry.get("sha256") != hashlib.sha256(body).hexdigest():
            report.fail("securities.hash", f"{path.name} does not match the bytes the descriptor names")
    if not report.failures:
        report.ok(
            "securities",
            f"{len(seen):,} symbol(s) across {len(list(directory.glob('*.json')))} shard(s), "
            f"{len(published & set(seen)):,} refused as funds",
        )


def _check_reverse_index(
    release_dir: Path, manifest: dict, by_ticker: dict[str, dict], report: Report
) -> None:
    """Every company shard must be exactly the reverse of the fund documents.

    A reverse index is easy to get *almost* right — one holding dropped, one weight
    taken from the wrong fund — and the result looks plausible. So the check rebuilds
    it from the funds and compares, rather than spot-checking a few companies.
    """
    index_path = release_dir / "companies" / "index.json"
    if not index_path.is_file():
        report.fail("companies.index", "companies/index.json is missing")
        return
    document = json.loads(index_path.read_text())
    if document.get("as_of") != manifest.get("as_of"):
        report.fail("companies.as_of", repr(document.get("as_of")))
    rows = document.get("companies") or []
    # `company_count` in the manifest counts every distinct id in the release,
    # including ids that only ever appear at zero weight; the reverse index covers
    # the companies a browser can actually ask about, so the two differ by exactly
    # those. The index is checked against the holdings, not against the manifest.
    if len(rows) > int(manifest.get("company_count") or 0):
        report.fail("companies.count", f"{len(rows)} indexed > company_count {manifest.get('company_count')}")

    expected: dict[str, dict[str, int]] = {}
    # The published name is the one on the largest holding, so it does not depend on
    # the order funds happen to be read in; the check has to use the same rule.
    biggest: dict[str, tuple[int, str]] = {}
    for ticker, fund in by_ticker.items():
        for holding in fund.get("holdings") or []:
            company_id = holding.get("company_id")
            if not company_id or holding.get("weight_bp") == 0:
                continue
            expected.setdefault(company_id, {})[ticker] = (
                expected.setdefault(company_id, {}).get(ticker, 0) + holding["weight_bp"]
            )
            weight = holding["weight_bp"]
            current = biggest.get(company_id)
            if current is None or weight > current[0]:
                biggest[company_id] = (weight, holding.get("name", ""))
    names = {company_id: name for company_id, (_, name) in biggest.items()}

    shard_ids = {row[0] for row in rows if isinstance(row, list) and row}
    if shard_ids != set(expected):
        missing = sorted(set(expected) - shard_ids)[:3]
        extra = sorted(shard_ids - set(expected))[:3]
        report.fail(
            "companies.index.ids",
            f"{len(shard_ids)} indexed != {len(expected)} with non-zero weight "
            f"(missing {missing}, extra {extra})",
        )
    for row in rows:
        if not isinstance(row, list) or len(row) != 4:
            report.fail("companies.index.row", "expected [company_id, name, ticker, fund_count]")
            break
        company_id, name, _ticker, fund_count = row
        if company_id in expected and fund_count != len(expected[company_id]):
            report.fail("companies.index.fund_count", f"{company_id}: {fund_count} != {len(expected[company_id])}")
            break
        if company_id in names and name != names[company_id]:
            report.fail("companies.index.name", f"{company_id}: {name!r} != {names[company_id]!r}")
            break

    checked = 0
    for company_id, funds in expected.items():
        path = release_dir / "companies" / f"{company_id}.json"
        if not path.is_file():
            report.fail("companies.shard", f"{company_id} is indexed but has no shard")
            continue
        shard = json.loads(path.read_text())
        if shard.get("company_id") != company_id or shard.get("as_of") != manifest.get("as_of"):
            report.fail("companies.shard", f"{path.name}: identity or as_of disagrees")
            continue
        published = {
            ticker: weight
            for ticker, weight in shard.get("funds") or []
            if isinstance(ticker, str) and isinstance(weight, int)
        }
        if published != funds:
            missing = sorted(set(funds) - set(published))[:3]
            extra = sorted(set(published) - set(funds))[:3]
            wrong = sorted(
                ticker for ticker in set(funds) & set(published) if funds[ticker] != published[ticker]
            )[:3]
            report.fail(
                "companies.shard.weights",
                f"{company_id}: missing {missing}, extra {extra}, wrong {wrong}",
            )
            continue
        if len(published) != len(shard.get("funds") or []):
            report.fail("companies.shard", f"{path.name}: duplicate ticker in funds[]")
            continue
        checked += 1
    if not report.failures:
        report.ok("companies", f"{checked} shard(s) are the exact reverse of the funds")


def validate(release_dir: Path) -> int:
    report = Report()
    print(f"validating {release_dir}")
    loaded = _load_release(release_dir, report)
    if loaded is None:
        print(f"\n{report.failures} failure(s)")
        return 1
    manifest, funds = loaded
    _check_manifest(manifest, funds, report, release_dir)
    for document in funds:
        _check_fund(document, report)
    _check_fund_of_funds_release(funds, report)
    _check_identified_release(manifest, funds, report)
    _check_catalogue(release_dir, manifest, funds, report)
    _check_benchmarks(release_dir, funds, report)
    _check_company_countries(release_dir, report)
    _check_sizes(release_dir, report)
    _check_cusip(release_dir, manifest, report)
    _check_lei(release_dir, manifest, report)
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
    release_dir = paths.release_dir(args.release)
    if release_dir is None or not release_dir.exists():
        print(f"FAIL: {args.release} does not exist")
        return 1
    return validate(release_dir)


if __name__ == "__main__":
    sys.exit(main())
