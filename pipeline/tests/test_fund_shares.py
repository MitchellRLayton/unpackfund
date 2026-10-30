"""The fund-share join's rules, its arithmetic, and one pin on the real measurement.

Three kinds of test, and the split is deliberate:

* **Rules** — name normalisation, index construction, and ``decide`` on constructed
  candidates. These are the whole honesty argument of the module, so they are tested
  directly rather than inferred from a total: a total that matches says nothing about
  whether it matched for the right reason.
* **Arithmetic** — the weight split across a merged row, the coverage bands, the gate
  crossings, and look-through with loops. Coverage and cycles are where a silent error
  hides: a wrong denominator moves every number by a factor nobody notices, and a loop
  that is not terminated does not produce a wrong number, it produces no answer at all.
* **The pin** — one test that runs the real release and asserts the measured totals. It
  is skipped when ``artifacts/`` has not been built (CI has no cache), because a pin whose
  input is a network download is not a pin. Everything else here is hermetic: synthetic
  release, injected filing loader, no cache, no network.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from pipeline import artifact, classify, fixtures, nport
from pipeline import fund_shares as fs

# --- builders ---------------------------------------------------------------


def catalogue(*entries: tuple[str, str, str]) -> fs.FundCatalogue:
    """A catalogue from ``(ticker, name, issuer)`` triples, without touching a release."""
    from pipeline.fund_shares import FundEntry

    funds = {
        ticker: FundEntry(
            ticker=ticker, name=name, issuer=issuer, etf=False, coverage_pct=0.0
        )
        for ticker, name, issuer in entries
    }
    return fs.FundCatalogue(
        entries=funds,
        by_name=fs._unique_index(funds, lambda entry: fs.normalize_fund_name(entry.name)),
        by_near_name=fs._unique_index(funds, lambda entry: fs.near_fund_name(entry.name)),
        by_issuer=fs._group_index(funds, lambda entry: fs.normalize_fund_name(entry.issuer)),
        aliases={},
        _sorted_names=sorted(
            (fs.normalize_fund_name(entry.name), entry.ticker) for entry in funds.values()
        ),
    )


def decision(*, money_market: bool = False, **kwargs) -> fs.Decision:
    return fs.decide(fs.Candidates(**kwargs), money_market=money_market)


def unit(target: str, bp: float, bucket: str = fs.A_NAME_EXACT) -> fs.Unit:
    return fs.Unit(
        ticker="OUT",
        name="row",
        bp=bp,
        decision=fs.Decision(
            bucket=bucket,
            status=fs.STATUS_JOINED,
            reason="test",
            target=target,
            evidence=fs.EVIDENCE_TICKER,
            tier=fs.TIER_IDENTITY,
        ),
    )


def fund(ticker: str, gross_bp: float, mapped_bp: float, units: list[fs.Unit] | None = None):
    stats = fs.FundStats(ticker=ticker, gross_bp=gross_bp, mapped_bp=mapped_bp)
    stats.coverage_pct = fs._coverage(mapped_bp, gross_bp)
    stats.published_coverage_pct = stats.coverage_pct
    stats.fund_rows = [fs.PublishedFundRow(name="row", published_bp=0, units=units or [])]
    return stats


def holding(name: str, title: str, bp: float, *, ticker: str = "", cusip: str = "") -> nport.Holding:
    """One fund-category filing row valued so ``weights._fraction`` yields exactly ``bp``."""
    return nport.Holding(
        name=name,
        title=title,
        cusip=cusip or None,
        isin=None,
        ticker=ticker or None,
        lei=None,
        balance=None,
        units="NS",
        cur_cd="USD",
        val_usd=bp / fs.BP_PER_UNIT * 1_000_000,
        pct_val=None,
        # EC + RF is the fund-of-funds shape the fixture filing already carries.
        asset_cat="EC",
        issuer_cat="RF",
        inv_country="US",
        payoff_profile="Long",
        is_derivative=False,
    )


def filing(*holdings: nport.Holding) -> nport.NportFiling:
    return nport.NportFiling(
        accession="0000000000-26-000001",
        submission_type="NPORT-P",
        cik="1",
        registrant_name="TEST TRUST",
        series_name="Test Index Fund",
        series_id="S000000001",
        class_ids=["C000000011"],
        report_date="2026-06-30",
        fiscal_year_end="2026-06-30",
        total_assets=1_000_000.0,
        total_liabilities=0.0,
        net_assets=1_000_000.0,
        holdings=list(holdings),
    )


# --- name normalisation -----------------------------------------------------


def test_trust_suffix_is_not_identity():
    """Legal form is dropped; the words that name the vehicle are kept."""
    assert fs.normalize_fund_name("Fidelity Salem Street Trust") == "fidelity salem street trust"
    assert fs.normalize_fund_name("VANGUARD INDEX FUNDS, INC.") == fs.normalize_fund_name(
        "Vanguard Index Funds"
    )
    # 'the' is legal-form noise, 'trust' is not: dropping it would merge a trust with a fund.
    assert fs.normalize_fund_name("The Growth Fund of America") == "growth fund of america"
    assert fs.normalize_fund_name("Growth Fund, Inc.") != fs.normalize_fund_name("Growth")


def test_former_name_clauses_are_dropped_whole():
    """A former name is history, not a second identity."""
    assert fs.normalize_fund_name("ACME TRUST (F/K/A OLD TRUST)") == "acme trust"
    assert fs.normalize_fund_name("Alpha Fund (formerly known as Beta Fund)") == "alpha fund"
    assert fs.normalize_fund_name("GAMMA FUND FKA DELTA FUND") == "gamma fund delta fund"


def test_share_class_words_are_not_identity():
    """A share class is a wrapper around one series, so its designator is dropped."""
    assert fs.normalize_fund_name("Nuveen Equity Index Fund, Class R6") == fs.normalize_fund_name(
        "Nuveen Equity Index Fund"
    )
    assert fs.normalize_fund_name("American Balanced Fund-R6") == fs.normalize_fund_name(
        "American Balanced Fund"
    )
    assert fs.normalize_fund_name("TRP VALUE FD-Z") == fs.normalize_fund_name("TRP VALUE FD")
    # Only *trailing* designators go: 'Institutional' in the middle is part of the series.
    assert fs.normalize_fund_name("Vanguard Institutional Index Fund") == (
        "vanguard institutional index fund"
    )


def test_percent_sign_and_ampersand():
    assert fs.normalize_fund_name("S&P 500 Index Fund") == fs.normalize_fund_name(
        "S AND P 500 Index Fund"
    )
    assert fs.normalize_fund_name("100% U.S. Treasury Fund") == fs.normalize_fund_name(
        "100 Percent U.S. Treasury Fund"
    )
    assert fs.normalize_fund_name("Fidelity Freedom 2050") != fs.normalize_fund_name(
        "Fidelity Freedom 2055"
    )


def test_series_numeral_stays_in_the_exact_key():
    """``Series 1`` on a unit investment trust separates two trusts, so it survives."""
    assert fs.normalize_fund_name("Invesco QQQ Trust, Series 1") == "invesco qqq trust series 1"
    assert fs.normalize_fund_name("Invesco QQQ Trust, Series 1") != fs.normalize_fund_name(
        "Invesco QQQ Trust"
    )
    # The near key drops wrapper words, so it is the key that cannot tell them apart.
    assert fs.near_fund_name("iShares Core S&P 500 ETF") == fs.near_fund_name(
        "iShares Core S&P 500 Index Fund"
    )
    assert fs.normalize_fund_name("iShares Core S&P 500 ETF") != fs.normalize_fund_name(
        "iShares Core S&P 500 Index Fund"
    )


def test_money_market_and_cusip_shaped_ticker_recognition():
    assert fs.looks_like_money_market("Vanguard Market Liquidity Fund")
    assert fs.looks_like_money_market("Fidelity Series Government Money Market Fund")
    assert fs.looks_like_money_market("MASTER INVESTMENT PORTFOLIO")
    assert not fs.looks_like_money_market("Vanguard Total World Stock ETF")
    # A filer that puts the CUSIP in the ticker field is a data defect worth counting.
    assert fs.looks_like_cusip("47805T765")
    assert not fs.looks_like_cusip("DGRO")
    assert not fs.looks_like_cusip("")


# --- the catalogue indexes ---------------------------------------------------


def test_a_shared_name_yields_no_candidate_but_keeps_its_series_group():
    """A name two funds share must return nothing: an alphabetically first guess is a bug."""
    book = catalogue(
        ("AAA", "International Equity Fund", "ALPHA TRUST"),
        ("BBB", "International Equity Fund", "BETA TRUST"),
    )
    assert book.name_candidates("International Equity Fund") == ()
    assert set(book.trust_candidates("ALPHA TRUST")) == {"AAA"}
    assert book.name_candidates("Alpha Trust") == ()


def test_registrant_name_maps_to_every_series_under_it():
    book = catalogue(
        ("AAA", "Alpha Growth Fund", "ISHARES TRUST"),
        ("BBB", "Alpha Value Fund", "ISHARES TRUST"),
        ("CCC", "Beta Growth Fund", "OTHER TRUST"),
    )
    assert set(book.trust_candidates("ISHARES TRUST")) == {"AAA", "BBB"}
    assert book.trust_candidates("Beta Trust") == ()


def test_truncated_title_matches_the_midword_prefix_and_leaves_ambiguity_to_decide():
    """Fidelity cuts the filed title at 16 characters, mid-word: ``ISHARES CORE DIV``."""
    book = catalogue(
        ("DGRO", "iShares Core Dividend Growth ETF", "iShares Trust"),
        ("DIVB", "iShares Core Dividend ETF", "iShares Trust"),
    )
    # The cut lands inside 'dividend', so a token-boundary rule would miss both.
    assert book.prefix_candidates("ISHARES CORE DIV") == ("DGRO", "DIVB")
    ambiguous = decision(title_prefix=book.prefix_candidates("ISHARES CORE DIV"), trust=("DGRO", "DIVB"))
    assert ambiguous.status == fs.STATUS_REFUSED and ambiguous.reason == fs.REFUSE_AMBIGUOUS_TITLE
    assert book.prefix_candidates("ISHARES CORE DIVIDEND GROWTH") == ("DGRO",)
    # Too short or single-word to be a key at all.
    assert book.prefix_candidates("ISHA") == ()
    assert book.prefix_candidates("iShares") == ()


def test_class_ticker_alias_routes_to_the_published_series():
    book = catalogue(("DGRO", "iShares Core Dividend Growth ETF", "iShares Trust"))
    book.aliases = {"DGROX": "DGRO"}
    assert book.ticker_candidates("DGROX") == ("DGRO",)
    assert book.ticker_candidates("DGRO") == ("DGRO",)
    assert book.ticker_candidates("NOPE") == ()


# --- the decision rules ------------------------------------------------------


def test_a_machine_key_is_identity_regardless_of_the_name():
    resolved = decision(ticker=("DGRO",), name=("ISHARES TRUST",), trust=("DGRO",))
    assert resolved.status == fs.STATUS_JOINED and resolved.tier == fs.TIER_IDENTITY
    assert resolved.target == "DGRO"


def test_two_machine_keys_are_refused_not_picked():
    """A merged row whose keys disagree is a row we cannot decide, not a coin flip."""
    resolved = decision(ticker=("DGRO", "DIVB"))
    assert resolved.status == fs.STATUS_REFUSED
    assert resolved.reason == fs.REFUSE_AMBIGUOUS_IDENTITY


def test_two_agreeing_text_fields_are_counted():
    """The title names the series and the registrant agrees: that is corroboration."""
    resolved = decision(title=("DGRO",), trust=("DGRO", "DIVB"))
    assert resolved.status == fs.STATUS_JOINED
    assert resolved.tier == fs.TIER_CORROBORATED
    assert resolved.evidence == fs.EVIDENCE_TITLE_AND_REGISTRANT


def test_one_text_field_is_measured_and_not_counted():
    """This is the tier a naive exact-name join would have shipped."""
    for candidates, reason in (
        ({"name": ("DGRO",)}, "name_uncorroborated"),
        ({"title": ("DGRO",)}, "title_uncorroborated"),
        ({"name": (), "near": ("DGRO",)}, "name_near_uncorroborated"),
    ):
        resolved = decision(**candidates)
        assert resolved.status == fs.STATUS_REFUSED
        assert resolved.reason == reason
        assert resolved.tier == fs.TIER_UNCORROBORATED
        assert not resolved.joined
        assert resolved.target == "DGRO"  # reported, so the cost of refusing is visible


def test_registrant_name_alone_is_refused_with_its_candidate_count():
    """``ISHARES TRUST`` is 333 series: naming one of them is guessing, not joining."""
    resolved = decision(trust=tuple(f"T{n}" for n in range(333)))
    assert resolved.status == fs.STATUS_REFUSED
    assert resolved.reason == fs.REFUSE_TRUST_ONLY
    assert resolved.trust_series_count == 333
    assert resolved.bucket == fs.B_TRUST_SERIES


def test_contradicting_fields_are_refused_and_the_conflict_is_named():
    resolved = decision(name=("AAA",), title=("BBB",))
    assert resolved.status == fs.STATUS_REFUSED
    assert resolved.reason == fs.REFUSE_CONTRADICTED


def test_an_unmatched_series_is_distinguished_from_no_candidate_at_all():
    """A title that names something we do not publish is a universe gap, not a bug."""
    named = decision(has_series_text=True)
    assert named.reason == fs.REFUSE_SERIES_NOT_MATCHED
    empty = decision(has_series_text=False)
    assert empty.reason == fs.REFUSE_UNMATCHED
    assert empty.status == fs.STATUS_NO_MATCH


def test_money_market_is_its_own_bucket_even_when_identified():
    """A sweep is cash; attributing it to a fund would add identity and no company weight."""
    resolved = decision(ticker=("FGXXX",), money_market=True)
    assert resolved.bucket == fs.C_MONEY_MARKET
    assert resolved.target == "FGXXX"
    unidentified = decision(money_market=True)
    assert unidentified.bucket == fs.C_MONEY_MARKET
    assert unidentified.reason == "money_market_unidentified"


def test_buckets_are_assigned_by_nature_not_outcome():
    assert decision(name=("DGRO",)).bucket == fs.A_NAME_EXACT
    assert decision(near=("DGRO",)).bucket == fs.A_NAME_NEAR
    assert decision(title=("DGRO",)).bucket == fs.B_TRUST_SERIES
    assert decision().bucket == fs.D_UNKNOWN


# --- the weight split across a merged row -----------------------------------


def test_merged_row_weight_is_split_by_filed_weight_not_evenly(tmp_path):
    """One published row, two filing rows of different size: the split keeps both honest."""
    book = catalogue(("DGRO", "iShares Core Dividend Growth ETF", "iShares Trust"))
    stats = fs.FundStats(ticker="OUT", gross_bp=10_000, mapped_bp=4_000)
    stats.fund_rows = [fs.PublishedFundRow(name="ISHARES TRUST", published_bp=1_000)]
    document = {"source_url": "https://example/1"}
    loaded = filing(
        holding("ISHARES TRUST", "iShares Core Dividend Growth ETF", 300, ticker="DGRO"),
        holding("ISHARES TRUST", "iShares MSCI EAFE ETF", 100, ticker="EFA"),
    )
    fs._attach_evidence(stats, document, lambda url: loaded, book)
    units = stats.fund_rows[0].units
    assert [round(one.bp) for one in units] == [750, 250]
    assert sum(one.bp for one in units) == 1_000  # no weight created or lost
    # The first row joins by machine key; the second names a registrant we know and a
    # series under it that this release does not publish.
    assert units[0].decision.target == "DGRO"
    assert units[1].decision.reason == fs.REFUSE_TRUST_SERIES_UNMATCHED


def test_a_row_with_no_filing_evidence_is_decided_on_its_name_alone():
    book = catalogue(("DGRO", "iShares Core Dividend Growth ETF", "iShares Trust"))
    stats = fs.FundStats(ticker="OUT", gross_bp=1_000, mapped_bp=0)
    stats.fund_rows = [fs.PublishedFundRow(name="iShares Core Dividend Growth ETF", published_bp=1_000)]
    fs._attach_evidence(stats, {"source_url": "https://example/2"}, lambda url: filing(), book)
    units = stats.fund_rows[0].units
    assert len(units) == 1 and units[0].bp == 1_000
    assert units[0].decision.reason == "name_uncorroborated"


# --- coverage, gates, look-through ------------------------------------------


def test_coverage_uses_gross_weight_and_one_decimal():
    assert fs._coverage(5_000, 10_000) == 50.0
    assert fs._coverage(0, 10_000) == 0.0
    assert fs._coverage(1, 3) == 33.3
    assert fs._coverage(0, 0) == 0.0


def test_gate_crossing_is_counted_per_fund_not_by_band_size():
    """Differencing band sizes nets an entrant against an exit and reports nonsense."""
    stats = {
        "UP": fund("UP", gross_bp=10_000, mapped_bp=5_500, units=[unit("X", 600)]),
        "OUT": fund("OUT", gross_bp=10_000, mapped_bp=6_500, units=[unit("X", 600)]),
        "FLAT": fund("FLAT", gross_bp=10_000, mapped_bp=2_000, units=[]),
    }
    before = {ticker: entry.coverage_pct for ticker, entry in stats.items()}
    after = {
        ticker: fs._coverage(entry.mapped_bp + fs._identity_joined_bp(entry), entry.gross_bp)
        for ticker, entry in stats.items()
    }
    crossed = fs._crossed(stats, before, after, fs.GATE_PARTIAL_PCT)
    # UP goes 55 → 61 and enters; OUT goes 65 → 71 and was never below the gate.
    assert crossed["by_ticker"] == ["UP"]
    assert crossed["funds"] == 1
    assert crossed["gross_bp"] == 10_000
    assert crossed["before_band"]["funds"] == 1
    assert crossed["after_band"]["funds"] == 2


def test_money_market_weight_is_excluded_from_the_identity_join():
    stats = fund(
        "OUT",
        gross_bp=10_000,
        mapped_bp=0,
        units=[unit("X", 500, bucket=fs.A_NAME_EXACT), unit("Y", 300, bucket=fs.C_MONEY_MARKET)],
    )
    assert fs._identity_joined_bp(stats) == 500


def test_lookthrough_weights_by_the_inner_funds_own_coverage():
    """A joined fund-share row is worth its target's coverage, not the whole position."""
    inner = fund("IN", gross_bp=10_000, mapped_bp=6_000)
    outer = fund("OUT", gross_bp=10_000, mapped_bp=4_000, units=[unit("IN", 1_000)])
    stats = {"IN": inner, "OUT": outer}
    links = {"OUT": [("IN", 1_000.0)]}
    report = fs._lookthrough(stats, links)
    assert report["depth1"]["company_bp"] == 600.0  # 1,000 × 60%
    assert report["depth1"]["joined_links"] == 1
    assert report["cycles"]["count"] == 0


