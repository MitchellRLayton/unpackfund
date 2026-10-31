"""The foreign-issuer namespace: two id spaces, one rule about what may ship.

These tests pin the four things that would be expensive to get wrong, in the order a
reviewer asked for them:

1. an ``l_`` id can never collide with a ``c_`` id, because the shapes are disjoint and
   the ``l_`` id is a hash — the LEI itself never becomes an id;
2. nothing published carries an LEI, a CUSIP or an ISIN;
3. a refusal is a decision, not a fallthrough: a fund entity, a well-formed LEI GLEIF
   has no record for, and an ISIN with no mapping are refused *and counted*;
4. the same company never sits in both namespaces at once (the bridge).

No network: the index is built in memory from the same shapes the cache holds.
"""

from __future__ import annotations

import pytest

from pipeline import artifact, companies, gleif, weights
from pipeline.companies import CompanyIndex
from pipeline.nport import Holding

APPLE = "c_0000320193"
PERSEUS_LEI = "213800CHWARFAAN7UB85"  # Perseus Mining Ltd, an ASX-listed issuer
NESTLE_LEI = "549300E27V6N4OJCJ944"  # Nestlé S.A.
FUND_LEI = "529900T8BM49AURSDO55"  # a collective investment vehicle (category FUND)


def _holding(name: str, value: float, **overrides) -> Holding:
    defaults = dict(
        name=name,
        title="COMMON STOCK",
        cusip=None,
        isin=None,
        ticker=None,
        lei=None,
        balance=1.0,
        units="NS",
        cur_cd="USD",
        val_usd=value,
        pct_val=None,
        asset_cat="EC",
        issuer_cat="CORP",
        inv_country="AU",
        payoff_profile="Long",
        is_derivative=False,
    )
    defaults.update(overrides)
    return Holding(**defaults)


def _issuers(**overrides) -> gleif.IssuerIndex:
    """An index holding exactly the entities the test talks about."""
    entities = {
        PERSEUS_LEI: gleif.Entity(
            lei=PERSEUS_LEI,
            name="Perseus Mining Limited",
            status="ACTIVE",
            jurisdiction="AU",
            category="GENERAL",
        ),
        NESTLE_LEI: gleif.Entity(
            lei=NESTLE_LEI,
            name="Nestlé S.A.",
            status="ACTIVE",
            jurisdiction="CH",
            category="GENERAL",
        ),
        FUND_LEI: gleif.Entity(
            lei=FUND_LEI,
            name="Some UCITS",
            status="ACTIVE",
            jurisdiction="LU",
            category="FUND",
        ),
    }
    isins = {"AU000000PRU3": PERSEUS_LEI, "CH0038863350": NESTLE_LEI}
    entities.update(overrides.get("entities") or {})
    isins.update(overrides.get("isins") or {})
    index = gleif.IssuerIndex({}, {}, cache_date="2026-10-30", source="test")
    index.entities = entities
    index.isin_to_lei = isins
    return index


# --- the id is a name, the LEI never ships ----------------------------------


def test_issuer_id_is_a_hash_and_never_contains_the_lei():
    cid = gleif.issuer_id(PERSEUS_LEI)
    assert cid.startswith("l_")
    assert len(cid) == len("l_") + gleif.ID_HEX_DIGITS
    assert PERSEUS_LEI not in cid
    # Same input, same id: the release has to be reproducible.
    assert cid == gleif.issuer_id(PERSEUS_LEI)
    assert cid != gleif.issuer_id(NESTLE_LEI)


def test_the_two_namespaces_cannot_collide():
    """`c_` is a CIK written out; `l_` is 16 hex digits. Neither can spell the other."""
    for cik in (1, 320193, 1652044, 9999999999):
        assert gleif.is_sec_company_id(f"c_{cik:010d}")
        assert not gleif.is_issuer_id(f"c_{cik:010d}")
    for lei in (PERSEUS_LEI, NESTLE_LEI, FUND_LEI):
        cid = gleif.issuer_id(lei)
        assert gleif.is_issuer_id(cid)
        assert not gleif.is_sec_company_id(cid)
    # Nothing that is not one of the two shapes is accepted.
    for bad in ("", "l_", "c_", "l_XYZ", "c_123", "l_" + "0" * 15, "c_" + "1" * 11):
        assert not gleif.is_issuer_id(bad)
        assert not gleif.is_sec_company_id(bad)


def test_display_name_reads_like_a_name():
    assert gleif.display_name("TOYOTA MOTOR CORPORATION") == "Toyota Motor Corporation"
    assert gleif.display_name("HSBC HOLDINGS PLC") == "HSBC Holdings PLC"
    assert gleif.display_name("NESTLÉ S.A.") == "Nestlé S.A."
    # A name that is already mixed case is left alone.
    assert gleif.display_name("Taiwan Semiconductor Manufacturing Co Ltd") == (
        "Taiwan Semiconductor Manufacturing Co Ltd"
    )


