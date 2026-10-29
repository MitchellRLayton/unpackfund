"""The published per-fund JSON: shape, canonical bytes, hash.

Field order is fixed and hashing runs over the exact serialised bytes, so a
release diff that changes a number changes a hash and nothing else. Two runs on
the same filing must produce identical bytes — that is the determinism gate.
"""

from __future__ import annotations

import re

from .identifiers import UNNAMED_HOLDING, is_licensed, public_name

import hashlib
import json
import os
import time
from typing import Any

SCHEMA_VERSION = 1
SOURCE_NPORT = "SEC N-PORT"


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
    """Assemble the artifact in contract order (``data-contract-and-release`` §1)."""
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
