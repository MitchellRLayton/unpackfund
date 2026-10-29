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

from .identifiers import LICENSED_ID_RE, is_licensed

from . import paths
from .artifact import SCHEMA_VERSION

REPO_ROOT = paths.REPO_ROOT

#: A published fund ticker: upper-case, starts alphanumeric, short.
TICKER_RE = re.compile(r"^[A-Z0-9][A-Z0-9.\-]{0,9}$")

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


def _check_budget(release_dir: Path, report: Report) -> None:
    funds = list((release_dir / "funds").glob("*.json"))
    total = sum(path.stat().st_size for path in release_dir.rglob("*") if path.is_file())
    largest = max((path.stat().st_size for path in funds), default=0)
    if largest > 200_000:
        report.fail("budget.per_fund", f"largest fund is {largest:,} bytes")
    else:
        report.ok("budget", f"{len(funds)} funds, largest {largest:,} B, release {total:,} B")


# -- the objects a browser reads -------------------------------------------
#: `release.json` is the document the pointer publishes; its shape is versioned
#: separately from the fund documents it describes.
RELEASE_SCHEMA_VERSION = 2


def _check_catalogue(release_dir: Path, manifest: dict, funds: list[dict], report: Report) -> None:
    """The pointer, the catalogue, and the reverse index must describe this release.

    These are the objects a browser fetches, and each one is a place a release can
    disagree with itself: a ticker list that omits a fund, a hash shard that names a
    fund the release does not publish, a company shard that credits a holding to the
    wrong fund. The funds are the source of truth; every other object is checked
    against them.
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
            if not isinstance(entry, list) or len(entry) != 4:
                report.fail("catalogue.entry", f"{ticker}: expected [name, issuer, etf, coverage_pct]")
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
    _check_catalogue(release_dir, manifest, funds, report)
    _check_cusip(release_dir, manifest, report)
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
