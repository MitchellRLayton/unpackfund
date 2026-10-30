"""The name rule, bucket by bucket and trap by trap.

Every case is a filed fund name and the bucket its words promise, so the file can
be checked by reading it: ``classify`` is offline, deterministic, and takes only
the name (the issuer argument is accepted so callers can pass it, and is never
allowed to decide anything).

The last three tests are the invariants that must hold for *any* name, not just
the fixtures: closed vocabularies, a key in the documented grammar, and
``matched`` naming tokens the name actually contains.
"""

from __future__ import annotations

import re
from dataclasses import FrozenInstanceError

import pytest

from pipeline.style import (
    ALL_CAP,
    ALLOCATION,
    BLEND,
    COMMODITY,
    DEVELOPED,
    EMERGING,
    EQUITY,
    FIXED_INCOME,
    GLOBAL,
    GROUPS,
    GROWTH,
    LARGE,
    MID,
    MONEY_MARKET,
    OTHER,
    REAL_ESTATE,
    REGIONS,
    SINGLE_COUNTRY,
    SIZES,
    SMALL,
    STYLES,
    Style,
    US,
    VALUE,
    classify,
    normalise,
)

#: ``key`` is lower-kebab: the grammar documented in the module docstring.
KEY_GRAMMAR = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def bucket(name: str, issuer: str = "") -> Style:
    """``classify`` with the "this name has a bucket" assumption the cases make."""
    result = classify(name, issuer)
    assert result is not None, f"expected a bucket for {name!r}"
    return result


# --- one case per bucket family ----------------------------------------------


@pytest.mark.parametrize(
    ("name", "key", "group"),
    [
        ("Vanguard Small-Cap Value ETF", "us-small-value", EQUITY),
        ("iShares National Muni Bond ETF", "us-municipal-bond", FIXED_INCOME),
        ("Vanguard Target Retirement 2040 Fund", "target-date", ALLOCATION),
        ("SPDR Gold Shares", "gold", COMMODITY),
        ("Vanguard Real Estate ETF", "us-real-estate", REAL_ESTATE),
        ("Vanguard Federal Money Market Fund", "money-market", MONEY_MARKET),
        ("Vanguard Real Assets Fund", "real-assets", OTHER),
    ],
)
def test_each_bucket_family_gets_a_bucket(name, key, group):
    """Seven groups, seven buckets, one representative name each."""
    style = bucket(name)
    assert (style.key, style.group) == (key, group)


# --- the 3×3 grid ------------------------------------------------------------


@pytest.mark.parametrize(
    ("name", "size", "style_value"),
    [
        ("Dimensional U.S. Small Cap Value ETF", SMALL, VALUE),
        ("iShares Russell 2000 ETF", SMALL, BLEND),
        ("iShares Russell 2000 Growth ETF", SMALL, GROWTH),
        ("iShares Russell Mid-Cap Value ETF", MID, VALUE),
        ("iShares Core S&P Mid-Cap ETF", MID, BLEND),
        ("iShares S&P Mid-Cap 400 Growth ETF", MID, GROWTH),
        ("iShares Russell 1000 Value ETF", LARGE, VALUE),
        ("SPDR S&P 500 ETF Trust", LARGE, BLEND),
        ("iShares Russell 1000 Growth ETF", LARGE, GROWTH),
        ("Vanguard Total Stock Market ETF", ALL_CAP, BLEND),
    ],
)
def test_the_nine_cells_of_the_style_grid(name, size, style_value):
    """Size and style are fields, and the key spells them out for a plain fund."""
    style = bucket(name)
    assert (style.size, style.style) == (size, style_value)
    assert style.key == f"us-{size}-{style_value}"
    assert style.region == US


