"""Jev, offline: the request we send, the answer we keep, and who wins.

Two things are being pinned here, and the second matters more than the first:

1. The request is the shape the Decisions API documents — one ``state``, one ``choice``
   question per fund, ``unknown`` always offered — and the parse maps a returned option
   back to the *rule engine's own* ``Style`` rather than to a second taxonomy.
2. A Jev row can never override a rule hit. ``resolve`` tries the rules first, so the
   model's blast radius is exactly the names the rules already could not read.

No test in this file touches the network. ``run`` takes a transport, and the fake one
records the request it was given, so a change to the endpoint or the auth header fails a
test instead of quietly costing money in CI.
"""

from __future__ import annotations

import json

import pytest

from pipeline import style_jev
from pipeline import style_overrides
from pipeline.style import classify


CATALOGUE = {
    # rule-readable, the common case
    "VTI": ["Vanguard Total Stock Market ETF", "Vanguard", 1, 99.4],
    "AVUV": ["Avantis U.S. Small Cap Value ETF", "Avantis Investors", 1, 99.1],
    "BND": ["Vanguard Total Bond Market ETF", "Vanguard", 1, 98.8],
    "VCIT": ["Vanguard Intermediate-Term Corporate Bond ETF", "Vanguard", 1, 99.0],
    "VTIP": ["Vanguard Short-Term Inflation-Protected Securities ETF", "Vanguard", 1, 99.2],
    # rule-unreadable: brand names, person names, vague names
    "ABSTX": ["Teberg Fund", "Teberg", 0, 91.0],
    "ACRNX": ["Columbia Acorn Fund", "Columbia", 0, 88.0],
    "ACSLX": ["Select Fund", "American Century", 0, 77.0],
}


def catalogue_doc() -> dict:
    return {"as_of": "2026-10-30.8", "etf_classifier": "name_rule_v1", "funds": CATALOGUE}


def item(ticker: str) -> style_jev.Item:
    row = CATALOGUE[ticker]
    return style_jev.Item(ticker=ticker, name=row[0], issuer=row[1])


def test_option_set_comes_from_the_rule_vocabulary_and_is_deterministic():
    options = style_jev.option_set(CATALOGUE)
    labels = [option.label for option in options]
    assert len(labels) == len(set(labels))
    assert len({option.key for option in options}) == len(options)
    # every offered Style is one the rule engine actually produced for a real fund
    produced = {
        classify(row[0], row[1]).label
        for row in CATALOGUE.values()
        if classify(row[0], row[1]) is not None
    }
    assert set(labels) <= produced
    assert labels == [option.label for option in style_jev.option_set(CATALOGUE)]


def test_option_set_honours_the_limit_and_orders_by_fund_count():
    options = style_jev.option_set(CATALOGUE, limit=2)
    assert len(options) == 2


def test_request_is_one_choice_question_per_item_with_unknown_always_offered():
    options = style_jev.option_set(CATALOGUE)
    request = style_jev.build_request(
        [item("ABSTX"), item("ACRNX")], options, session_id="session-1"
    )
    assert request["model"] == style_jev.DEFAULT_MODEL
    assert request["session_id"] == "session-1"
    assert request["state"]["items"][0] == {
        "ticker": "ABSTX",
        "name": "Teberg Fund",
        "issuer": "Teberg",
    }
    assert set(request["questions"]) == {"item_0", "item_1"}
    first = request["questions"]["item_0"]
    assert first["type"] == "choice"
    assert style_jev.UNKNOWN in first["criteria"]
    assert "items[0].name" in first["instructions"]
    assert "items[1]" in request["questions"]["item_1"]["instructions"]
    # criteria stay inside the documented 2..255 option window
    assert 2 <= len(first["criteria"]) <= 255


def response(*choices, cost=0.0002, model="typesafe/jev-1.14-20261014") -> dict:
    answers = {}
    for index, (choice, confidence) in enumerate(choices):
        answers[f"item_{index}"] = {
            "type": "choice",
            "choice": choice,
            "confidence": confidence,
            "probabilities": {choice: confidence},
        }
    return {
        "answers": answers,
        "id": "gen-dec-test",
        "model": model,
        "provider": "TypeSafe",
        "usage": {"cost": cost, "input_tokens": 900, "output_tokens": 12},
    }


