"""The typed-symbol object: what a symbol maps to, and what it refuses.

The real file has four fields and no instrument type, so every rule here is
either exact (the symbol is a fund, the company has an ``l_`` twin) or a
conservative shape rule that is allowed to refuse and never to accept. These
tests pin the measured examples from the planning memo, because a false accept
merges two companies and a false refusal only costs a retype.
"""

from __future__ import annotations

import json

import pytest

from pipeline import catalogue, securities


def _document(rows: list[tuple[int, str, str, str | None]]) -> dict:
    """EDGAR's own positional shape, which is what the parser has to handle."""
    return {
        "fields": ["cik", "name", "ticker", "exchange"],
        "data": [[cik, name, ticker, exchange] for cik, name, ticker, exchange in rows],
    }


LIVE = _document(
    [
        (1018724, "AMAZON COM INC", "AMZN", "Nasdaq"),
        (1067983, "BERKSHIRE HATHAWAY INC", "BRK-A", "NYSE"),
        (1067983, "BERKSHIRE HATHAWAY INC", "BRK-B", "NYSE"),
        (72971, "WELLS FARGO & COMPANY/MN", "WFC", "NYSE"),
        (72971, "WELLS FARGO & COMPANY/MN", "WFC-PZ", "NYSE"),
        (1045810, "NVIDIA CORP", "NVDA", "Nasdaq"),
        (2009183, "Titan Acquisition Corp.", "TACH", "Nasdaq"),
        (2009183, "Titan Acquisition Corp.", "TACHW", "Nasdaq"),
        (2089982, "HCM IV Acquisition Corp.", "HACQ", "Nasdaq"),
        (2089982, "HCM IV Acquisition Corp.", "HACQU", "Nasdaq"),
        (1839341, "CORZ Inc.", "CORZ", "Nasdaq"),
        (1839341, "CORZ Inc.", "CORZR", "Nasdaq"),
        (884394, "SPDR S&P 500 ETF TRUST", "SPY", "NYSE"),
        (927971, "BANK OF MONTREAL /CAN/", "BMO", "NYSE"),
        (927971, "BANK OF MONTREAL /CAN/", "FNGU", "NYSE"),
        (16737, "CARNIVAL PLC", "CUK", "NYSE"),
        (1090727, "UNITED PARCEL SERVICE INC", "UPS", "NYSE"),
        (57083, "KYOCERA CORP", "KYOAY", "OTC"),
    ]
)


def test_rows_parses_edgars_positional_format():
    parsed = securities.rows(LIVE)
    assert len(parsed) == len(LIVE["data"])
    assert parsed[0] == {
        "cik": 1018724,
        "name": "AMAZON COM INC",
        "ticker": "AMZN",
        "exchange": "Nasdaq",
    }


def test_rows_refuses_a_document_that_is_not_the_expected_shape():
    with pytest.raises(ValueError, match="no fields/data"):
        securities.rows({"fields": [], "data": []})
    with pytest.raises(ValueError, match="missing"):
        securities.rows({"fields": ["cik", "ticker"], "data": [[1, "A"]]})


def test_common_stock_and_adr_are_accepted():
    symbols = frozenset(row[2] for row in LIVE["data"])
    for symbol in ("AMZN", "NVDA", "BRK-A", "BRK-B", "UPS", "KYOAY", "CUK"):
        assert securities.classify(
            symbol, symbols=symbols, fund_tickers=frozenset()
        ) == securities.STATUS_OK, symbol


def test_a_fund_ticker_is_refused_even_though_it_is_in_the_file():
    symbols = frozenset(row[2] for row in LIVE["data"])
    status = securities.classify(
        "SPY", symbols=symbols, fund_tickers=frozenset({"SPY", "SPCX"})
    )
    assert status == securities.STATUS_FUND


def test_a_preferred_series_is_refused_and_a_share_class_is_not():
    symbols = frozenset(row[2] for row in LIVE["data"])
    assert (
        securities.classify("WFC-PZ", symbols=symbols, fund_tickers=frozenset())
        == securities.STATUS_PREFERRED
    )
    # BRK-A is a class of common stock, not a preferred series: the suffix is
    # "-A", and the rule must not treat every hyphen as a series.
    assert (
        securities.classify("BRK-A", symbols=symbols, fund_tickers=frozenset())
        == securities.STATUS_OK
    )


def test_warrant_unit_and_right_need_the_base_symbol_to_be_listed():
    symbols = frozenset(row[2] for row in LIVE["data"])
    statuses = {
        symbol: securities.classify(symbol, symbols=symbols, fund_tickers=frozenset())
        for symbol in ("TACHW", "HACQU", "CORZR")
    }
    assert statuses == {
        "TACHW": securities.STATUS_WARRANT,
        "HACQU": securities.STATUS_UNIT,
        "CORZR": securities.STATUS_RIGHT,
    }
    # Without the stem in the file the shape is not enough to refuse: an ordinary
    # five-letter ticker ending in W must still be accepted.
    assert (
        securities.classify("ABCDW", symbols=symbols, fund_tickers=frozenset())
        == securities.STATUS_OK
    )


def test_an_exchange_traded_note_is_a_known_limit_not_a_silent_accept():
    """FNGU is BMO's note; the file reports it like a listed share of BMO.

    The docstring in the module records this. The test states the behaviour so a
    later session cannot believe the refusal rule covers it.
    """
    symbols = frozenset(row[2] for row in LIVE["data"])
    assert (
        securities.classify("FNGU", symbols=symbols, fund_tickers=frozenset())
        == securities.STATUS_OK
    )


