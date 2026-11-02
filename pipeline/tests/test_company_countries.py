"""The company→country decision, its bytes, and the release gate that holds it honest.

A country is not a filed fact. N-PORT reports ``invCountry`` per holding row, so the
ledger's tag is an *inference* over the funds that hold a company, and the two things
that make an inference publishable are pinned here:

* the rule is stated and refusable — value-weighted majority, at an 80% floor, with at
  least two filings, and **no** answer below either floor;
* the release proves the map is the projection of its own company shards, so the tag a
  reader sees and the company record behind it cannot drift apart.

Every test that asserts a refusal uses the same shape — build the fixture release,
tamper with one thing, repair the descriptor hash so only the intended check can
fire, and require exit code 1 — because a gate that only ever sees correct input
proves nothing (``lookthrough-math-and-qa`` §8).
"""

from __future__ import annotations

import hashlib
import json

import pytest

from pipeline import company_countries, fixtures, validate
from pipeline.artifact import canonical_bytes

from .conftest import write_release

#: The Apple row the sample filing resolves to (``CIK 320193``). One company is
#: enough to exercise the descriptor, the projection and the counts.
APPLE = "c_0000320193"


def _release(tmp_path, countries=None, documents=None):
    return write_release(
        tmp_path,
        documents or [fixtures.sample_document()],
        countries=countries if countries is not None else {APPLE: "US"},
    )


def _repair_descriptor(release_dir, payload: bytes) -> None:
    """Re-hash the country object so a test can isolate a check other than the hash."""
    path = release_dir / "release.json"
    descriptor = json.loads(path.read_text())
    entry = descriptor["objects"]["companies"]["countries"]
    entry["bytes"] = len(payload)
    entry["sha256"] = hashlib.sha256(payload).hexdigest()
    path.write_bytes(canonical_bytes(descriptor))


def _tally(entries):
    """``[(company, country, dollars, filings)]`` → a tally, in whole dollars."""
    tally = company_countries.Tally()
    for company_id, country, dollars, filings in entries:
        tally.dollars.setdefault(company_id, {})
        tally.filings.setdefault(company_id, {})
        tally.dollars[company_id][country] = tally.dollars[company_id].get(country, 0) + dollars
        tally.filings[company_id][country] = tally.filings[company_id].get(country, 0) + filings
    return tally


# --------------------------------------------------------------------------- rules


def test_a_clear_majority_is_decided_by_value_not_by_filer_count():
    # One large US-domiciled holder against two small ones that disagree: the value
    # decides, which is what the object's `rule` field promises.
    tally = _tally(
        [
            ("c_1", "US", 900, 2),
            ("c_2", "US", 900, 2),
            ("c_1", "IE", 10, 2),
        ]
    )
    decided, stats = company_countries.decide(tally)
    assert decided == {"c_1": "US", "c_2": "US"}
    assert stats == {"with_votes": 2, "below_floor": 0}


def test_below_the_agreement_floor_the_company_has_no_country():
    # 79.9% is not a decision; the map must not carry a default for it.
    tally = _tally([("c_1", "US", 799, 3), ("c_1", "IE", 201, 2)])
    decided, stats = company_countries.decide(tally)
    assert decided == {}
    assert stats["below_floor"] == 1


def test_exactly_at_the_floor_is_decided():
    tally = _tally([("c_1", "US", 800, 2), ("c_1", "IE", 200, 1)])
    decided, _ = company_countries.decide(tally)
    assert decided == {"c_1": "US"}


def test_a_tie_is_not_decided_by_dict_order():
    tally = _tally([("c_1", "IE", 500, 2), ("c_1", "US", 500, 2)])
    decided, stats = company_countries.decide(tally)
    assert decided == {}
    assert stats["below_floor"] == 1


def test_one_filing_is_not_a_consensus():
    # 100% agreement from a single filing is still a single source, and a filer can put
    # its own country here. Two filings is the floor.
    tally = _tally([("c_1", "US", 5_000, 1)])
    decided, stats = company_countries.decide(tally)
    assert decided == {}
    assert stats["below_floor"] == 1


def test_the_decision_is_deterministic():
    entries = [("c_1", "US", 700, 2), ("c_1", "IE", 300, 1), ("c_2", "TW", 600, 2)]
    first = company_countries.decide(_tally(entries))[0]
    shuffled = list(reversed(entries))
    assert company_countries.decide(_tally(shuffled))[0] == first