@pytest.mark.parametrize(
    ("name", "size", "style_value"),
    [
        ("S&P 600 Index Fund", SMALL, BLEND),
        ("Russell 2000 Index Fund", SMALL, BLEND),
        ("S&P 500 Index Fund", LARGE, BLEND),
        ("Russell 1000 Index Fund", LARGE, BLEND),
        ("Russell 3000 Index Fund", ALL_CAP, BLEND),
        ("Nasdaq-100 Index Fund", LARGE, GROWTH),
        ("Dow Jones Industrial Average ETF", LARGE, BLEND),
        ("Vanguard Total Stock Market ETF", ALL_CAP, BLEND),
    ],
)
def test_benchmark_names_imply_a_band_without_the_word_cap(name, size, style_value):
    """Nobody writes "S&P 500 Blend"; the index is the benchmark for that cell."""
    style = bucket(name)
    assert (style.size, style.style) == (size, style_value)


# --- the traps ---------------------------------------------------------------


def test_value_line_is_an_issuer_not_a_value_fund():
    """Nine funds carry the brand; none of them is selling the value style as such."""
    style = bucket("First Trust Value Line Dividend Index Fund")
    assert style.theme == "dividend"
    assert style.style is None
    assert "VALUE LINE" not in style.matched
    # the word on its own still is a style
    assert bucket("Vanguard Value Index Fund").style == VALUE


def test_growth_and_income_is_its_own_bucket():
    """"Growth & Income" is neither column: it holds both, so it is blend."""
    style = bucket("Fidelity Growth & Income Fund")
    assert style.key == "us-equity-income"
    assert style.theme == "equity income"
    assert style.style == BLEND
    assert bucket("T. Rowe Price Equity Income Fund").key == "us-equity-income"
    # plain "Growth" is still a growth fund
    assert bucket("Fidelity Growth Company Fund").style == GROWTH


def test_sector_rotation_is_a_strategy_not_a_sector():
    style = bucket("Sector Rotation Fund")
    assert style.theme is None
    assert style.key == "us-equity"


def test_megatrends_is_not_mega_cap():
    style = bucket("Lazard Equity Megatrends ETF")
    assert style.size is None
    assert style.group == EQUITY


def test_global_x_is_an_issuer_not_a_region():
    """The brand says "Global X", the mandate says U.S. technology."""
    style = bucket("Global X Technology ETF")
    assert style.region == US
    assert style.key == "us-information-technology"


def test_dow_jones_industrial_average_is_an_index_not_a_sector():
    """The index name contains "Industrial"; the fund is not an industrials fund."""
    style = bucket("SPDR Dow Jones Industrial Average ETF Trust")
    assert style.key == "us-large-blend"
    assert style.theme is None
    assert "DOW JONES INDUSTRIAL" in style.matched


def test_index_brands_are_not_a_region_claim():
    """"Dow Jones" and "Nasdaq" name indexes that also exist abroad."""
    assert bucket("First Trust Dow Jones International Internet ETF").region == DEVELOPED


def test_former_name_tail_is_discarded():
    """``F/K/A …`` is the fund's old name, not a second mandate."""
    assert bucket("Vanguard Small Cap Value Fund F/K/A Old Name") == bucket(
        "Vanguard Small Cap Value Fund"
    )


def test_bare_income_is_a_bond_fund_only_after_equity_words():
    assert bucket("Madison Diversified Income Fund").group == FIXED_INCOME
    assert bucket("Fidelity Dividend Income Fund").theme == "dividend"


def test_state_name_with_bond_context_is_municipal():
    """A state name is a municipal claim only when the name also claims debt."""
    assert bucket("AB New York Portfolio").key == "us-municipal-bond"
    assert bucket("AB California Portfolio").key == "us-municipal-bond"
    assert bucket("Victory California Bond Fund").key == "us-municipal-bond"
    # an equity trust that happens to be named after a state is not municipal debt
    assert classify("Massachusetts Investors Trust") is None


def test_new_mexico_is_a_state_not_a_country():
    """A state named after a country must not import the country."""
    assert bucket("Nuveen New Mexico Municipal Bond Fund").key == "us-municipal-bond"
    assert bucket("iShares MSCI Mexico ETF").key == "mexico-equity"


