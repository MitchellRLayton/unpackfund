"""The compact benchmark object: one fund's traced weights, pre-rolled to companies.

ADR-0015 makes one fund the fixed benchmark for every portfolio, and the ledger's
"In VT" column needs exactly one number per company from it. Reading that off
``funds/VT.json`` costs **193 kB gzipped** — the largest object the ledger fetches,
9,770 filed rows of which 7,396 are never looked at, for a column that needs 2,374.

This module owns the derived object that replaces it: the same filing, the same
rollup rule, a tenth of the bytes. It is *derived*, so the release must be able to
prove it — ``validate._check_benchmarks`` recomputes the rollup from the fund
document beside it and fails the release if the two disagree.

Two rules here are copied from the consumer rather than invented (``web/lib/
benchmark.ts``, and ``tests/test_benchmarks.py`` pins each one):

* A row with no ``company_id`` is **dropped**, not carried as an unknown: the map
  is keyed by company, and the whole point of the object is the company view.
* A row filed at **0 bp** is dropped too. A fund of this size rounds most of its
  tail below one basis point, so keeping those rows would add thousands of zeros
  to save the reader nothing — the consumer already reads "absent" and "zero" as
  the same ``0.00%``, and the caption says so.

Weights stay **integer basis points**, like every other weight in the contract, so
no rounding happens twice.
"""

from __future__ import annotations

import json
from typing import Any, Iterable

from .artifact import sha256_hex

#: Bumped only for a breaking change to this object's shape.
SCHEMA_VERSION = 1

#: ``kind`` names the object so a consumer cannot read a fund document as one.
KIND = "benchmark"

#: The tickers a release pre-rolls. ADR-0015 fixes the *product* choice in the web
#: app (``BENCHMARK_TICKER``); this is the data side of the same decision, and one
#: entry is the whole cost.
BENCHMARK_TICKERS: tuple[str, ...] = ("VT",)

#: The ceiling on one compact object. It exists to fail the build, not to warn:
#: the object's only reason to exist is being small. The largest observed is VT at
#: 43 kB raw / 19 kB gzipped against 1.58 MB / 193 kB for its fund document, so this
#: is ~5x headroom, and a benchmark that outgrew it would have stopped being a saving.
MAX_BENCHMARK_BYTES = 250_000


def rollup(document: dict[str, Any]) -> dict[str, int]:
    """``company_id`` → basis points of the benchmark's NAV, sorted by company id.

    One company can appear on several filed rows (share classes, several
    securities from one issuer) and they are summed, exactly as the ledger sums a
    company's rows. Sorted so the serialised bytes are stable.
    """
    totals: dict[str, int] = {}
    for row in document.get("holdings") or []:
        company_id = row.get("company_id")
        weight_bp = row.get("weight_bp") or 0
        if not company_id or not weight_bp:
            continue
        totals[company_id] = totals.get(company_id, 0) + int(weight_bp)
    return {company_id: totals[company_id] for company_id in sorted(totals)}


def build_benchmark_object(document: dict[str, Any]) -> dict[str, Any]:
    """The compact object for one fund document, provenance included.

    Every field a reader needs to label the column is copied from the fund
    document rather than recomputed: the provenance belongs to the filing, and two
    implementations of ``coverage_pct`` is one too many.
    """
    weights = rollup(document)
    if not weights:
        raise ValueError(f"{document.get('ticker')!r} has no traced company weights")
    return {
        "schema_version": SCHEMA_VERSION,
        "kind": KIND,
        "ticker": document["ticker"],
        "fund_id": document["fund_id"],
        "name": document["name"],
        "as_of": document["as_of"],
        "filed_at": document["filed_at"],
        "lag_days": document["lag_days"],
        "coverage_pct": document["coverage_pct"],
        "source_url": document["source_url"],
        "weights": weights,
    }


def canonical_bytes(document: dict[str, Any]) -> bytes:
    """Compact serialisation: fixed key order, no whitespace, trailing newline.

    Deliberately not ``artifact.canonical_bytes``. That one is indented because a
    fund document is diffed by humans and its hash is a release event; this object
    is fetched by a browser and never read by anyone, so its job is to be small.
    ``indent=2`` would put each of VT's 2,374 weights on four lines and turn 43 kB
    into 104 kB. Byte-stability — the real requirement — comes from the fixed key
    order and the sorted map, not from the whitespace.
    """
    return (
        json.dumps(document, separators=(",", ":"), ensure_ascii=False) + "\n"
    ).encode("utf-8")


def build_benchmark_documents(
    documents: Iterable[dict[str, Any]],
    tickers: Iterable[str] = BENCHMARK_TICKERS,
) -> dict[str, dict[str, Any]]:
    """Every configured benchmark the release actually publishes, by ticker.

    A release that does not contain the ticker (a narrow universe, a rehearsal of
    five funds) simply publishes no benchmark object, and the consumer falls back
    to the fund document it can always fetch.
    """
    wanted = {ticker.upper() for ticker in tickers}
    built: dict[str, dict[str, Any]] = {}
    for document in documents:
        ticker = str(document.get("ticker", "")).upper()
        if ticker not in wanted:
            continue
        built[ticker] = build_benchmark_object(document)
    return built


def size_ok(payload: bytes) -> bool:
    return len(payload) <= MAX_BENCHMARK_BYTES


__all__ = [
    "BENCHMARK_TICKERS",
    "KIND",
    "MAX_BENCHMARK_BYTES",
    "SCHEMA_VERSION",
    "build_benchmark_documents",
    "build_benchmark_object",
    "canonical_bytes",
    "rollup",
    "sha256_hex",
    "size_ok",
]