def test_only_alpha_2_codes_count_as_votes():
    for junk in ("", None, "USA", "united states", "u1", "us", 12, True):
        assert not company_countries.is_country_code(junk)
    for good in ("US", "TW", "IE", "KY"):
        assert company_countries.is_country_code(good)


def test_a_fund_contributes_its_country_only_for_country_shaped_codes():
    class Row:
        def __init__(self, company_id, country, weight_bp):
            self.company_id = company_id
            self.country = country
            self.weight_bp = weight_bp

    rows = [
        Row("c_1", "US", 500),
        Row("c_2", "usa", 500),  # present but unusable: counted, not voted
        Row("c_3", None, 500),  # silence: neither counted nor voted
        Row("c_4", "TW", 0),  # no weight
        Row(None, "US", 500),  # no company
    ]
    votes, invalid = company_countries.fund_votes(rows)
    assert votes == {"c_1": ("US", 500)}
    assert invalid == 1


def test_the_tally_weights_by_dollars_not_by_row_count():
    tally = company_countries.Tally()
    # 5,000 bp of a $1,000 fund is $500; 500 bp is $50.
    tally.add_fund({"c_1": ("US", 5_000)}, net_assets=1_000)
    tally.add_fund({"c_1": ("US", 5_000)}, net_assets=1_000)
    tally.add_fund({"c_1": ("IE", 500)}, net_assets=1_000)
    decided, _ = company_countries.decide(tally)
    assert decided == {"c_1": "US"}
    assert tally.dollars["c_1"] == {"US": 1_000, "IE": 50}
    assert tally.filings["c_1"] == {"US": 2, "IE": 1}


def test_a_fund_without_net_assets_contributes_filings_but_no_value():
    tally = company_countries.Tally()
    tally.add_fund({"c_1": ("US", 5_000)}, net_assets=None)
    assert tally.dollars["c_1"] == {"US": 0}
    assert company_countries.decide(tally)[0] == {}, "no value means no majority to weigh"


# -------------------------------------------------------------------------- bytes


def test_the_object_states_its_own_rule_and_coverage():
    document = company_countries.build_object(
        "2026-11-02.6", {"c_2": "TW", "c_1": "US"}, company_total=10, invalid_rows=7
    )
    assert document["kind"] == "company_countries"
    assert document["as_of"] == "2026-11-02.6"
    assert document["source"] == "SEC N-PORT invCountry"
    assert "majority" in document["rule"]
    assert document["counts"] == {
        "companies": 10,
        "with_country": 2,
        "us": 1,
        "non_us": 1,
        "undecided": 8,
        "invalid_rows": 7,
    }
    # Sorted by company id: the bytes may not depend on dict insertion order.
    assert list(document["companies"]) == ["c_1", "c_2"]


def test_serialisation_is_compact_and_byte_stable():
    document = company_countries.build_object("2026-11-02.6", {"c_1": "US"}, company_total=1)
    body = company_countries.canonical_bytes(document)
    assert body.endswith(b"\n")
    assert b"\n  " not in body, "the ledger fetches this: one line or it is not small"
    assert company_countries.canonical_bytes(json.loads(body)) == body


def test_the_map_is_far_smaller_than_the_shards_it_summarises():
    companies = {f"c_{index:010d}": "US" for index in range(5_000)}
    body = company_countries.canonical_bytes(
        company_countries.build_object("2026-11-02.6", companies, company_total=5_000)
    )
    assert len(body) < company_countries.MAX_COUNTRIES_BYTES
    # ~20 B per company; the shards it summarises are 1.4 kB each.
    assert len(body) < 5_000 * 40


# --------------------------------------------------------------------------- gate


def test_the_fixture_release_publishes_a_valid_map(tmp_path, capsys):
    release_dir = _release(tmp_path)
    assert validate.validate(release_dir) == 0
    printed = capsys.readouterr().out
    assert "companies.countries: 1 of 3 companies placed (1 US)" in printed
    document = json.loads((release_dir / "companies/countries.json").read_text())
    assert document["companies"] == {APPLE: "US"}
    descriptor = json.loads((release_dir / "release.json").read_text())
    entry = descriptor["objects"]["companies"]["countries"]
    assert entry["path"] == "companies/countries.json"
    assert entry["bytes"] == (release_dir / "companies/countries.json").stat().st_size
    # And the shard carries the same fact: one decision, two renderings.
    shard = json.loads((release_dir / f"companies/{APPLE}.json").read_text())
    assert shard["country"] == "US"