def test_issuer_brand_that_reads_like_a_place_is_stripped():
    """Pacific Capital and Frontier Asset are advisers, not regions."""
    assert bucket("Pacific Capital Tax-Free Securities Fund").key == "us-municipal-bond"
    assert bucket("Frontier Asset Core Bond ETF").key == "us-core-bond"


def test_a_bare_500_is_the_sp_500_not_every_country_index():
    assert bucket("Vanguard 500 Index Fund").key == "us-large-blend"
    assert bucket("Xtrackers Harvest CSI 500 China A-Shares Small Cap ETF").size == SMALL
    assert bucket("Xtrackers Nifty 500 India ETF").region == SINGLE_COUNTRY


def test_narrowest_fixed_income_family_wins():
    """A short-term Treasury fund is a Treasury fund before it is a short fund."""
    assert bucket("Vanguard Short-Term Treasury ETF").key == "us-treasury-bond"
    assert bucket("iShares iBoxx $ High Yield Corporate Bond ETF").key == "us-high-yield-bond"
    assert bucket("Vanguard Short-Term Inflation-Protected Securities ETF").key == (
        "us-inflation-protected-bond"
    )


def test_options_overlay_outranks_the_index_under_it():
    """*Technology Covered Call* belongs with the other covered-call funds."""
    assert bucket("JPMorgan Equity Premium Income ETF").key == "us-covered-call"
    assert bucket("FT Vest U.S. Equity Buffer ETF").key == "us-buffered-outcome"


def test_clean_energy_is_not_the_energy_sector():
    assert bucket("iShares Global Clean Energy ETF").key == "global-clean-energy"
    assert bucket("Energy Select Sector SPDR Fund").key == "us-energy"


# --- None is a result --------------------------------------------------------


@pytest.mark.parametrize(
    "name",
    [
        "Fidelity Magellan Fund",
        "Heritage Fund",
        "Select Fund",
        "Teberg Fund",
        "Columbia Acorn Fund",
        "Invesco Comstock Fund",
        "FPA Crescent Fund",
    ],
)
def test_vague_name_is_none_not_a_guess(name):
    """A name that promises nothing gets no bucket; the page falls back to issuer links."""
    assert classify(name) is None


# --- the issuer is inert -----------------------------------------------------


def test_issuer_never_decides_anything():
    """The brand is not evidence: same name, same bucket, whatever the issuer is."""
    assert bucket("Small Cap Value ETF") == bucket("Small Cap Value ETF", "Vanguard")
    assert bucket("Growth Fund") == bucket("Growth Fund", "Fidelity")
    # even an issuer whose brand reads like a style word changes nothing
    assert bucket("Growth Fund", "Value Line").style == GROWTH


# --- case and punctuation are not signal -------------------------------------


@pytest.mark.parametrize(
    "variant",
    [
        "VANGUARD SMALL CAP VALUE ETF",
        "vanguard small-cap value etf",
        "Vanguard  Small (Cap)  Value (R) ETF",
        "Vanguard Small-Cap Value ETF (TM)",
        "Vanguard Small/Cap Value ETF",
    ],
)
def test_case_and_punctuation_are_not_signal(variant):
    assert bucket(variant) == bucket("Vanguard Small-Cap Value ETF")


# --- invariants over a spread of names ---------------------------------------