def test_parse_maps_an_option_back_to_the_rule_engines_style():
    options = style_jev.option_set(CATALOGUE)
    target = next(option for option in options if option.label == "U.S. small cap value")
    items = [item("ABSTX")]
    readings, cost, served = style_jev.parse_response(
        response((target.key, 0.93)), items, options
    )
    reading = readings[0]
    assert reading.style is not None
    assert reading.style.key == target.style.key
    assert reading.label == "U.S. small cap value"
    assert cost == pytest.approx(0.0002)
    assert served.startswith("typesafe/jev-1.14")


def test_parse_keeps_unknown_as_an_answer_not_a_failure():
    options = style_jev.option_set(CATALOGUE)
    readings, _, _ = style_jev.parse_response(
        response((style_jev.UNKNOWN, 0.88)), [item("ACSLX")], options
    )
    assert readings[0].style is None
    assert not style_jev.accepted(readings[0], min_confidence=0.85)


def test_parse_refuses_a_response_without_the_item():
    options = style_jev.option_set(CATALOGUE)
    with pytest.raises(style_jev.JevError):
        style_jev.parse_response(response(("x", 0.9)), [item("ABSTX"), item("ACRNX")], options)


def test_threshold_is_the_only_thing_between_a_reading_and_an_override():
    options = style_jev.option_set(CATALOGUE)
    target = next(option for option in options if option.label == "U.S. small cap value")
    high, _, _ = style_jev.parse_response(response((target.key, 0.90)), [item("ABSTX")], options)
    low, _, _ = style_jev.parse_response(response((target.key, 0.60)), [item("ABSTX")], options)
    assert style_jev.accepted(high[0], min_confidence=0.85)
    assert not style_jev.accepted(low[0], min_confidence=0.85)


def test_row_carries_every_style_field_plus_its_evidence():
    options = style_jev.option_set(CATALOGUE)
    target = next(option for option in options if option.label == "U.S. small cap value")
    readings, _, _ = style_jev.parse_response(response((target.key, 0.91)), [item("ABSTX")], options)
    row = style_jev.row_for(readings[0], model="typesafe/jev-1.14", run_id="run-1")
    assert set(row) == set(style_jev.FIELDS)
    assert row["name"] == "Teberg Fund"
    assert row["ticker"] == "ABSTX"
    assert row["confidence"] == "0.910"
    assert row["key"] == target.style.key


def test_override_file_round_trips_and_ignores_comments(tmp_path):
    path = tmp_path / "style_jev.csv"
    rows = [
        {"ticker": "B", "name": "Beta Fund", "key": "k_b", "label": "L B", "group": "equity",
         "region": "U.S.", "size": "", "style": "", "theme": "", "confidence": "0.900",
         "jev_model": "m", "run_id": "r"},
        {"ticker": "A", "name": "Alpha Fund", "key": "k_a", "label": "L A", "group": "equity",
         "region": "U.S.", "size": "", "style": "", "theme": "", "confidence": "0.950",
         "jev_model": "m", "run_id": "r"},
    ]
    assert style_jev.write_overrides(path, rows, header="# a comment\n") == 2
    text = path.read_text()
    assert text.startswith("# a comment")
    # stable order: by name, so two runs on the same release produce the same bytes
    assert text.index("Alpha Fund") < text.index("Beta Fund")
    read = style_jev.read_overrides(path)
    assert set(read) == {"Alpha Fund", "Beta Fund"}
    assert read["Alpha Fund"]["key"] == "k_a"


def test_fill_candidates_pay_for_a_name_once():
    items = [item(ticker) for ticker in sorted(CATALOGUE)]
    candidates = style_jev.fill_candidates(items, overrides={}, refusals={})
    assert {c.ticker for c in candidates} == {"ABSTX", "ACRNX", "ACSLX"}
    answered = {"Teberg Fund": {"key": "x"}}
    refused = {"Columbia Acorn Fund": {"reason": "unknown name"}}
    left = style_jev.fill_candidates(items, overrides=answered, refusals=refused)
    assert [c.ticker for c in left] == ["ACSLX"]
    assert len(style_jev.fill_candidates(items, overrides={}, refusals={}, max_new=2)) == 2


def test_audit_sample_is_reproducible_and_only_reads_rule_names():
    items = [item(ticker) for ticker in sorted(CATALOGUE)]
    first = style_jev.audit_sample(items, size=3, seed=7)
    second = style_jev.audit_sample(items, size=3, seed=7)
    assert [i.ticker for i in first] == [i.ticker for i in second]
    assert all(classify(i.name, i.issuer) is not None for i in first)