def test_lookthrough_stops_at_a_cycle_and_at_a_self_holding():
    """A holds B holds A must not recurse; a fund holding itself is a one-step cycle."""
    a = fund("A", gross_bp=10_000, mapped_bp=5_000, units=[unit("B", 1_000)])
    b = fund("B", gross_bp=10_000, mapped_bp=5_000, units=[unit("A", 2_000)])
    own = fund("C", gross_bp=10_000, mapped_bp=5_000, units=[unit("C", 400)])
    stats = {"A": a, "B": b, "C": own}
    links = {"A": [("B", 1_000.0)], "B": [("A", 2_000.0)], "C": [("C", 400.0)]}
    report = fs._lookthrough(stats, links)
    # Depth 1: A→B and B→A are both real links, so both count once.
    assert report["depth1"]["company_bp"] == 500.0 + 1_000.0
    assert report["cycles"]["terminated"] is True
    assert report["cycles"]["self_holds"] == 1
    # Each direction of a mutual holding is its own walk (A→B→A and B→A→B), plus the
    # self-holding: the count is of terminated walks, not of distinct fund pairs.
    assert report["cycles"]["count"] == 3
    assert report["cycles"]["bp"] == 2_000.0 + 1_000.0 + 400.0
    assert {tuple(example["path"]) for example in report["cycles"]["examples"]} == {
        ("A", "B", "A"),
        ("B", "A", "B"),
        ("C", "C"),
    }


