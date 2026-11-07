"""The size lane: bands, the price tally, the mandate rules, and the artefact.

Four things can make this lane lie, and each has a test here:

* a cap computed from a stale share count, or from one class of a multi-class issuer —
  the age gate and the cover-page override are pinned;
* a band boundary read one dollar the wrong way;
* an inferred mandate that fires on a fund whose name names a *market* ("MSCI EAFE",
  "Total International") rather than a size;
* an identifier leaking into a browser-served object.

The network is faked at the two seams — ``fetch_frame_facts`` (the frames API) and
``_cover_shares`` (the cover-page lane) — so no test reaches EDGAR.
"""

from __future__ import annotations

import json
import re

import pytest

from pipeline import sizes

REPORT_DATE = "2026-06-30"
RELEASE = "2026-06-30.1"


def observations(rows):
    """``(company_id, value_usd, balance)`` → the tally's output shape."""
    for company_id, value, balance in rows:
        yield company_id, REPORT_DATE, value, balance


class Vector:
    """The two fields ``PriceTally.add_fund`` reads off a fund's holdings vector."""

    def __init__(self, holdings):
        self.holdings = holdings


class Holding:
    def __init__(self, company_id, value, balance, asset_cat="equity"):
        self.company_id = company_id
        self.asset_cat = asset_cat
        self.value_usd = value
        self.balance = balance


@pytest.fixture
def offline(monkeypatch):
    """No network: frames are empty and no cover page resolves, unless a test says so."""
    calls = {"frames": 0, "cover": []}

    def frames(dates, *, max_age=0):
        calls["frames"] += 1
        return {}

    def cover(cik):
        calls["cover"].append(cik)
        return None

    monkeypatch.setattr(sizes, "fetch_frame_facts", frames)
    monkeypatch.setattr(sizes, "_cover_shares", cover)
    return calls


class Cover:
    """A cover-page result, as ``cover_shares.latest_cover_shares`` returns one."""

    def __init__(self, shares, as_of="2026-10-21", classes=1, cik=0):
        self.shares = float(shares)
        self.as_of = as_of
        self.classes = classes
        self.basis = "instance"
        self.cik = cik


# -- bands --------------------------------------------------------------------


def test_bands_break_exactly_at_the_published_lines():
    # The lines are ours and published, so each boundary is tested on both sides:
    # "200bn and over" must not place 199,999,999,999 in mega.
    assert sizes.band_for(200_000_000_000) == "mega"
    assert sizes.band_for(199_999_999_999) == "large"
    assert sizes.band_for(10_000_000_000) == "large"
    assert sizes.band_for(9_999_999_999) == "mid"
    assert sizes.band_for(2_000_000_000) == "mid"
    assert sizes.band_for(1_999_999_999) == "small"
    assert sizes.band_for(300_000_000) == "small"
    assert sizes.band_for(299_999_999) == "micro"
    assert sizes.band_for(1) == "micro"


def test_band_tables_agree_with_each_other():
    assert sizes.BAND_ORDER == ("mega", "large", "mid", "small", "micro")
    assert set(sizes.BAND_LABELS) == set(sizes.BAND_ORDER)
    assert [key for key, _ in sizes.BANDS] == list(sizes.BAND_ORDER)
    # Descending floors, ending at zero so every positive cap lands somewhere.
    floors = [floor for _, floor in sizes.BANDS]
    assert floors == sorted(floors, reverse=True)
    assert floors[-1] == 0.0


def test_a_missing_or_nonsense_cap_has_no_band():
    assert sizes.band_for(None) is None
    assert sizes.band_for(0) is None
    assert sizes.band_for(-1) is None
    assert sizes.band_for(float("nan")) is None


# -- the price tally ----------------------------------------------------------