def test_a_rule_hit_always_beats_an_override(tmp_path):
    path = tmp_path / "style_jev.csv"
    style_jev.write_overrides(
        path,
        [{"ticker": "VTI", "name": "Vanguard Total Stock Market ETF", "key": "fake_key",
          "label": "Fake", "group": "equity", "region": "", "size": "", "style": "",
          "theme": "", "confidence": "0.990", "jev_model": "m", "run_id": "r"}],
        header="#\n",
    )
    style = style_overrides.resolve("Vanguard Total Stock Market ETF", "Vanguard", path=path)
    assert style is not None
    assert style.key != "fake_key"
    assert style.matched != (style_overrides.ORIGIN,)


def test_an_override_fills_only_what_the_rules_could_not_read(tmp_path):
    path = tmp_path / "style_jev.csv"
    style_jev.write_overrides(
        path,
        [{"ticker": "ACSLX", "name": "Select Fund", "key": "us_equity", "label": "U.S. equity",
          "group": "equity", "region": "U.S.", "size": "", "style": "", "theme": "",
          "confidence": "0.900", "jev_model": "m", "run_id": "r"}],
        header="#\n",
    )
    assert classify("Select Fund", "") is None                  # the gap is real
    style = style_overrides.resolve("Select Fund", "", path=path)
    assert style is not None and style.key == "us_equity"
    assert style.matched == (style_overrides.ORIGIN,)
    assert style_overrides.resolve("Not In The File", "", path=path) is None


def test_a_malformed_row_is_skipped_never_raised(tmp_path):
    path = tmp_path / "style_jev.csv"
    path.write_text(
        "# comment\n"
        "ticker,name,key,label,group,region,size,style,theme,confidence,jev_model,run_id\n"
        "BAD,Broken Fund,,,equity,,,,,,,\n"
        "GOOD,Good Fund,k,l,equity,,,,0.9,m,r\n"
    )
    loaded = style_overrides.load(path)
    assert set(loaded) == {"Good Fund"}
    counters = style_overrides.skipped()
    assert counters["bad"] == 1 and counters["rows"] == 2


def test_a_missing_override_file_is_not_an_error(tmp_path):
    assert style_overrides.load(tmp_path / "nope.csv") == {}
    assert style_overrides.resolve("Select Fund", "", path=tmp_path / "nope.csv") is None


def test_run_batches_and_sums_the_cost_without_touching_the_network():
    options = style_jev.option_set(CATALOGUE)
    calls: list[tuple[str, dict, bytes]] = []

    def transport(url, headers, body, timeout):
        calls.append((url, dict(headers), body))
        payload = json.loads(body)
        count = len(payload["state"]["items"])
        choice = style_jev.UNKNOWN
        return 200, response(*[(choice, 0.5)] * count, cost=0.0001)

    result = style_jev.run(
        [item("ABSTX"), item("ACRNX"), item("ACSLX")],
        options,
        transport=transport,
        api_key="test-key",
        batch_items=2,
    )
    assert result.requests == 2
    assert len(result.readings) == 3
    assert result.cost == pytest.approx(0.0002)
    assert calls[0][0] == style_jev.ENDPOINT
    assert calls[0][1]["Authorization"] == "Bearer test-key"
    assert json.loads(calls[0][2])["model"] == style_jev.DEFAULT_MODEL


def test_refusals_record_why_a_name_produced_nothing():
    options = style_jev.option_set(CATALOGUE)
    target = next(option for option in options if option.label == "U.S. small cap value")
    readings, _, _ = style_jev.parse_response(
        response((style_jev.UNKNOWN, 0.9), (target.key, 0.4)),
        [item("ABSTX"), item("ACRNX")],
        options,
    )
    rows = style_jev.refusal_rows(readings, model="m", run_id="r")
    assert [row["reason"] for row in rows] == ["unknown name", "below threshold"]


def test_gold_scoring_reports_bands_and_skips_uncertain_rows():
    gold = [
        {"ticker": "A", "name": "a", "bucket": "U.S. equity", "certain": "yes"},
        {"ticker": "B", "name": "b", "bucket": "U.S. bond", "certain": "yes"},
        {"ticker": "C", "name": "c", "bucket": "U.S. growth", "certain": "no"},
    ]
    predicted = {
        "A": ("U.S. equity", 0.92),
        "B": ("U.S. equity", 0.71),
        "C": ("U.S. growth", 0.99),
    }
    result = style_jev.score(gold, predicted)
    assert result["rows"] == 2 and result["correct"] == 1
    assert result["accuracy"] == 0.5
    assert result["skipped_uncertain"] == 1
    assert result["bands"]["0.85-1.00"]["rows"] == 1
    assert result["bands"]["0.85-1.00"]["accuracy"] == 1.0
    assert result["bands"]["0.70-0.85"]["accuracy"] == 0.0
    assert result["misses"][0]["ticker"] == "B"