def test_build_emits_the_published_company_id_and_keeps_edgars_name():
    built = securities.build(LIVE)
    assert built["AMZN"] == ["c_0001018724", "AMAZON COM INC", "Nasdaq", securities.STATUS_OK]
    assert built["SPY"][0] == "c_0000884394"
    # Sorted, so two builds of the same file are byte-identical.
    assert list(built) == sorted(built)


def test_build_refuses_a_company_that_also_lives_in_the_lei_namespace():
    twins = securities.twin_names(
        [
            ["c_0000095227", "SUMITOMO ELECTRIC INDUSTRIES LTD", "SMTOY", 1],
            ["l_b36e4a167d84ac7c", "SUMITOMO ELECTRIC INDUSTRIES, LTD.", None, 227],
        ]
    )
    built = securities.build(
        _document([(95227, "SUMITOMO ELECTRIC INDUSTRIES LTD", "SMTDY", "OTC")]),
        twins=twins,
    )
    assert built["SMTDY"][3] == securities.STATUS_TWIN


def test_build_drops_a_duplicate_symbol_keeping_the_first_row():
    document = _document(
        [(1, "FIRST CORP", "DUP", "NYSE"), (2, "SECOND CORP", "DUP", "Nasdaq")]
    )
    built = securities.build(document)
    assert built["DUP"][0] == "c_0000000001"


def test_shards_are_first_letter_and_underscore_for_the_rest():
    built = securities.build(
        _document([(1, "A CORP", "AAA", "NYSE"), (2, "B CORP", "1234", None)])
    )
    grouped = securities.shards(built)
    # A digit-leading symbol has no letter shard, so it lands with the rest — the
    # same rule the fund index uses.
    assert sorted(grouped) == ["A", catalogue.SHARD_OTHER]
    assert list(grouped["A"]["securities"]) == ["AAA"]


def test_counts_publish_the_refusal_rate():
    built = securities.build(LIVE, fund_tickers=["SPY"])
    tally = securities.counts(built)
    assert tally[securities.STATUS_OK] >= 10
    assert tally[securities.STATUS_FUND] == 1
    assert tally[securities.STATUS_PREFERRED] == 1


def test_write_release_objects_names_the_release_in_every_shard(tmp_path):
    built = securities.build(LIVE, fund_tickers=["SPY"])
    result = securities.write_release_objects(tmp_path, release="2026-11-01.1", securities=built)

    assert result["objects"]["count"] == len(built)
    assert result["objects"]["prefix"] == "securities/"
    # The descriptor's shard map is exactly the shards the symbols produce, and each
    # entry names the bytes on disk (I6: a fetched object must be checkable).
    assert sorted(result["objects"]["shards"]) == sorted(
        {securities.shard_for(symbol) for symbol in built}
    )
    shard = result["objects"]["shards"]["A"]
    body = (tmp_path / "securities" / "A.json").read_bytes()
    assert shard["bytes"] == len(body)
    assert shard["sha256"] == __import__("hashlib").sha256(body).hexdigest()
    assert result["objects"]["statuses"]["fund"] == 1

    for shard in sorted(result["objects"]["shards"]):
        written = json.loads((tmp_path / "securities" / f"{shard}.json").read_text())
        assert written["as_of"] == "2026-11-01.1"
        assert written["source_url"] == securities.SECURITIES_URL
        assert written["securities"]


def test_the_written_bytes_round_trip_every_symbol(tmp_path):
    built = securities.build(LIVE, fund_tickers=["SPY"])
    securities.write_release_objects(tmp_path, release="2026-11-01.1", securities=built)
    read_back: dict[str, list] = {}
    for path in sorted((tmp_path / "securities").glob("*.json")):
        read_back.update(json.loads(path.read_text())["securities"])
    assert read_back == built


def test_a_release_with_the_object_describes_it_and_validates(tmp_path, capsys):
    from pipeline import validate
    from tests.conftest import fund_document, write_release

    document = fund_document()
    release_dir = write_release(
        tmp_path, [document], securities_source=LIVE
    )
    descriptor = json.loads((release_dir / "release.json").read_text())
    declared = descriptor["objects"]["securities"]
    assert declared["count"] == len(LIVE["data"])
    assert declared["statuses"]["pfd"] == 1
    assert (release_dir / "securities").is_dir()

    assert validate.validate(release_dir) == 0, capsys.readouterr().out


def test_a_release_without_the_object_is_still_valid(tmp_path, capsys):
    from pipeline import validate
    from tests.conftest import fund_document, write_release

    release_dir = write_release(tmp_path, [fund_document()])
    descriptor = json.loads((release_dir / "release.json").read_text())
    assert "securities" not in descriptor["objects"]
    assert validate.validate(release_dir) == 0, capsys.readouterr().out


def test_the_validator_fails_a_symbol_that_cannot_be_typed_back(tmp_path, capsys):
    from pipeline import validate
    from tests.conftest import fund_document, write_release

    release_dir = write_release(tmp_path, [fund_document()], securities_source=LIVE)
    # A lower-case symbol would pass nothing in the browser: the fragment regex
    # refuses it, so the link could not be rebuilt from the same object.
    path = sorted((release_dir / "securities").glob("*.json"))[0]
    body = json.loads(path.read_text())
    body["securities"]["amzn"] = body["securities"].pop(sorted(body["securities"])[0])
    path.write_text(json.dumps(body))

    assert validate.validate(release_dir) == 1
    assert "securities.shape" in capsys.readouterr().out