# --- refusals are decisions -------------------------------------------------


def test_a_fund_entity_is_refused_and_counted():
    """A collective investment vehicle is not an issuer: fund shares stay fund shares."""
    index = _issuers()
    assert index.resolve(FUND_LEI, None) is None
    assert index.refusals["fund_entity"] == 1


def test_an_lei_with_no_gleif_record_is_refused_and_counted():
    index = _issuers()
    assert index.resolve("549300E27V6N4OJCJ999", None) is None
    assert index.refusals["no_gleif_record"] == 1


def test_an_unmapped_isin_is_refused_and_counted():
    index = _issuers()
    assert index.resolve(None, "US0378331005") is None
    assert index.refusals["isin_unmapped"] == 1


def test_a_row_with_no_identifier_is_refused_and_counted():
    index = _issuers()
    assert index.resolve(None, None) is None
    assert index.refusals["no_identifier"] == 1


def test_the_rungs_stay_apart():
    """The filing's own LEI is direct evidence; the ISIN's LEI is inference."""
    index = _issuers()
    direct = index.resolve(PERSEUS_LEI, None)
    inferred = index.resolve(None, "AU000000PRU3")
    assert direct.rung == gleif.RUNG_LEI
    assert inferred.rung == gleif.RUNG_ISIN_LEI
    assert direct.company_id == inferred.company_id


# --- what the build does with a resolution ----------------------------------


def test_an_issuer_row_publishes_the_filing_label_and_no_ticker(index):
    issuers = _issuers()
    vector = weights.build_vector(
        [_holding("PERSEUS MINING LTD", 1_000_000.0, lei=PERSEUS_LEI, ticker="PRU")],
        index,
        1_000_000.0,
        lag_days=10,
        issuers=issuers,
    )
    row = vector.holdings[0]
    assert row.company_id == gleif.issuer_id(PERSEUS_LEI)
    assert vector.rung_counts[gleif.RUNG_LEI] == 1
    # The filing's own label is what ships; GLEIF only fills a name that is missing.
    assert row.name == "PERSEUS MINING LTD"
    # `PRU` is Perseus on the ASX and Prudential in New York. A local symbol beside a
    # global legal name is the misreading this namespace exists to prevent.
    assert row.ticker is None


def test_the_namespace_never_overrides_the_cik_ladder(index):
    """A US-listed row that the ladder maps keeps its CIK, LEI or no LEI."""
    issuers = _issuers(entities={PERSEUS_LEI: gleif.Entity(
        lei=PERSEUS_LEI, name="Perseus Mining Limited", status="ACTIVE",
        jurisdiction="AU", category="GENERAL",
    )})
    vector = weights.build_vector(
        [_holding("APPLE INC", 1_000_000.0, ticker="AAPL", lei=PERSEUS_LEI)],
        index,
        1_000_000.0,
        lag_days=10,
        issuers=issuers,
    )
    assert vector.holdings[0].company_id == APPLE
    assert vector.rung_counts["ticker"] == 1
    assert vector.rung_counts["lei_issuer"] == 0


def test_one_company_is_not_split_across_two_namespaces(index):
    """An LEI naming an SEC registrant resolves to that registrant's `c_` id.

    Without the bridge the same company appears twice — `c_` in the funds whose filing
    spells the EDGAR title, `l_` in the funds that use the new brand — and the ledger,
    which merges on `company_id`, would stop merging it.
    """
    issuers = _issuers(
        entities={
            PERSEUS_LEI: gleif.Entity(
                lei=PERSEUS_LEI,
                name="Apple Inc.",
                status="ACTIVE",
                jurisdiction="US",
                category="GENERAL",
            )
        }
    )
    vector = weights.build_vector(
        # The filing label matches no EDGAR title, so the ladder cannot map it — the
        # row reaches the namespace, whose entity is Apple, and must come back as Apple.
        [_holding("CALIFORNIA COMPUTER COMPANY", 1_000_000.0, lei=PERSEUS_LEI)],
        index,
        1_000_000.0,
        lag_days=10,
        issuers=issuers,
    )
    row = vector.holdings[0]
    assert row.company_id == APPLE
    assert issuers.bridges[gleif.RUNG_LEI] == 1


def test_no_identifier_reaches_the_published_row(index):
    """The artifact is the last gate: a CUSIP, an ISIN or an LEI must not survive it."""
    issuers = _issuers()
    vector = weights.build_vector(
        [
            _holding(
                "PERSEUS MINING LTD",
                1_000_000.0,
                lei=PERSEUS_LEI,
                isin="AU000000PRU3",
                cusip="713831105",
            )
        ],
        index,
        1_000_000.0,
        lag_days=10,
        issuers=issuers,
    )
    row = artifact.holding_row(
        company_id=vector.holdings[0].company_id,
        name=vector.holdings[0].name,
        ticker=vector.holdings[0].ticker,
        asset_cat=vector.holdings[0].asset_cat,
        weight_bp=vector.holdings[0].weight_bp,
    )
    for field in ("cusip", "isin", "lei"):
        assert field not in row
    blob = repr(row)
    for secret in (PERSEUS_LEI, "AU000000PRU3", "713831105"):
        assert secret not in blob


