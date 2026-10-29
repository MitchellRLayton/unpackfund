"""The offline fixture release: one source of truth for tests, CI and ``--fixtures``.

The validator's ``--fixtures`` mode exists so ``pnpm verify`` can prove the schema,
sum, duplicate, hash and CUSIP checks work without network. That proof is only
worth anything if the fixture goes through the *same* code path as a real build,
so it lives here rather than in ``tests/conftest.py`` where only pytest could
reach it.

The filing is synthetic and hand-built (``tests/fixtures/nport_sample.xml``) to
cover shapes a single real filing would not contain: two share classes of one
company, a fund-of-funds position, a money-market sweep, a derivative with a
negative value, and an "N/A" CUSIP. It is test data, never a published artifact.
"""

from __future__ import annotations

from pathlib import Path

from . import artifact, catalogue, classify, manifest as manifest_mod, weights
from .companies import CompanyIndex
from .nport import NportFiling, parse

PIPELINE_ROOT = Path(__file__).resolve().parent.parent
SAMPLE_XML = PIPELINE_ROOT / "tests" / "fixtures" / "nport_sample.xml"
FIXTURE_RELEASE_ID = "2026-10-28.1"

#: Toy operating-company file in EDGAR's shape: two issuers with tickers, one
#: resolvable only by name, and nothing for the fund or the money-market sweep.
TICKER_DOCUMENT = {
    "0": {"cik_str": 320193, "ticker": "AAPL", "title": "Apple Inc."},
    "1": {"cik_str": 1652044, "ticker": "GOOGL", "title": "Alphabet Inc."},
    "2": {"cik_str": 1234567, "ticker": "UNLST", "title": "Unlisted Holdings"},
}


def sample_filing() -> NportFiling:
    return parse(SAMPLE_XML.read_bytes())


def sample_index() -> CompanyIndex:
    return CompanyIndex.from_document(TICKER_DOCUMENT)


def sample_document(
    filing: NportFiling | None = None,
    index: CompanyIndex | None = None,
) -> dict:
    filing = filing or sample_filing()
    index = index or sample_index()
    vector = weights.build_vector(
        filing.holdings, index, filing.net_assets, lag_days=59
    )
    return artifact.build_fund_artifact(
        ticker="TEST",
        fund_id=filing.series_id or "CIK0000000001",
        name=filing.series_name or "",
        issuer=filing.registrant_name or "",
        as_of=filing.report_date or "",
        filed_at="2026-08-28",
        source_url="https://www.sec.gov/Archives/edgar/data/1/000000000026000001/primary_doc.xml",
        coverage_pct=vector.coverage_pct,
        etf=classify.looks_like_etf(
            filing.series_name or "", filing.registrant_name or ""
        ),
        holdings=[
            artifact.holding_row(
                company_id=row.company_id,
                name=row.name,
                ticker=row.ticker,
                asset_cat=row.asset_cat,
                weight_bp=row.weight_bp,
            )
            for row in vector.holdings
        ],
        metrics=weights.metrics(vector.holdings),
        warnings=vector.warnings,
    )


def write_release(root: Path, documents: list[dict], release_id: str = FIXTURE_RELEASE_ID) -> Path:
    """Write ``documents`` as a release directory, the way ``build.py`` does."""
    release_dir = root / "releases" / release_id
    (release_dir / "funds").mkdir(parents=True, exist_ok=True)
    files = []
    for document in documents:
        payload = artifact.canonical_bytes(document)
        rel_path = f"funds/{document['ticker']}.json"
        (release_dir / rel_path).write_bytes(payload)
        files.append(manifest_mod.file_entry(rel_path, payload))
    manifest_document = manifest_mod.build_manifest(
        release_id=release_id,
        funds=documents,
        files=files,
        rung_counts={"ticker": 1, "name_exact": 1, "unmapped": 1},
        asset_cat_counts={},
        etf_count=None,
        generated_at="2026-10-30T00:00:00Z",
    )
    manifest_payload = artifact.canonical_bytes(manifest_document)
    (release_dir / "manifest.json").write_bytes(manifest_payload)
    # The same writer the build uses, so a fixture release cannot drift from a real
    # one: if the catalogue objects change shape, every fixture test sees it.
    catalogue.write_release_objects(
        release_dir,
        release=release_id,
        documents=documents,
        files=files,
        header=manifest_document,
        manifest_payload=manifest_payload,
        # One alias, so the fixture release exercises the map the way a real one
        # does; the target is the fixture fund, which is always published.
        aliases={"TESTX": documents[0]["ticker"]} if documents else {},
        etf_classifier=classify.ETF_CLASSIFIER,
    )
    return release_dir


def write_sample_release(root: Path) -> Path:
    return write_release(root, [sample_document()])