def test_a_release_without_the_object_is_valid(tmp_path):
    # Every release published before this feature has this shape, and it must keep
    # validating: absence is the dual-read switch, not a defect.
    release_dir = write_release(tmp_path, [fixtures.sample_document()])
    assert validate.validate(release_dir) == 0
    assert not (release_dir / "companies/countries.json").exists()
    shard = json.loads((release_dir / f"companies/{APPLE}.json").read_text())
    assert "country" not in shard


def test_validator_rejects_a_map_that_is_not_the_projection_of_the_shards(tmp_path):
    release_dir = _release(tmp_path)
    path = release_dir / "companies/countries.json"
    document = json.loads(path.read_text())
    document["companies"].pop(APPLE)
    payload = company_countries.canonical_bytes(document)
    path.write_bytes(payload)
    _repair_descriptor(release_dir, payload)
    assert validate.validate(release_dir) == 1, "a shard says US and the map says nothing"


def test_validator_rejects_a_flipped_code(tmp_path):
    release_dir = _release(tmp_path)
    path = release_dir / "companies/countries.json"
    document = json.loads(path.read_text())
    document["companies"][APPLE] = "IE"
    payload = company_countries.canonical_bytes(document)
    path.write_bytes(payload)
    _repair_descriptor(release_dir, payload)
    assert validate.validate(release_dir) == 1


def test_validator_rejects_a_company_the_release_does_not_publish(tmp_path):
    release_dir = _release(tmp_path)
    path = release_dir / "companies/countries.json"
    document = json.loads(path.read_text())
    document["companies"]["c_9999999999"] = "US"
    document["counts"]["with_country"] = 2
    document["counts"]["us"] = 2
    document["counts"]["undecided"] = document["counts"]["companies"] - 2
    payload = company_countries.canonical_bytes(document)
    path.write_bytes(payload)
    _repair_descriptor(release_dir, payload)
    assert validate.validate(release_dir) == 1


def test_validator_rejects_a_code_that_is_not_alpha_2(tmp_path):
    release_dir = _release(tmp_path)
    path = release_dir / "companies/countries.json"
    document = json.loads(path.read_text())
    document["companies"][APPLE] = "USA"
    payload = company_countries.canonical_bytes(document)
    path.write_bytes(payload)
    _repair_descriptor(release_dir, payload)
    assert validate.validate(release_dir) == 1


def test_validator_recomputes_the_counts(tmp_path):
    release_dir = _release(tmp_path)
    path = release_dir / "companies/countries.json"
    document = json.loads(path.read_text())
    document["counts"]["undecided"] += 1
    payload = company_countries.canonical_bytes(document)
    path.write_bytes(payload)
    _repair_descriptor(release_dir, payload)
    assert validate.validate(release_dir) == 1


def test_validator_rejects_shards_that_carry_a_country_the_ledger_cannot_read(tmp_path):
    release_dir = _release(tmp_path)
    (release_dir / "companies/countries.json").unlink()
    path = release_dir / "release.json"
    descriptor = json.loads(path.read_text())
    descriptor["objects"]["companies"].pop("countries")
    path.write_bytes(canonical_bytes(descriptor))
    assert validate.validate(release_dir) == 1, "the shard carries a fact with no map to read it"


def test_validator_rejects_an_object_that_disagrees_with_its_descriptor(tmp_path):
    release_dir = _release(tmp_path)
    path = release_dir / "companies/countries.json"
    document = json.loads(path.read_text())
    document["counts"]["invalid_rows"] = 99
    path.write_bytes(company_countries.canonical_bytes(document))
    assert validate.validate(release_dir) == 1


def test_validator_rejects_a_map_with_no_descriptor_entry(tmp_path):
    release_dir = _release(tmp_path)
    path = release_dir / "release.json"
    descriptor = json.loads(path.read_text())
    descriptor["objects"]["companies"].pop("countries")
    path.write_bytes(canonical_bytes(descriptor))
    assert validate.validate(release_dir) == 1


@pytest.mark.parametrize("country", ["US", "TW"])
def test_the_shard_and_the_map_are_written_from_one_decision(tmp_path, country):
    # Whatever the decision, the two renderings agree — that is the property the
    # projection check protects, asserted here without going through the validator.
    release_dir = _release(tmp_path, countries={APPLE: country})
    document = json.loads((release_dir / "companies/countries.json").read_text())
    shard = json.loads((release_dir / f"companies/{APPLE}.json").read_text())
    assert document["companies"] == {APPLE: country}
    assert shard["country"] == country