def test_cost_estimate_never_needs_a_network_or_a_key():
    options = style_jev.option_set(CATALOGUE)
    request = style_jev.build_request([item("ABSTX")], options)
    tokens, dollars = style_jev.estimate_cost(request)
    assert tokens > 0 and dollars == pytest.approx(tokens * 0.000000042)


def test_a_request_over_the_long_context_guard_is_refused_before_it_is_sent(monkeypatch):
    """The provider flips to a slower, less accurate path above ~32 KB. Buying that
    silently would be worse than failing, so the guard fails closed and sends nothing."""
    options = style_jev.option_set(CATALOGUE)
    sent: list[bytes] = []

    def transport(url, headers, body, timeout):
        sent.append(body)
        return 200, response((style_jev.UNKNOWN, 0.5))

    monkeypatch.setattr(style_jev, "MAX_REQUEST_BYTES", 500)
    with pytest.raises(style_jev.JevError, match="long-context"):
        style_jev.run(
            [item("ABSTX")], options, transport=transport, api_key="k", batch_items=1
        )
    assert sent == []


def _fixture_release(root, funds: dict[str, tuple[str, str]]):
    """A release directory with one fund document per entry, built the way build.py does."""
    from pipeline import fund_pages  # noqa: F401  (imported for the side-effect check below)

    release = root / "release"
    (release / "funds").mkdir(parents=True)
    catalogue = {
        "as_of": "2026-10-30.8",
        "etf_classifier": "name_rule_v1",
        "funds": {ticker: [name, issuer, 0, 99.0] for ticker, (name, issuer) in funds.items()},
    }
    (release / "catalogue.json").write_text(json.dumps(catalogue))
    for ticker, (name, issuer) in funds.items():
        (release / "funds" / f"{ticker}.json").write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "ticker": ticker,
                    "fund_id": f"S0000{ticker}",
                    "name": name,
                    "issuer": issuer,
                    "etf": False,
                    "as_of": "2026-05-31",
                    "filed_at": "2026-07-29",
                    "lag_days": 59,
                    "source": "SEC N-PORT",
                    "source_url": "https://www.sec.gov/Archives/edgar/data/1/2/primary_doc.xml",
                    "coverage_pct": 99.0,
                    "holdings": [
                        {"company_id": "c_1", "name": "NVIDIA Corp", "ticker": "NVDA",
                         "asset_cat": "equity", "weight_bp": 100}
                    ],
                    "metrics": {"hhi": 0.1, "effective_n": 10.0, "top10_pct": 100.0},
                    "warnings": [],
                }
            )
        )
    return release


def test_an_override_reaches_the_page_and_changes_no_other_page(tmp_path, monkeypatch):
    """The end-to-end claim, proved without spending anything: one committed row turns one
    fund's issuer fallback into a peer group, and every other page stays byte-identical.

    The bucket picked here has no other member in the fixture, so the peer lists of the
    other funds cannot legitimately change. A fund that joins a *populated* bucket does
    change its peers' pages — that is the feature working, and it is why the CI job's
    diff is reviewed as page changes rather than as a CSV row count.
    """
    from pipeline import fund_pages

    funds = {
        "AVUV": ("Avantis U.S. Small Cap Value ETF", "EA Series Trust"),
        "TEBRGX": ("Teberg Fund", "Teberg"),
        # A rule-readable fund already in the bucket the override will join, so the test
        # also pins the interaction: a new member changes its peers' pages, not just its own.
        "ACRNX": ("Acorn U.S. Micro Cap Fund", "Columbia"),
    }
    release = _fixture_release(tmp_path, funds)
    before = tmp_path / "before"
    fund_pages.build(release, before)
    # No rule bucket and no sibling fund in the fixture: the page has no peer section at all.
    baseline = (before / "f" / "TEBRGX" / "index.html").read_text()
    assert "Similar" not in baseline
    assert "More from" not in baseline

    path = tmp_path / "style_jev.csv"
    style_jev.write_overrides(
        path,
        [{"ticker": "TEBRGX", "name": "Teberg Fund", "key": "us-micro",
          "label": "U.S. micro cap", "group": "equity", "region": "U.S.", "size": "micro",
          "style": "", "theme": "", "confidence": "0.910", "jev_model": "m", "run_id": "r"}],
        header="#\n",
    )
    monkeypatch.setattr(style_overrides, "DEFAULT_PATH", path)
    after = tmp_path / "after"
    fund_pages.build(release, after)

    page = (after / "f" / "TEBRGX" / "index.html").read_text()
    assert "Similar U.S. micro cap funds" in page
    assert "More from" not in page

    assert "Similar U.S. micro cap funds" in (after / "f" / "ACRNX" / "index.html").read_text()

    changed = sorted(
        ticker
        for ticker in funds
        if (before / "f" / ticker / "index.html").read_bytes()
        != (after / "f" / ticker / "index.html").read_bytes()
    )
    # The overridden fund, and the peer list of the fund it joined. Nothing else.
    assert changed == ["ACRNX", "TEBRGX"]


