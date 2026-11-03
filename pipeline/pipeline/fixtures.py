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
    document = artifact.build_fund_artifact(
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
    # The sample filing holds one fund position, so a *published* document for it has
    # sleeves: ADR-0016 §5 refuses to publish "5% in funds, no composition named". The
    # sleeve here is unresolved (the fixture has no child fund), which is the honest
    # shape for it and exercises the gate's `None` label.
    sleeves = [
        {
            "ticker": None,
            "name": row["name"],
            "weight_bp": row["weight_bp"],
            "coverage_pct": None,
            "asset_cat": None,
            "resolved_by": None,
        }
        for row in document["holdings"]
        if row["asset_cat"] == classify.FUND
    ]
    if sleeves:
        document = artifact.attach_fund_of_funds(
            document,
            holdings=document["holdings"],
            coverage_pct=document["coverage_pct"],
            metrics=document["metrics"],
            components=sleeves,
        )
    return document


def write_release(
    root: Path,
    documents: list[dict],
    release_id: str = FIXTURE_RELEASE_ID,
    *,
    benchmarks: tuple[str, ...] = (),
    securities_source: dict | None = None,
    countries: dict[str, str] | None = None,
    countries_fallback: dict | None = None,
) -> Path:
    """Write ``documents`` as a release directory, the way ``build.py`` does.

    ``benchmarks`` names the tickers to pre-roll into ``benchmarks/{T}.json``. The
    sample release pre-rolls its own fund, which is not the production benchmark
    (``benchmarks.BENCHMARK_TICKERS``): the point is the code path, and a fixture
    that hard-coded VT could only run if the fixture were VT. ``securities_source``
    carries the typed-symbol input ADR-0014 added; ``None`` publishes no
    ``securities/`` family, which is the dual-read shape a release without it has.
    ``countries`` is the decision ``company_countries.decide`` would have reached; a
    fixture release publishes the map only when a caller supplies one, which keeps
    both shapes — with and without a country — in reach of the validator's tests.
    ``countries_fallback`` is the ``sources``/``agreement`` block a fallback build
    publishes beside it, so the validator's checks of that block have a shape to run
    against offline.
    """
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
        benchmarks=benchmarks,
        securities_source=securities_source,
        countries=countries,
        countries_fallback=countries_fallback,
    )
    return release_dir


def write_sample_release(root: Path) -> Path:
    # One benchmark object, so `pnpm data:validate --fixtures` exercises the compact
    # object's descriptor entry, hash gate and rollup check offline.
    document = sample_document()
    # One company placed, so `--fixtures` exercises the map's descriptor entry, its
    # hash gate, and the projection against the company shards offline. The CIK is the
    # sample filing's Apple row, which is the only company the fixture can name twice.
    return write_release(
        root,
        [document],
        benchmarks=("TEST",),
        countries={"c_0000320193": "US"},
    )