SAMPLE = [
    "Vanguard Small-Cap Value ETF",
    "iShares Russell 2000 ETF",
    "SPDR S&P 500 ETF Trust",
    "Vanguard Total Stock Market ETF",
    "iShares MSCI EAFE ETF",
    "iShares MSCI Emerging Markets ETF",
    "iShares China Large-Cap ETF",
    "iShares MSCI Japan ETF",
    "Vanguard Global Equity Fund",
    "Invesco S&P 500 Low Volatility ETF",
    "Invesco Dorsey Wright Momentum ETF",
    "iShares MSCI USA Quality Factor ETF",
    "iShares ESG Aware MSCI USA ETF",
    "Invesco S&P 500 Equal Weight ETF",
    "ProShares Buyback Achievers ETF",
    "iShares Semiconductor ETF",
    "First Trust NASDAQ-100 Technology Sector Index Fund",
    "iShares U.S. Healthcare Providers ETF",
    "SPDR S&P Regional Banking ETF",
    "Energy Select Sector SPDR Fund",
    "Utilities Select Sector SPDR Fund",
    "Consumer Staples Select Sector SPDR Fund",
    "iShares U.S. Aerospace & Defense ETF",
    "iShares U.S. Real Estate ETF",
    "iShares Global Infrastructure ETF",
    "iShares Mortgage Real Estate ETF",
    "iShares Global Clean Energy ETF",
    "Global X Blockchain ETF",
    "Direxion Daily S&P 500 Bull 2X Shares",
    "Vanguard Short-Term Treasury ETF",
    "iShares National Muni Bond ETF",
    "iShares iBoxx High Yield Corporate Bond ETF",
    "iShares Convertible Bond ETF",
    "iShares Preferred and Income Securities ETF",
    "iShares Floating Rate Bond ETF",
    "Fidelity AAA CLO ETF",
    "iShares Core Bond Fund",
    "Vanguard Total International Bond ETF",
    "iShares J.P. Morgan USD Emerging Markets Bond ETF",
    "Vanguard Target Retirement 2040 Fund",
    "Vanguard LifeStrategy Moderate Growth Fund",
    "iShares Morningstar Multi-Asset Income ETF",
    "SPDR Gold Shares",
    "iShares Silver Trust",
    "United States Oil Fund",
    "Invesco DB Agriculture Fund",
    "Vanguard Federal Money Market Fund",
    "Vanguard Real Assets Fund",
]


@pytest.mark.parametrize("name", SAMPLE)
def test_vocabularies_are_closed_and_keys_follow_the_grammar(name):
    """Every emitted value is one the interface promises, and the key is kebab."""
    style = bucket(name)
    assert style.group in GROUPS
    assert style.region is None or style.region in REGIONS
    assert style.size is None or style.size in SIZES
    assert style.style is None or style.style in STYLES
    assert KEY_GRAMMAR.match(style.key), style.key
    assert style.label.strip() == style.label and style.label


@pytest.mark.parametrize("name", SAMPLE)
def test_matched_names_tokens_the_name_actually_contains(name):
    """Each recorded token is text from the filed name, not a code or an inference."""
    style = bucket(name)
    assert style.matched, f"{name!r} was classified with no evidence"
    text = normalise(name)
    for token in style.matched:
        assert token == token.upper()
        assert token in text, f"{token!r} is not in {text!r}"


def test_theme_buckets_keep_the_grid_as_fields():
    """A theme bucket does not multiply the key, but the 3×3 read stays available."""
    style = bucket("Invesco S&P 500 Low Volatility ETF")
    assert style.key == "us-low-volatility"
    assert (style.size, style.style) == (LARGE, BLEND)


def test_region_only_equity_gets_an_equity_key():
    """A broad name still makes a bucket: "{region}-equity", not a bare region."""
    assert bucket("Sector Rotation Fund").key == "us-equity"
    assert bucket("Vanguard Global Equity Fund").key == "global-equity"
    assert bucket("iShares MSCI Japan ETF").region == SINGLE_COUNTRY
    assert bucket("iShares MSCI Japan ETF").key == "japan-equity"


def test_single_country_keys_carry_the_country():
    assert bucket("iShares China Large-Cap ETF").key == "china-large"
    assert bucket("iShares China Large-Cap ETF").region == SINGLE_COUNTRY
    # a region word, not a country word, is the broader bucket
    assert bucket("iShares MSCI EAFE ETF").key == "developed-equity"
    assert bucket("iShares MSCI Emerging Markets ETF").key == "emerging-equity"


def test_style_is_frozen_and_repeatable():
    first = bucket("iShares Russell 2000 ETF")
    assert first == bucket("iShares Russell 2000 ETF")
    assert (first.key, first.label) == ("us-small-blend", "U.S. small cap blend")
    with pytest.raises(FrozenInstanceError):
        first.key = "something-else"  # type: ignore[misc]
