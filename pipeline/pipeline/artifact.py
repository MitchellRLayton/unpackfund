"""The published per-fund JSON: shape, canonical bytes, hash.

Field order is fixed and hashing runs over the exact serialised bytes, so a
release diff that changes a number changes a hash and nothing else. Two runs on
the same filing must produce identical bytes — that is the determinism gate.
"""

from __future__ import annotations

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
        "name": name,
        "issuer": issuer,
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

    ``asset_cat`` is additive to schema v1 and is what lets the UI label cash and
    derivatives instead of presenting them as companies. CUSIP and ISIN are
    deliberately absent: they never leave the pipeline (compliance rule).
    """
    return {
        "company_id": company_id,
        "name": name,
        "ticker": ticker,
        "asset_cat": asset_cat,
        "weight_bp": weight_bp,
    }