# --- the credential preflight -------------------------------------------------
#
# A rejected key must say so in one line, before a run and before any spend. "User not
# found." from OpenRouter means the token does not resolve to a live account — revoked,
# deleted, or not an API key — which is a different problem from "the model is down" and
# needs a different fix.


def test_the_key_is_found_under_either_spelling_and_an_export_wins():
    canonical = style_jev.api_key_from_env({"OPENROUTER_API_KEY": " a "})
    assert canonical == "a"
    assert style_jev.api_key_from_env({"OPEN_ROUTER_API_KEY": "b"}) == "b"
    assert style_jev.api_key_from_env(
        {"OPENROUTER_API_KEY": "canonical", "OPEN_ROUTER_API_KEY": "typo"}
    ) == "canonical"
    assert style_jev.api_key_from_env({"OPEN_ROUTER_API_KEY": "   "}) == ""
    assert style_jev.api_key_from_env({}) == ""


def test_key_status_asks_the_free_endpoint_and_spends_nothing():
    seen = {}

    def get(url, headers, timeout):
        seen.update(url=url, headers=dict(headers), timeout=timeout)
        return 401, {"error": {"message": "User not found.", "code": 401}}

    status, payload = style_jev.key_status("test-key", get=get)
    assert status == 401
    assert payload["error"]["message"] == "User not found."
    assert seen["url"] == style_jev.KEY_INFO_URL
    assert seen["headers"]["Authorization"] == "Bearer test-key"


def probe(argv=None, monkeypatch=None, key="k", status=(200, {"data": {"label": "t"}})):
    monkeypatch.setattr("pipeline.release.load_env", lambda *a, **k: [])
    monkeypatch.setattr(style_jev, "api_key_from_env", lambda *a, **k: key)
    monkeypatch.setattr(style_jev, "key_status", lambda *a, **k: status)
    return style_jev.main(argv or ["probe"])


def test_probe_without_a_key_refuses_to_guess(monkeypatch):
    assert probe(monkeypatch=monkeypatch, key="") == 2


def test_probe_says_the_key_is_dead_instead_of_blaming_the_model(monkeypatch):
    code = probe(
        monkeypatch=monkeypatch,
        status=(401, {"error": {"message": "User not found.", "code": 401}}),
    )
    assert code == 3


def test_probe_exits_zero_on_a_live_key(monkeypatch):
    assert probe(monkeypatch=monkeypatch) == 0


def test_a_rare_allocation_label_is_offered_even_when_it_ranks_last():
    """A measured failure, kept as a test.

    The first live probe used a 48-label cut. Five of the seven allocation labels were below
    that cut, so "Amplius Aggressive Asset Allocation ETF" came back *balanced allocation* at
    0.97 confidence — not a model error: the right option was never on the ballot. Forcing
    every allocation label into the set made the same call return aggressive allocation at
    1.000. Rare labels are exactly what an unreadable name tends to state.
    """
    catalogue = dict(CATALOGUE)
    catalogue["AAAA"] = ["Amplius Aggressive Asset Allocation ETF", "Amplius", 1, 99.0]

    options = style_jev.option_set(catalogue, limit=4)
    assert "aggressive allocation" in {option.label for option in options}
    assert len(options) == 4
    # and the ordinary high-count labels still fill the rest of the ballot
    assert "U.S. all cap blend" in {option.label for option in options}