def test_depth_two_is_reported_and_flagged_not_shippable():
    """Two hops is a measurement, not a number to display: one level deep [dec]."""
    a = fund("A", gross_bp=10_000, mapped_bp=5_000, units=[unit("B", 1_000)])
    b = fund("B", gross_bp=10_000, mapped_bp=5_000, units=[unit("C", 2_000)])
    c = fund("C", gross_bp=10_000, mapped_bp=5_000)
    report = fs._lookthrough({"A": a, "B": b, "C": c}, {"A": [("B", 1_000.0)], "B": [("C", 2_000.0)]})
    # 1,000 × (2,000 / 10,000) × 50% — the inner fund's own coverage, then the grandchild's.
    assert report["depth2"]["company_bp"] == 100.0
    assert report["depth2"]["shippable"] is False
    assert "§1" in report["depth2"]["note"]


# --- the measurement, end to end --------------------------------------------


def _synthetic_release(root: Path) -> Path:
    """One release with two published funds, each holding an unmapped fund row."""

    def document(ticker: str, name: str, issuer: str, rows: list[dict]) -> dict:
        built = fixtures.sample_document()
        built.update(
            {
                "ticker": ticker,
                "name": name,
                "issuer": issuer,
                "holdings": rows,
                # A per-fund URL, so the injected loader can serve the right filing: the
                # fixture document is a template, not a real filing.
                "source_url": f"https://www.sec.gov/Archives/edgar/data/1/000000000026000001/{ticker}.xml",
                "coverage_pct": round(
                    100
                    * sum(row["weight_bp"] for row in rows if row["company_id"])
                    / sum(row["weight_bp"] for row in rows),
                    1,
                ),
            }
        )
        return built

    rows_a = [
        artifact.holding_row(
            company_id="CIK0000320193",
            name="Apple Inc",
            ticker="AAPL",
            asset_cat=classify.EQUITY,
            weight_bp=4_000,
        ),
        artifact.holding_row(
            company_id=None,
            name="ISHARES TRUST",
            ticker=None,
            asset_cat=classify.FUND,
            weight_bp=4_000,
        ),
    ]
    rows_b = [
        artifact.holding_row(
            company_id="CIK0001652044",
            name="Alphabet Inc",
            ticker="GOOGL",
            asset_cat=classify.EQUITY,
            weight_bp=2_000,
        ),
        artifact.holding_row(
            company_id=None,
            name="Fidelity Salem Street Trust",
            ticker=None,
            asset_cat=classify.FUND,
            weight_bp=8_000,
        ),
    ]
    return fixtures.write_release(
        root,
        [
            document("AAAA", "Alpha Index Fund", "ALPHA TRUST", rows_a),
            document("BBBB", "Beta Growth Fund", "BETA TRUST", rows_b),
        ],
    )


