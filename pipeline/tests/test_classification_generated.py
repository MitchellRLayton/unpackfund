"""The generated classification modules must agree with the JSON they came from.

``classification/classification.json`` is the source of truth and two modules are
generated from it — one TypeScript for the browser, one Python for the fund-page
generator. Nothing stops a hand edit to either, and a hand edit is exactly the failure
that matters: the site would draw one split and the fund page would print another, with
both looking correct in isolation.

So this file re-derives the tables from the JSON and compares. It also compares the two
generated modules to each other, which is the check that catches a generator bug rather
than a hand edit: if ``gen_classification.py`` emits the same data twice, the two modules
agree by construction, and if it emits it differently the disagreement shows up here
rather than on a page.

The TypeScript module is read as text and its row literal parsed as JSON. That is
deliberate — shelling out to ``node`` would make the test depend on a toolchain the
pipeline does not otherwise need, and the literal is emitted in a JSON-compatible shape
for exactly this reason.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from pipeline import classification_generated as generated

REPO_ROOT = Path(__file__).resolve().parents[2]
SOURCE = REPO_ROOT / "classification" / "classification.json"
TS_MODULE = REPO_ROOT / "web" / "lib" / "classification.generated.ts"

TIERS = ("DEVELOPED", "EMERGING", "FRONTIER", "STANDALONE", "UNCLASSIFIED")
BUCKETS = ("US", "DM", "EM")
ALL_CODES = [a + b for a in "ABCDEFGHIJKLMNOPQRSTUVWXYZ" for b in "ABCDEFGHIJKLMNOPQRSTUVWXYZ"]


@pytest.fixture(scope="module")
def document() -> dict:
    return json.loads(SOURCE.read_text())


def _ts_rows() -> dict[str, list[list]]:
    """The row literal out of the generated TypeScript module, parsed as JSON."""
    text = TS_MODULE.read_text()
    start = text.index("export const CLASSIFICATION_ROWS")
    body = text[text.index("{", start) :]
    body = body[: body.index("\n};") + 2]
    # The literal is emitted with a trailing comma after every element, which JSON does
    # not allow. Nothing in the data contains `,]` or `,}`, so this is safe.
    return json.loads(re.sub(r",(\s*[\]}])", r"\1", body))


def test_the_source_is_where_the_modules_say_it_is(document: dict) -> None:
    assert document["kind"] == "country_classification"
    assert generated.TIER_AS_OF == document["as_of"]
    assert generated.DEFAULT_PROVIDER == next(
        name for name, provider in document["providers"].items() if provider["is_default"]
    )
    assert list(generated.PROVIDERS) == list(document["providers"])


def test_the_python_rows_are_the_json_rows(document: dict) -> None:
    for provider, spec in document["providers"].items():
        expected = sorted(
            (row["iso2"], row["effective_from"], row.get("effective_to"), row["tier"])
            for row in spec["rows"]
        )
        actual = sorted(
            (iso2, start, end, tier)
            for iso2, start, end, tier, _label in generated.CLASSIFICATION_ROWS[provider]
        )
        assert actual == expected, provider


def test_the_python_bucket_rules_are_the_json_bucket_rules(document: dict) -> None:
    rules = document["bucket_rules"]
    assert generated.TIER_FOLD == rules["fold"]
    assert generated.SHARED_BUCKETS == rules["shared"]
    for provider in document["providers"]:
        assert generated.PROVIDER_BUCKETS[provider] == rules.get("by_provider", {}).get(provider, {})


def test_the_two_generated_modules_agree(document: dict) -> None:
    """The check a generator bug fails and a hand edit does not."""
    ts = _ts_rows()
    assert sorted(ts) == sorted(generated.CLASSIFICATION_ROWS)
    for provider in generated.CLASSIFICATION_ROWS:
        assert [list(row) for row in generated.CLASSIFICATION_ROWS[provider]] == ts[provider], provider


def test_every_tier_and_bucket_is_one_the_code_knows(document: dict) -> None:
    for provider, spec in document["providers"].items():
        for row in spec["rows"]:
            assert row["tier"] in TIERS, (provider, row["iso2"])
    for tier, bucket in document["bucket_rules"]["fold"].items():
        assert tier in TIERS and bucket in BUCKETS
    for code, bucket in document["bucket_rules"]["shared"].items():
        assert re.fullmatch(r"[A-Z]{2}", code) and bucket in BUCKETS


def test_no_domicile_is_classified_twice_on_one_day(document: dict) -> None:
    for provider, spec in document["providers"].items():
        windows: dict[str, list[tuple[str, str | None]]] = {}
        for row in spec["rows"]:
            windows.setdefault(row["iso2"], []).append(
                (row["effective_from"], row.get("effective_to"))
            )
        for iso2, spans in windows.items():
            spans.sort()
            for (_start, end), (next_start, _next_end) in zip(spans, spans[1:]):
                assert end is not None and end <= next_start, (provider, iso2)


def test_the_bar_never_has_a_fourth_segment() -> None:
    for provider in generated.PROVIDERS:
        unplaced = [code for code in ALL_CODES if generated.tier_of(code, provider=provider) not in BUCKETS]
        assert unplaced == [], provider


def test_a_missing_country_is_null_and_never_a_bucket() -> None:
    for provider in generated.PROVIDERS:
        assert generated.tier_of(None, provider=provider) is None
        assert generated.tier_of("", provider=provider) is None
        assert generated.market_tier_of(None, provider=provider) is None


def test_the_may_2027_review_moves_greece_and_bulgaria() -> None:
    assert generated.market_tier_of("GR", as_of="2027-05-31") == "EMERGING"
    assert generated.market_tier_of("GR", as_of="2027-06-01") == "DEVELOPED"
    assert generated.market_tier_of("BG", as_of="2027-05-31") == "STANDALONE"
    assert generated.market_tier_of("BG", as_of="2027-06-01") == "FRONTIER"
    # Both fold into emerging either way, so the bar does not move — only the label does.
    assert generated.tier_of("GR", as_of="2027-05-31") == "EM"
    assert generated.tier_of("GR", as_of="2027-06-01") == "DM"
    assert generated.tier_of("BG", as_of="2027-05-31") == "EM"
    assert generated.tier_of("BG", as_of="2027-06-01") == "EM"


def test_the_offshore_rule_holds_under_both_providers() -> None:
    for provider in generated.PROVIDERS:
        for code in ("BM", "KY", "VG", "GG", "JE", "IM", "PA", "MH", "BS", "GI", "MC", "PR"):
            assert generated.tier_of(code, provider=provider) == "US", (provider, code)


def test_the_ftse_view_still_says_what_it_said_before_the_migration() -> None:
    """The regression gate, in Python, for the fund-page generator.

    The table that shipped on 2026-11-05, re-derived from its five sets. Asking for FTSE
    must show exactly what the site showed before MSCI became the default.

    One deliberate exception, and it is a correction rather than a migration: the four
    United States territories other than Puerto Rico (Guam, American Samoa, the Northern
    Mariana Islands, the Virgin Islands) were absent from the shipped table and fell
    through to emerging. They are United States territory under both publishers, so they
    are now in the shared bucket and the FTSE view moves with them.
    """
    developed_ex_us = set(
        "AT AU BE CA CH DE DK ES FI FR GB GR HK IE IL IT JP KR LU NL NO NZ PL PT SE SG".split()
    )
    emerging = set("AE BR CL CO CN CZ EG HU ID IN IS KW MX MY PH QA RO SA TH TR TW VN ZA".split())
    offshore = set("BM BS GG GI IM JE KY MC MH PA VG".split())
    advanced_frontier = set("BG CY EE HR LT LV MT SI SK".split())

    territories = set("AS GU MP VI".split())

    def shipped(code: str) -> str:
        if code == "US" or code == "PR" or code in offshore or code in territories:
            return "US"
        if code in developed_ex_us or code in advanced_frontier:
            return "DM"
        return "EM"

    drift = [
        (code, shipped(code), generated.tier_of(code, provider="FTSE"))
        for code in ALL_CODES
        if shipped(code) != generated.tier_of(code, provider="FTSE")
    ]
    assert drift == []