def test_tally_sums_value_and_balance_per_company():
    tally = sizes.PriceTally()
    tally.add_fund(
        Vector(
            [
                Holding("c_0000320193", 1_000.0, 10.0),
                Holding("c_0000320193", 500.0, 5.0),  # a second row, same company
                Holding("c_0000789019", 200.0, 0.0),  # no balance: no price
                Holding("c_0000320193", 999.0, 9.0, asset_cat="cash"),  # not equity
            ]
        ),
        REPORT_DATE,
    )
    rows = list(tally.observations())
    assert len(rows) == 1
    company_id, report_date, value, balance = rows[0]
    assert (company_id, report_date) == ("c_0000320193", REPORT_DATE)
    assert (value, balance) == (1_500.0, 15.0)
    assert value / balance == 100.0


def test_tally_keeps_report_dates_apart_so_the_latest_can_win():
    tally = sizes.PriceTally()
    tally.add_fund(Vector([Holding("c_0000320193", 100.0, 10.0)]), "2026-03-31")
    tally.add_fund(Vector([Holding("c_0000320193", 100.0, 10.0)]), REPORT_DATE)
    dates = sorted(date for _, date, _, _ in tally.observations())
    assert dates == ["2026-03-31", REPORT_DATE]


def test_tally_ignores_a_fund_with_no_report_date():
    tally = sizes.PriceTally()
    tally.add_fund(Vector([Holding("c_0000320193", 100.0, 10.0)]), "")
    assert len(tally) == 0


# -- the two lanes ------------------------------------------------------------


def test_cap_is_price_times_the_share_count_and_carries_both_dates(offline, monkeypatch):
    monkeypatch.setattr(
        sizes,
        "fetch_frame_facts",
        lambda dates, *, max_age=0: {"0000320193": [("2026-07-17", 14_594_180_000.0)]},
    )
    result = sizes.build(
        observations([("c_0000320193", 4_222_971_924.8, 14_594_180.0)]), release=RELEASE
    )
    cap = result.caps["c_0000320193"]
    assert cap.basis == "frame"
    assert cap.shares == 14_594_180_000
    assert cap.share_date == "2026-07-17"
    assert cap.report_date == REPORT_DATE
    assert cap.usd == pytest.approx(cap.price * cap.shares, rel=1e-9)
    assert cap.band == "mega"


def test_the_frame_facts_join_on_the_zero_padded_cik(offline, monkeypatch):
    # Measured defect on 2026-11-07: the frames payload keys on an integer CIK
    # ("320193") while company_id is ten digits ("c_0000320193"), and the first build
    # placed 0 of 9,070 companies because of it. The lookup is pinned here.
    seen = {}

    def frames(dates, *, max_age=0):
        seen["dates"] = list(dates)
        return {"0000320193": [("2026-07-17", 1_000.0)]}

    monkeypatch.setattr(sizes, "fetch_frame_facts", frames)
    result = sizes.build(observations([("c_0000320193", 100.0, 10.0)]), release=RELEASE)
    assert "c_0000320193" in result.caps
    assert seen["dates"] == [REPORT_DATE]


def test_a_share_count_older_than_the_window_is_refused(offline, monkeypatch):
    # The window is long for annual filers (400 days) but not unlimited: a two-year-old
    # count against a current price is not a market capitalisation.
    monkeypatch.setattr(
        sizes,
        "fetch_frame_facts",
        lambda dates, *, max_age=0: {"0000320193": [("2024-06-30", 14_594_180_000.0)]},
    )
    result = sizes.build(observations([("c_0000320193", 1_000.0, 10.0)]), release=RELEASE)
    assert result.caps == {}
    assert result.counts["no_shares"] == 1


def test_the_long_window_places_an_annual_filers_only_share_fact(offline, monkeypatch):
    # The measured reason for 400 days: a foreign private issuer's only dei fact sits on
    # its fiscal-year-end quarter, up to a year before the fund's report date.
    monkeypatch.setattr(
        sizes,
        "fetch_frame_facts",
        lambda dates, *, max_age=0: {"0001089113": [("2025-12-31", 17_000_000_000.0)]},
    )
    result = sizes.build(observations([("c_0001089113", 500.0, 100.0)]), release=RELEASE)
    cap = result.caps["c_0001089113"]
    assert cap.basis == "frame"
    assert cap.share_date == "2025-12-31"