def _synthetic_measure(root: Path):
    """The release, its catalogue, and a loader that serves each fund its own filing."""

    release = _synthetic_release(root)
    book = catalogue(
        ("AAAA", "Alpha Index Fund", "ALPHA TRUST"),
        ("BBBB", "Beta Growth Fund", "BETA TRUST"),
        ("DGRO", "iShares Core Dividend Growth ETF", "iShares Trust"),
        ("FLTSX", "Fidelity Series Long-Term Treasury Bond Index Fund", "Fidelity Salem Street Trust"),
    )
    fillets = {
        "AAAA": filing(
            holding("ISHARES TRUST", "iShares Core Dividend Growth ETF", 4_000, ticker="DGRO")
        ),
        "BBBB": filing(
            holding(
                "Fidelity Salem Street Trust",
                "Fidelity Series Long-Term Treasury Bond Index Fund",
                8_000,
            )
        ),
    }

    def measure_once() -> dict:
        return fs.measure(
            release,
            catalogue=book,
            survey=fs.IdentityKeySurvey(),
            load_filing=lambda url: fillets["AAAA" if "AAAA" in url else "BBBB"],
        )

    return measure_once


def test_measure_reconciles_and_is_deterministic(tmp_path):
    """Same inputs, same report; and the join must not silently lose the weight it measures."""
    measure_once = _synthetic_measure(tmp_path)
    first = measure_once()
    assert json.dumps(first, sort_keys=True) == json.dumps(measure_once(), sort_keys=True)

    published = first["published"]
    assert published["fund_unmapped_bp"] == 12_000
    assert published["fund_rows"] == 2
    # The evidence is recovered in full: the residual is zero for a release built from it.
    assert first["recovered"]["fund_bp"] == pytest.approx(12_000, abs=1)
    assert first["recovered"]["residual_bp"] == pytest.approx(0, abs=1)
    # Every unit lands in exactly one class, and the classes add up to the gap.
    assert sum(row["bp"] for row in first["classes"].values()) == pytest.approx(12_000, abs=1)