# --- the bridge's name rule -------------------------------------------------


def test_the_bridge_strips_edgar_jurisdiction_suffixes():
    index = CompanyIndex.from_document(
        {
            "0": {"cik_str": 909832, "ticker": "COST", "title": "COSTCO WHOLESALE CORP /NEW"},
            "1": {"cik_str": 70858, "ticker": "BAC", "title": "BANK OF AMERICA CORP /DE/"},
            "2": {"cik_str": 6951, "ticker": "AMAT", "title": "APPLIED MATERIALS INC /DE"},
        }
    )
    assert index.resolve_gleif_name("Costco Wholesale Corporation") == "c_0000909832"
    assert index.resolve_gleif_name("Bank of America Corporation") == "c_0000070858"
    assert index.resolve_gleif_name("Applied Materials, INC.") == "c_0000006951"
    # A foreign issuer is not an SEC registrant and must stay in its own namespace.
    assert index.resolve_gleif_name("Perseus Mining Limited") is None
    assert index.resolve_gleif_name("Nestlé S.A.") is None


def test_the_bridge_strips_adr_listing_markers():
    """An ADR line is the same issuer, and for most foreign issuers it is the only one.

    Measured 2026-10-30: 548 of EDGAR's ~12,000 operating-company titles carry a
    listing marker (``/ADR/``, ``/CAN``), and every l_ company whose SEC presence is
    only a sponsored ADR used to stay in the issuer namespace as a duplicate.
    """
    index = CompanyIndex.from_document(
        {
            "0": {"cik_str": 95227, "ticker": "SMTOY", "title": "SUMITOMO ELECTRIC INDUSTRIES LTD/ADR/"},
            "1": {"cik_str": 1969729, "ticker": "RKWBF", "title": "ROCKWOOL A/S/CAN"},
        }
    )
    assert index.resolve_gleif_name("Sumitomo Electric Industries, Ltd.") == "c_0000095227"
    assert index.resolve_gleif_name("Rockwool A/S") == "c_0001969729"
    # The ordinary line keeps working, and the marker never invents a match.
    assert index.resolve_gleif_name("Krones AG") is None


def test_strip_edgar_markers_removes_stacked_markers():
    """Whitespace is not the contract — the normalised key is, so compare that."""
    strip = companies.strip_edgar_markers
    key = lambda s: companies.normalize_name(strip(s))  # noqa: E731 - readability
    assert key("FOO CORP /DE/") == "foo"
    assert key("SUMITOMO ELECTRIC INDUSTRIES LTD/ADR/") == "sumitomo electric industries"
    # Stacked markers go in one pass each, including the " /DE/ ADR" shape.
    assert key("FOO CORP /DE/ ADR") == "foo"
    # A listing marker that is not at the end is text, not a marker.
    assert key("ADR INDUSTRIES CORP") == "adr industries"
    assert strip("A COMPANY NAME") == "A COMPANY NAME"


def test_the_bridge_refuses_when_two_registrants_share_a_name():
    index = CompanyIndex.from_document(
        {
            "0": {"cik_str": 1, "ticker": "AAA", "title": "SAME NAME CORP /DE/"},
            "1": {"cik_str": 2, "ticker": "BBB", "title": "SAME NAME CORP /MD/"},
        }
    )
    assert index.resolve_gleif_name("Same Name Corporation") is None


# --- the index the build loads ----------------------------------------------


def test_an_index_with_no_entities_refuses_everything():
    """An empty cache is a refusal, not a crash: the build's own gate refuses earlier."""
    empty = gleif.IssuerIndex({}, {}, cache_date="", source="test")
    assert empty.resolve(PERSEUS_LEI, "AU000000PRU3") is None
    assert empty.refusals["no_gleif_record"] == 1


@pytest.mark.parametrize(
    # Shape only: the LEI check digits are not verified here, so an all-digit string of
    # the right length passes — the corpus is the source, not user input.
    "bad", ["", "12345", "not-an-lei", PERSEUS_LEI[:17], PERSEUS_LEI + "0"]
)
def test_valid_lei_rejects_anything_that_is_not_an_lei(bad):
    assert not gleif.valid_lei(bad)


def test_valid_lei_accepts_a_lowercase_identifier():
    """Filings do carry lower-case LEIs; normalising is cheaper than refusing."""
    assert gleif.valid_lei(PERSEUS_LEI.lower())
    assert gleif.issuer_id(PERSEUS_LEI.lower()) == gleif.issuer_id(PERSEUS_LEI)