def test_cover_page_lane_places_a_company_the_frame_lane_missed(offline, monkeypatch):
    monkeypatch.setattr(
        sizes, "_cover_shares", lambda cik: Cover(12_294_000_000.0, cik=1652044)
    )
    result = sizes.build(
        observations([("c_0001652044", 4_371_420_573.6, 12_294_000.0)]), release=RELEASE
    )
    cap = result.caps["c_0001652044"]
    assert cap.basis == "cover"
    assert cap.shares == 12_294_000_000
    assert result.counts["cover"] == 1


def test_cover_page_overrides_a_frame_count_that_disagrees_by_more_than_a_tenth(
    offline, monkeypatch
):
    # The measured Alphabet case: the frames endpoint publishes one class, the cover page
    # sums them all, and the sum is twice the single-class count.
    monkeypatch.setattr(
        sizes,
        "fetch_frame_facts",
        lambda dates, *, max_age=0: {"0001652044": [("2026-07-01", 5_800_000_000.0)]},
    )
    monkeypatch.setattr(
        sizes, "_cover_shares", lambda cik: Cover(12_294_000_000.0, cik=1652044)
    )
    result = sizes.build(
        observations([("c_0001652044", 4_371_420_573.6, 12_294_000.0)]), release=RELEASE
    )
    cap = result.caps["c_0001652044"]
    assert cap.basis == "cover"
    assert cap.shares == 12_294_000_000
    assert result.counts["cover_overrides"] == 1


def test_a_cover_count_within_a_tenth_keeps_the_frame_lane(offline, monkeypatch):
    monkeypatch.setattr(
        sizes,
        "fetch_frame_facts",
        lambda dates, *, max_age=0: {"0000320193": [("2026-07-17", 14_594_180_000.0)]},
    )
    monkeypatch.setattr(
        sizes, "_cover_shares", lambda cik: Cover(14_600_000_000.0, cik=320193)
    )
    result = sizes.build(observations([("c_0000320193", 1_000.0, 10.0)]), release=RELEASE)
    assert result.caps["c_0000320193"].basis == "frame"
    assert result.counts["cover_overrides"] == 0


def test_cover_lane_is_ranked_by_value_and_stops_at_its_limit(offline, monkeypatch):
    visited = []

    def cover(cik):
        visited.append(cik)
        return Cover(1_000.0, as_of=REPORT_DATE)

    monkeypatch.setattr(sizes, "_cover_shares", cover)
    rows = [
        (f"c_{cik:010d}", float(value), 10.0)
        for cik, value in ((1, 500.0), (2, 900.0), (3, 100.0))
    ]
    result = sizes.build(observations(rows), release=RELEASE, cover_limit=2)
    assert visited == ["0000000002", "0000000001"]  # biggest value first, no third lookup
    assert set(result.caps) == {"c_0000000002", "c_0000000001"}


def test_a_cover_lookup_that_raises_costs_one_company_not_the_release(offline, monkeypatch):
    def cover(cik):
        raise RuntimeError("EDGAR said no")

    monkeypatch.setattr(sizes, "_cover_shares", cover)
    result = sizes.build(observations([("c_0000000001", 1_000.0, 10.0)]), release=RELEASE)
    assert result.caps == {}


def test_an_l_prefixed_company_is_never_priced_by_either_lane(offline, monkeypatch):
    # A foreign issuer has no US cover page and no CIK-keyed frame fact. The lane says
    # so rather than guessing a share count from the fund's holdings.
    called = []
    monkeypatch.setattr(sizes, "_cover_shares", lambda cik: called.append(cik))
    result = sizes.build(
        observations([("l_5493000J7GF2VJYQ8F684", 1_000.0, 10.0)]), release=RELEASE
    )
    assert result.caps == {}
    assert called == []