def test_measure_join_is_worth_money_on_a_synthetic_release(tmp_path):
    """Two joins here: one machine key, and one title that its registrant agrees with."""
    report = _synthetic_measure(tmp_path)()
    assert report["tiers"]["identity_bp"] == pytest.approx(4_000, abs=1)
    assert report["tiers"]["corroborated_bp"] == pytest.approx(8_000, abs=1)
    assert report["joined"]["bp"] == pytest.approx(12_000, abs=1)
    # Both funds were under the 60% gate before and above it after: the join is worth
    # exactly what it moves.
    assert report["coverage"]["funds_moved"]["partial_gate"]["funds"] == 2
    assert report["coverage"]["published_vs_recomputed"]["funds_over_tolerance"] == 0


def test_render_summary_keeps_the_refusal_columns_aligned(tmp_path):
    """One reason name is much longer than the others; the bp column must still line up."""
    report = _synthetic_measure(tmp_path)()
    report["refusals"] = [
        {
            "reason": fs.REFUSE_TRUST_SERIES_UNMATCHED,
            "bp": 758_270.0,
            "names": 361,
            "share_of_fund_unmapped_pct": 7.6,
            "top": [{"name": "ISHARES TRUST", "bp": 79_853.0}],
        },
        {
            "reason": fs.REFUSE_SERIES_NOT_MATCHED,
            "bp": 2_258_808.0,
            "names": 1_900,
            "share_of_fund_unmapped_pct": 22.5,
            "top": [],
        },
    ]
    text = fs.render_summary(report)
    rows = [
        line
        for line in text.splitlines()
        if line.startswith(f"  {fs.REFUSE_TRUST_SERIES_UNMATCHED}")
        or line.startswith(f"  {fs.REFUSE_SERIES_NOT_MATCHED}")
    ]
    assert len(rows) == 2
    assert len({row.index(" bp") for row in rows}) == 1
    assert fs._format_bp(758_270) in rows[0]


