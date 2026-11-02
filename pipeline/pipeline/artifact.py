"""The published per-fund JSON: shape, canonical bytes, hash.

Field order is fixed and hashing runs over the exact serialised bytes, so a
release diff that changes a number changes a hash and nothing else. Two runs on
the same filing must produce identical bytes — that is the determinism gate.
"""

from __future__ import annotations

import re

from . import weights
from .identifiers import UNNAMED_HOLDING, is_licensed, public_name

import hashlib
import json
import os
import time
from typing import Any

SCHEMA_VERSION = 1
SOURCE_NPORT = "SEC N-PORT"

#: The hard ceiling on one fund document. It was 200,000 B until 2026-10-30, when the
#: operator ruled that the 211 funds it excluded — VTI, VT, VXUS, DFAX among them — are
#: the ones most investors actually hold, so a wide release without them defeats the
#: point. 2 MB covers the largest observed document (DFAX, 1,594,655 B) with headroom.
#: The page cost is one gzipped fetch (~120 kB for VTI), not a per-scroll cost: a fund
#: page renders exactly one document.
MAX_FUND_BYTES = 2_000_000

#: Where a document stops being cheap. Not a gate — the validator reports the count so
#: a release cannot quietly become 8,000 large pages.
LARGE_FUND_BYTES = 500_000