def test_the_latest_report_date_wins_when_two_funds_price_the_same_company(
    offline, monkeypatch
):
    monkeypatch.setattr(
        sizes,
        "fetch_frame_facts",
        lambda dates, *, max_age=0: {"0000320193": [("2026-07-17", 1_000.0)]},
    )
    result = sizes.build(
        [
            ("c_0000320193", "2026-03-31", 100.0, 10.0),  # price 10.00
            ("c_0000320193", REPORT_DATE, 120.0, 10.0),  # price 12.00
        ],
        release=RELEASE,
    )
    cap = result.caps["c_0000320193"]
    assert cap.report_date == REPORT_DATE
    assert cap.price == pytest.approx(12.0)


def test_counts_partition_the_priced_universe(offline, monkeypatch):
    monkeypatch.setattr(
        sizes,
        "fetch_frame_facts",
        lambda dates, *, max_age=0: {
            "0000000001": [("2026-06-30", 1_000.0)],
            "0000000003": [("2026-06-30", 1_000.0)],
        },
    )
    result = sizes.build(
        observations(
            [
                ("c_0000000001", 100.0, 10.0),  # placed by frame
                ("c_0000000002", 100.0, 10.0),  # priced, no share count
                ("c_0000000003", 100.0, 10.0),  # placed by frame
                ("l_0000000004", 100.0, 10.0),  # outside both lanes
            ]
        ),
        release=RELEASE,
    )
    counts = result.counts
    assert counts["priced"] == 4
    assert counts["placed"] == 2
    assert counts["frame"] == 2
    assert counts["cover"] == 0
    assert counts["no_shares"] == 2
    assert counts["placed"] + counts["no_shares"] == counts["priced"]
    assert counts["companies"] == counts["priced"]


def test_a_company_with_no_usable_price_is_absent_rather_than_zero(offline):
    result = sizes.build(
        observations([("c_0000000001", 0.0, 10.0), ("c_0000000002", 100.0, 0.0)]),
        release=RELEASE,
    )
    # A row with no value or no balance is not a price and never enters the tally, so
    # it is absent from the artefact rather than published as a zero cap.
    assert result.caps == {}
    assert result.counts["companies"] == 0
    assert result.counts["priced"] == 0


# -- the published artefact ---------------------------------------------------


def test_the_artefact_publishes_bands_dates_and_no_identifier(
    offline, monkeypatch, tmp_path
):
    monkeypatch.setattr(
        sizes,
        "fetch_frame_facts",
        lambda dates, *, max_age=0: {"0000000001": [("2026-06-30", 1_000_000.0)]},
    )
    result = sizes.build(
        observations([("c_0000000001", 100.0, 10.0)]), release=RELEASE
    )
    path, body = sizes.write(result, tmp_path)
    assert path == tmp_path / "companies" / "sizes.json"
    document = json.loads(body)

    assert document["schema_version"] == 1
    assert document["kind"] == "sizes"
    assert document["as_of"] == RELEASE
    assert document["bands"] == list(sizes.BAND_ORDER)
    assert document["thresholds"] == {
        f"{key}cap": threshold for key, threshold in sizes.BANDS
    }
    assert document["price_basis"] == "nport_implied"
    assert document["counts"]["placed"] == 1
    assert set(document["band_counts"]) == set(sizes.BAND_ORDER)

    cap = document["caps"]["c_0000000001"]
    # Every cap carries the date of its share count and its price's report date: the
    # contract that keeps a market value from being read as a live quote.
    assert set(cap) == {
        "usd",
        "shares",
        "share_date",
        "price",
        "report_date",
        "basis",
        "band",
    }
    assert cap["share_date"] == "2026-06-30"
    assert cap["report_date"] == REPORT_DATE
    assert cap["band"] == "micro"  # 100.0 * 1,000,000 = 100m

    # A browser-served object: no CUSIP, no ISIN, no ticker. The only identifiers are
    # the release's own company ids.
    text = body.decode()
    assert "cusip" not in text.lower()
    assert "isin" not in text.lower()
    assert re.search(r"\b[A-Z]{2}[A-Z0-9]{9}[0-9]\b", text) is None
    for company_id in document["caps"]:
        assert re.fullmatch(r"c_\d{10}", company_id), company_id


