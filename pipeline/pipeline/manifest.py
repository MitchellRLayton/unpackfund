"""The release manifest.

Consumers read ``latest/manifest.json`` and then a release path they got from it;
they never guess a path. Hashes here are what make "did the copy corrupt
anything" a question with an answer, and ``coverage_histogram`` is what lets the
UI state data quality without reading every fund.
"""

from __future__ import annotations

import math
import subprocess
from typing import Any

from .artifact import SCHEMA_VERSION, sha256_hex, utc_now_iso
from . import classify
from .classify import looks_like_etf

#: Re-exported for callers that historically imported it from here; the value
#: belongs to the module that implements the test.
ETF_CLASSIFIER = classify.ETF_CLASSIFIER

COVERAGE_BANDS: tuple[tuple[str, float, float], ...] = (
    ("under_60", 0.0, 60.0),
    ("60_to_70", 60.0, 70.0),
    ("70_to_90", 70.0, 90.0),
    ("90_to_99", 90.0, 99.0),
    ("99_plus", 99.0, math.inf),
)


def pipeline_git_sha() -> str:
    try:
        return subprocess.run(
            ["git", "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            check=True,
            timeout=10,
        ).stdout.strip()
    except (subprocess.SubprocessError, OSError):
        return "unknown"


def coverage_histogram(coverage_values: list[float]) -> dict[str, int]:
    # The last band is open-ended on purpose: a band table with a hole in it drops
    # rows silently, and a histogram that does not sum to ``fund_count`` is how 25
    # over-100 funds disappeared from a release before the validator noticed.
    histogram = {name: 0 for name, _low, _high in COVERAGE_BANDS}
    for value in coverage_values:
        for name, low, high in COVERAGE_BANDS:
            if low <= value < high:
                histogram[name] += 1
                break
    return histogram


def build_manifest(
    *,
    release_id: str,
    funds: list[dict[str, Any]],
    files: list[dict[str, Any]],
    rung_counts: dict[str, int],
    asset_cat_counts: dict[str, int],
    etf_count: int | None = None,
    identity_namespaces: dict[str, dict[str, Any]] | None = None,
    generated_at: str | None = None,
) -> dict[str, Any]:
    """Assemble the manifest for one release.

    Additive beyond ``data-contract-and-release`` §5: ``mapping_rungs`` and
    ``asset_cat_counts`` record how the release resolved, and ``etf_classifier``
    names the provisional ETF test in use. A consumer may ignore them; a reviewer
    cannot otherwise see that 90% of one fund's weight came from the weaker rung.
    """
    companies = {
        row["company_id"] for fund in funds for row in fund["holdings"] if row["company_id"]
    }
    if etf_count is None:
        # Derived here rather than passed in: the count is a property of the
        # documents in this release, so computing it from anything else is a way
        # to disagree with the files the manifest hashes. The label itself now
        # travels on the document, so the count *reads* it instead of re-running
        # the test — a document without the field falls back to the test rather
        # than counting as "not an ETF".
        labelled = [fund for fund in funds if "etf" in fund]
        etf_count = (
            sum(1 for fund in labelled if fund["etf"])
            if labelled
            else sum(
                1
                for fund in funds
                if looks_like_etf(fund.get("name"), fund.get("issuer"))
            )
        )
    return {
        "schema_version": SCHEMA_VERSION,
        "as_of": release_id,
        "generated_at": generated_at or utc_now_iso(),
        "pipeline_git_sha": pipeline_git_sha(),
        "fund_count": len(funds),
        "etf_count": etf_count,
        # ADR-0007 C3 is still open; the release says which test produced
        # ``etf_count`` so a reader can weigh it instead of trusting a number
        # that looks authoritative because it is in a manifest.
        "etf_classifier": ETF_CLASSIFIER,
        "company_count": len(companies),
        # ``company_id`` carries two namespaces from release 2026-10-30.7 on; a
        # consumer that assumes every id is a CIK would be wrong without ever
        # seeing a malformed value, so the release states what both prefixes mean.
        "identity_namespaces": identity_namespaces or {"c_": {"kind": "sec_operating_company", "key": "cik", "source": "EDGAR"}},
        "coverage_histogram": coverage_histogram([f["coverage_pct"] for f in funds]),
        "mapping_rungs": rung_counts,
        "asset_cat_counts": asset_cat_counts,
        "files": sorted(files, key=lambda entry: entry["path"]),
    }


def file_entry(path: str, payload: bytes) -> dict[str, Any]:
    return {"path": path, "bytes": len(payload), "sha256": sha256_hex(payload)}