# --- the pin ----------------------------------------------------------------


@pytest.mark.skipif(
    not fs.DEFAULT_RELEASE.exists(),
    reason="no built release on this machine (CI has no N-PORT cache); run the build first",
)
def test_measured_totals_on_the_release():
    """The numbers the write-up quotes, pinned so a change in the join has to show itself.

    Slow by design (it reads 8,983 documents and 2,021 cached filings): a pin that reads a
    smaller sample does not pin the thing the report claims.
    """
    report = fs.measure(fs.DEFAULT_RELEASE)
    published = report["published"]
    assert published["gross_bp"] == 90_507_800
    assert published["unmapped_bp"] == 48_234_821
    assert published["fund_unmapped_bp"] == 10_024_325
    assert published["fund_rows"] == 12_477
    assert published["fund_names"] == 2_545
    assert report["funds"] == 8_983
    # Reconciled against the artifact's own total, to within rounding. The residual is a
    # float because the filing weights are, so it is compared with a sub-bp tolerance.
    assert report["recovered"]["residual_bp"] == pytest.approx(718, abs=1)
    # The join that survives scrutiny, and the tier it comes from.
    assert report["joined"]["bp"] == pytest.approx(5_629_511, abs=2)
    assert report["tiers"]["identity_bp"] == pytest.approx(3_220_816, abs=2)
    assert report["tiers"]["corroborated_bp"] == pytest.approx(2_408_695, abs=2)
    # Measured and refused: the naive exact-name claim we do not ship.
    assert report["tiers"]["uncorroborated_bp"] > 1_000_000
    # The identity-key finding: CUSIPs cannot join, because we publish SEC class IDs.
    assert report["identity_keys"]["class_ids"] == report["identity_keys"]["class_ids_sec_shaped"]
    assert report["identity_keys"]["class_ids_cusip_shaped"] == 0
    assert report["identity_keys"]["cusip_joinable"] is False
    # Look-through: depth 1 is the shippable number, depth 2 is reported and not shippable.
    assert report["lookthrough"]["depth1"]["company_bp"] == pytest.approx(3_124_671, abs=2)
    assert report["lookthrough"]["depth2"]["shippable"] is False
    assert report["lookthrough"]["cycles"]["terminated"] is True
    # Per-fund consequence, with the denominator stated by the report itself.
    assert "gross holding weight" in report["coverage"]["denominator"]
    assert report["coverage"]["before"]["under_60"]["funds"] == 5_065
    assert report["coverage"]["funds_moved"]["partial_gate"]["funds"] == 545
    assert report["coverage"]["funds_moved"]["partial_gate_lookthrough"]["funds"] == 207
    assert report["coverage"]["published_vs_recomputed"]["funds_over_tolerance"] == 0