def canonical_bytes(document: dict[str, Any]) -> bytes:
    """Stable serialisation: fixed key order, 2-space indent, trailing newline."""
    return (json.dumps(document, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def sha256_hex(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def utc_now_iso() -> str:
    """``generated_at``, overridable with SOURCE_DATE_EPOCH for reproducible builds."""
    epoch = os.environ.get("SOURCE_DATE_EPOCH")
    if epoch:
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(int(epoch)))
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def category_fields(holdings: list[dict[str, Any]]) -> dict[str, Any]:
    """The two ADR-0016 objects for a published vector, derived from its rows.

    One implementation for the filed vector and the composed one: both are lists of
    published rows, and the split of a document is a function of exactly what it
    publishes. Two implementations here would be a number that can disagree with itself.
    """
    rows = [
        (row["asset_cat"], row["weight_bp"], bool(row.get("company_id")))
        for row in holdings
    ]
    return {
        "categories": weights.category_totals(rows),
        "coverage_by_cat": weights.category_coverage(rows),
    }


def build_fund_artifact(
    *,
    ticker: str,
    fund_id: str,
    name: str,
    issuer: str,
    as_of: str,
    filed_at: str,
    source_url: str,
    coverage_pct: float,
    etf: bool,
    holdings: list[dict[str, Any]],
    metrics: dict[str, float | None],
    warnings: list[str],
) -> dict[str, Any]:
    """Assemble the artifact in contract order (``data-contract-and-release`` §1).

    ``categories`` and ``coverage_by_cat`` are **derived here, not passed in**: the split
    of a document is a function of the rows it publishes, so deriving it makes it
    impossible for a caller to publish a vector and a split that disagree — including the
    flattened path, where the rows are a composition rather than a filing (ADR-0016).
    """
    lag_days = _days_between(filed_at, as_of)
    return {
        "schema_version": SCHEMA_VERSION,
        "ticker": ticker,
        "fund_id": fund_id,
        "name": public_name(name),
        "issuer": issuer,
        # Additive to schema 1, and the reason it is here rather than in the
        # catalogue: three consumers want one label (the catalogue row, a fund
        # page, and any ETF/mutual-fund filter), and computing it in three
        # places is exactly how `catalogue.json` came to say "not an ETF" for
        # all 8,531 funds while the release summary said 3,172. The test that
        # produced it is named once per release (`etf_classifier`), not 8,531
        # times; ADR-0007 C3 will replace the test, not the field.
        "etf": etf,
        "as_of": as_of,
        "filed_at": filed_at,
        "lag_days": lag_days,
        "source": SOURCE_NPORT,
        "source_url": source_url,
        "coverage_pct": coverage_pct,
        # ADR-0016: what the fund is made of, and how much of each part we can name.
        # ``categories`` is the "60/40" fact in integer basis points and sums to the
        # holding total; ``coverage_by_cat`` is the only coverage number that can be
        # compared across funds, because it measures inside one asset class.
        **category_fields(holdings),
        "holdings": holdings,
        "metrics": metrics,
        "warnings": warnings,
    }


def _days_between(later: str, earlier: str) -> int:
    from datetime import date

    later_date = date.fromisoformat(later)
    earlier_date = date.fromisoformat(earlier)
    return (later_date - earlier_date).days


def holding_row(
    *,
    company_id: str | None,
    name: str,
    ticker: str | None,
    asset_cat: str,
    weight_bp: int,
) -> dict[str, Any]:
    """One published holding row.

    ``name`` is redacted: some filings put the CUSIP where the security name goes
    (``"742718109"``) or embed one in a Bloomberg string (``"New Issuer: BB Company
    ID:072219595"``), and 23 funds in the widened universe did exactly that. The row
    stays — its weight is real and the coverage denominator needs it — but the
    identifier is replaced, and a name that was nothing but the identifier becomes
    ``UNNAMED_HOLDING`` rather than an empty string.

    ``asset_cat`` is additive to schema v1 and is what lets the UI label cash and
    derivatives instead of presenting them as companies. CUSIP and ISIN are
    deliberately absent: they never leave the pipeline (compliance rule).

    A row with no ``company_id`` gets no ``ticker`` either. The as-filed ticker is
    not a ticker in that case: on the widened universe it was a fund's own
    identifier, a Bloomberg suffix (``JHDG US``) or a CUSIP (``47803P419``) for
    bond and fund-of-funds holdings, and 27 of them failed the release's own CUSIP
    check. If we cannot name the company, we cannot vouch for the identifier, so
    the row keeps its as-filed name and nothing else.
    """
    return {
        "company_id": company_id,
        "name": public_name(name),
        "ticker": ticker if company_id and not is_licensed(ticker) else None,
        "asset_cat": asset_cat,
        "weight_bp": weight_bp,
    }

#: Fields a flattened fund adds to the document, in contract order, between ``metrics``
#: and ``warnings``. ``components`` is the sleeve view a reader wants ("this fund holds
#: these funds at these weights"); ``lookthrough`` is the provenance of the vector in
#: ``holdings`` — how deep the walk went, how much of NAV arrived through fund edges,
#: and what is left unresolved. **Their presence is the signal**: a document with
#: ``lookthrough`` has a flattened ``holdings``; one without has the filed vector. There
#: is no flag to disagree with the data.
FUND_OF_FUNDS_FIELDS = ("components", "lookthrough")


def attach_fund_of_funds(
    document: dict[str, Any],
    *,
    holdings: list[dict[str, Any]],
    coverage_pct: float,
    metrics: dict[str, float | None],
    components: list[dict[str, Any]] | None = None,
    lookthrough: dict[str, Any] | None = None,
    warnings: list[str] | None = None,
) -> dict[str, Any]:
    """Rebuild a fund document with a flattened vector, or with its sleeves only.

    Rebuilt rather than mutated so the key order stays the contract's: ``canonical_bytes``
    hashes exactly what this returns, and a document whose keys moved because a dict was
    updated in place is a hash that changes for no reason.
    """
    rebuilt: dict[str, Any] = {
        "schema_version": document["schema_version"],
        "ticker": document["ticker"],
        "fund_id": document["fund_id"],
        "name": document["name"],
        "issuer": document["issuer"],
        "etf": document["etf"],
        "as_of": document["as_of"],
        "filed_at": document["filed_at"],
        "lag_days": document["lag_days"],
        "source": document["source"],
        "source_url": document["source_url"],
        "coverage_pct": coverage_pct,
        **category_fields(holdings),
        "holdings": holdings,
        "metrics": metrics,
    }
    if components:
        rebuilt["components"] = components
    if lookthrough is not None:
        rebuilt["lookthrough"] = lookthrough
    rebuilt["warnings"] = warnings if warnings is not None else document["warnings"]
    return rebuilt