def test_the_artefact_is_byte_identical_for_the_same_input(offline, monkeypatch, tmp_path):
    monkeypatch.setattr(
        sizes,
        "fetch_frame_facts",
        lambda dates, *, max_age=0: {"0000000001": [("2026-06-30", 1_000_000.0)]},
    )
    rows = [("c_0000000001", 100.0, 10.0), ("c_0000000002", 200.0, 10.0)]
    first = sizes.write(sizes.build(observations(rows), release=RELEASE), tmp_path / "a")
    second = sizes.write(sizes.build(observations(rows), release=RELEASE), tmp_path / "b")
    assert first[1] == second[1]


# -- the international lane ---------------------------------------------------


@pytest.mark.parametrize(
    "name,expected",
    [
        # An international index mandate is large-and-mid by construction, and the
        # biggest international funds are exactly these names.
        ("iShares MSCI EAFE ETF", "large_mid"),
        ("Vanguard Total International Stock Index Fund", "large_mid"),
        ("iShares Core MSCI Emerging Markets ETF", "large_mid"),
        ("Vanguard Small-Cap Index Fund", "small"),
        ("iShares MSCI EAFE Small-Cap ETF", "small"),
        ("iShares Russell 2000 ETF", "small"),
        ("SPDR S&P 600 Small Cap ETF", "small"),
        ("Vanguard Mid-Cap Index Fund", "mid"),
        ("iShares Russell Mid-Cap ETF", "mid"),
        ("Vanguard Mega Cap Index Fund", "large"),  # a mega mandate calibrates as large
        ("Vanguard Large-Cap Index Fund", "large"),
        ("iShares S&P 500 Index Fund", "large"),
        ("Vanguard Micro Cap Index Fund", "micro"),
        ("Fidelity Large Cap Growth Fund", "large"),
        ("Invesco S&P 400 Midcap ETF", "mid"),
        ("Vanguard Nasdaq-100 Index Fund", "large"),
    ],
)
def test_a_stated_size_mandate_is_inferred(name, expected):
    mandate = sizes.mandate_for(name)
    assert mandate is not None, name
    assert mandate.key == expected


@pytest.mark.parametrize(
    "name",
    [
        "Vanguard Total World Stock Index Fund",
        "iShares Core S&P Total US Stock Market ETF",
        "Vanguard Extended Market Index Fund",
        "Fidelity 500 Index Fund",
        "Vanguard Balanced Index Fund",
        "iShares Core U.S. Aggregate Bond ETF",
    ],
)
def test_a_broad_or_absent_mandate_infers_nothing(name):
    # All-cap, whole-market, total-world and aggregate-bond names make no single size
    # statement. Inferring one from them would be the exact error this lane avoids.
    assert sizes.mandate_for(name) is None


def test_every_inferred_mandate_has_a_label_and_calibrated_ranges():
    for key in sizes.MANDATE_MIX:
        assert key in sizes.MANDATE_LABELS
        ranges = sizes.mix_ranges(key)
        assert set(ranges) <= set(sizes.BAND_ORDER)
        for band, (low, high) in ranges.items():
            assert 0 <= low <= high <= 100, (key, band)
        # Ranges are the 10th-to-90th percentile of a measured mix, so they overlap
        # rather than partition: that is the honest shape of a fund-level inference.
        assert sum(low for low, _ in ranges.values()) <= 100

