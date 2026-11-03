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

from pipeline import build as build_mod
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
        def __init__(self, company_id, country, weight_bp, asset_cat="equity"):
            self.company_id = company_id
            self.country = country
            self.weight_bp = weight_bp
            self.asset_cat = asset_cat

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


def test_a_fund_position_does_not_vote():
    """A fund row's `invCountry` is the fund's domicile, and VT is a US fund holding
    the world — so it may never place a company, and it is never placed itself.

    This is not a nicety: the wide build of 2026-11-02.7 failed the release at the
    projection gate because three flattened wrappers' sleeve rows had voted, and after
    flattening those sleeves had no company shard left to agree with the map.
    """

    class Row:
        def __init__(self, company_id, country, weight_bp, asset_cat):
            self.company_id = company_id
            self.country = country
            self.weight_bp = weight_bp
            self.asset_cat = asset_cat

    votes, invalid = company_countries.fund_votes(
        [
            Row("c_1", "US", 4_000, "fund"),
            Row("c_2", "US", 2_500, "equity"),
            Row("c_3", "usa", 2_500, "fund"),  # a fund row is not even counted as junk
        ]
    )
    assert votes == {"c_2": ("US", 2_500)}
    assert invalid == 0


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


# ----------------------------------------------------------------------- fallback
#
# The vote is a consensus over *holders*; a company's own registry record is a
# different kind of evidence, and it is allowed to answer only where the vote
# declined. Three properties make that publishable: it never touches a decided
# company, it is ordered (EDGAR's own vocabulary is not ISO), and it is checked
# against the vote on every build so a wrong code table fails the release instead of
# quietly relabelling companies.


def test_a_decided_company_is_never_overridden():
    decided = {"c_0000000001": "US"}
    placed, stats = company_countries.apply_fallback(
        decided,
        companies={"c_0000000001"},
        # Both sources would say something else about the same company. They are not
        # asked: the vote decided, and a fallback is not a second opinion.
        gleif_jurisdictions={"c_0000000001": "KY"},
        edgar_codes={"c_0000000001": "E9"},
    )
    assert placed == decided
    assert stats["sources"] == {"nport": 1, "gleif": 0, "edgar": 0}


def test_a_gleif_jurisdiction_becomes_a_country():
    assert company_countries.gleif_country("US-DE") == "US"
    assert company_countries.gleif_country("KY") == "KY"
    assert company_countries.gleif_country("us-de") == "US"
    for junk in (None, "", "USA", "U", "-DE"):
        assert company_countries.gleif_country(junk) is None


def test_edgar_codes_are_read_in_edgars_own_vocabulary():
    # The field is not ISO: DE is Delaware (Germany is 2M) and CA is California
    # (Canada is a province code). Getting that order wrong would move every US
    # company incorporated in Delaware to Germany.
    assert company_countries.edgar_country("DE") == "US"
    assert company_countries.edgar_country("CA") == "US"
    assert company_countries.edgar_country("PR") == "US"  # a territory files as a state
    assert company_countries.edgar_country("A1") == "CA"  # Ontario
    assert company_countries.edgar_country("E9") == "KY"
    assert company_countries.edgar_country("X0") == "GB"
    assert company_countries.edgar_country("2m") == "DE", "case is normalised, not trusted"


def test_an_unknown_or_ambiguous_edgar_code_leaves_the_company_undecided():
    # D8, U3, C3, X1 and A4 are absent from the table on purpose: too thin, or the
    # observations already disagree. A company whose code we cannot resolve stays
    # absent — the same answer as no code at all, and never a default.
    for unknown in ("D8", "U3", "C3", "X1", "A4", "ZZ", "F4", "", None):
        assert company_countries.edgar_country(unknown) is None
    placed, stats = company_countries.apply_fallback(
        {},
        companies={"c_0000000001", "c_0000000002"},
        edgar_codes={"c_0000000001": "D8", "c_0000000002": "E9"},
    )
    assert placed == {"c_0000000002": "KY"}
    assert stats["sources"] == {"nport": 0, "gleif": 0, "edgar": 1}


def test_the_fallback_universe_is_what_the_catalogue_publishes():
    # The same filter `catalogue.company_objects` applies, because a country placed
    # on a company with no shard is an extra key the release's projection gate
    # refuses (that is how the 2026-11-02.7 build caught three wrapper sleeves).
    documents = [
        {
            "ticker": "TESTX",
            "holdings": [
                {"company_id": "c_1", "weight_bp": 500},
                {"company_id": "c_2", "weight_bp": 0},
                {"company_id": None, "weight_bp": 500},
                {"company_id": "c_3"},
            ],
        }
    ]
    assert company_countries.release_companies(documents) == {"c_1"}


def test_a_failed_fetch_leaves_the_company_undecided_rather_than_failing_the_build():
    def fetch(cik):
        if cik == "0000000001":
            raise RuntimeError("HTTP 404")
        return {"stateOfIncorporation": "E9", "cik": cik}

    codes = company_countries.edgar_incorporations(
        ["c_0000000001", "c_0000000002", "l_ffffffffffffffff"], fetch=fetch
    )
    assert codes == {"c_0000000002": "E9"}, "an LEI id is never asked about, and no fetch may raise"


def test_the_gate_refuses_a_table_that_stops_reproducing_the_vote():
    decided = {f"c_{index:010d}": "US" for index in range(250)}
    # A table shifted one code along: every answer is wrong, which is what a bad
    # revision of EDGAR's vocabulary looks like.
    shifted = {company_id: "E9" for company_id in decided}
    with pytest.raises(company_countries.CountryFallbackError) as error:
        company_countries.apply_fallback(decided, companies=set(decided), edgar_codes=shifted)
    assert "9,500 bp floor" in str(error.value)


def test_the_gate_passes_on_a_rate_the_real_join_measured():
    # The published rate on 2026-11-02 was 9,925 bp for GLEIF and ~9,9xx for EDGAR.
    # A rate at the floor passes: the floor is a floor, not a target.
    decided = {f"c_{index:010d}": "US" for index in range(250)}
    agreeing = {company_id: "DE" for company_id in list(decided)[:249]}
    disagreeing = {company_id: "E9" for company_id in list(decided)[249:]}
    placed, stats = company_countries.apply_fallback(
        decided, companies=set(decided), edgar_codes={**agreeing, **disagreeing}
    )
    assert placed == decided
    assert stats["agreement"]["edgar_compared"] == 250
    assert stats["agreement"]["edgar_bp"] == 9_960


def test_a_small_sample_is_published_but_does_not_fail_the_build():
    # Under MIN_AGREEMENT_SAMPLE a rate is noise, so it is recorded and not acted on:
    # the release says how many companies the claim rests on.
    decided = {f"c_{index:010d}": "US" for index in range(20)}
    placed, stats = company_countries.apply_fallback(
        decided, companies=set(decided), edgar_codes={company_id: "E9" for company_id in decided}
    )
    assert placed == decided
    assert stats["agreement"]["edgar_compared"] == 20
    assert stats["agreement"]["edgar_bp"] == 0


def test_the_object_counts_its_sources_and_they_add_up():
    decided = {f"c_{index:010d}": "US" for index in range(3)}
    placed, stats = company_countries.apply_fallback(
        decided,
        companies=set(decided) | {"l_0000000000000001", "c_0000000009"},
        gleif_jurisdictions={"l_0000000000000001": "KY"},
        edgar_codes={"c_0000000009": "A1"},
    )
    document = company_countries.build_object(
        "2026-11-02.7", placed, company_total=10, fallback=stats
    )
    assert document["sources"] == {"nport": 3, "gleif": 1, "edgar": 1}
    assert sum(document["sources"].values()) == document["counts"]["with_country"] == 5
    assert document["counts"]["undecided"] == 5
    assert "GLEIF" in document["fallback_rule"] and "EDGAR" in document["fallback_rule"]
    # Additive: a release built without the fallback carries neither key.
    plain = company_countries.build_object("2026-11-02.7", placed, company_total=10)
    assert "sources" not in plain and "fallback_rule" not in plain


def test_the_object_with_a_fallback_is_byte_stable():
    decided = {"c_0000000001": "US", "c_0000000002": "TW"}
    companies = set(decided) | {"l_0000000000000001"}
    jurisdictions = {"l_0000000000000001": "KY"}
    first = company_countries.apply_fallback(
        decided, companies=companies, gleif_jurisdictions=jurisdictions
    )
    # Same input, different dict order: the bytes may not move.
    shuffled = company_countries.apply_fallback(
        dict(reversed(list(decided.items()))),
        companies=set(reversed(sorted(companies))),
        gleif_jurisdictions=jurisdictions,
    )
    assert first == shuffled
    body = company_countries.canonical_bytes(
        company_countries.build_object("2026-11-02.7", first[0], company_total=3, fallback=first[1])
    )
    assert body == company_countries.canonical_bytes(
        company_countries.build_object("2026-11-02.7", shuffled[0], company_total=3, fallback=shuffled[1])
    )


# ------------------------------------------------------- the fallback, at the gate


def _fallback_block(**overrides):
    block = {
        "sources": {"nport": 1, "gleif": 0, "edgar": 0},
        "agreement": {
            "gleif_bp": 9_925,
            "gleif_compared": 6_003,
            "edgar_bp": 9_907,
            "edgar_compared": 350,
        },
    }
    block.update(overrides)
    return block


def test_the_map_is_projected_onto_the_companies_the_release_publishes(tmp_path):
    # The vote's tally is built from every holding the build read; the shards are built
    # from the documents that survived the per-fund gates. A country on a company with
    # no shard is an *extra* key, and the projection gate refuses the release for it —
    # which is what failed the 2026-11-02 19:37 refresh on three companies. The build
    # now projects the map before writing it, so the gate can only ever see a
    # projection; this test holds both halves: the gate still refuses the unprojected
    # map, and `project` is what turns it into a release that validates.
    document = fixtures.sample_document()
    published = company_countries.release_companies([document])
    decided = {APPLE: "US", "c_0000000001": "KY"}
    assert "c_0000000001" not in published

    unprojected = write_release(tmp_path / "raw", [document], countries=decided)
    assert validate.validate(unprojected) != 0

    projected = write_release(
        tmp_path / "projected",
        [document],
        countries=company_countries.project(decided, published),
    )
    assert validate.validate(projected) == 0
    body = json.loads((projected / "companies/countries.json").read_text())
    assert body["companies"] == {APPLE: "US"}


def test_a_release_with_a_fallback_block_validates(tmp_path):
    release_dir = write_release(
        tmp_path,
        [fixtures.sample_document()],
        countries={APPLE: "US"},
        countries_fallback=_fallback_block(),
    )
    assert validate.validate(release_dir) == 0
    document = json.loads((release_dir / "companies/countries.json").read_text())
    assert document["sources"] == {"nport": 1, "gleif": 0, "edgar": 0}
    assert "GLEIF" in document["fallback_rule"]


def test_validator_refuses_sources_that_do_not_add_up(tmp_path):
    # `sources` is the number a reader quotes for how much of the map is a registry
    # record, so a block that does not sum to the map is a release-level mistake.
    release_dir = write_release(
        tmp_path,
        [fixtures.sample_document()],
        countries={APPLE: "US"},
        countries_fallback=_fallback_block(sources={"nport": 2, "gleif": 0, "edgar": 0}),
    )
    assert validate.validate(release_dir) == 1


def test_validator_refuses_an_unknown_source_or_a_rate_that_is_not_basis_points(tmp_path):
    # `build_object` publishes only the three known keys, so an unknown source can
    # only arrive by hand — which is exactly the tampering the gate is for.
    release_dir = write_release(
        tmp_path / "unknown",
        [fixtures.sample_document()],
        countries={APPLE: "US"},
        countries_fallback=_fallback_block(),
    )
    path = release_dir / "companies/countries.json"
    document = json.loads(path.read_text())
    document["sources"]["mystery"] = 0
    payload = company_countries.canonical_bytes(document)
    path.write_bytes(payload)
    _repair_descriptor(release_dir, payload)
    assert validate.validate(release_dir) == 1

    release_dir = write_release(
        tmp_path / "bps",
        [fixtures.sample_document()],
        countries={APPLE: "US"},
        countries_fallback=_fallback_block(
            agreement={
                "gleif_bp": 12_000,
                "gleif_compared": 6_003,
                "edgar_bp": 9_907,
                "edgar_compared": 350,
            }
        ),
    )
    assert validate.validate(release_dir) == 1


def test_validator_refuses_sources_without_a_fallback_rule(tmp_path):
    release_dir = write_release(
        tmp_path,
        [fixtures.sample_document()],
        countries={APPLE: "US"},
        countries_fallback=_fallback_block(),
    )
    path = release_dir / "companies/countries.json"
    document = json.loads(path.read_text())
    document.pop("fallback_rule")
    payload = company_countries.canonical_bytes(document)
    path.write_bytes(payload)
    _repair_descriptor(release_dir, payload)
    assert validate.validate(release_dir) == 1


def test_the_edgar_agreement_sample_is_deterministic_and_bounded():
    # The build asks EDGAR about decided companies only to have something to compare
    # against, so the sample has to be fixed across rebuilds and unbiased — sorted by
    # the digest of the company id, not by ticker or by holdings.
    decided = {f"c_{index:010d}": "US" for index in range(500)}
    decided["l_0000000000000001"] = "KY"
    first = build_mod._edgar_sample(decided, 400)
    assert len(first) == 400
    assert all(company_id.startswith("c_") for company_id in first), "an LEI id is never asked"
    assert first == build_mod._edgar_sample(dict(reversed(list(decided.items()))), 400)
    assert len(set(first)) == 400
    assert build_mod._edgar_sample({}, 400) == []


def test_the_gleif_lookup_keeps_only_the_companies_this_release_asks_about():
    # The golden copy holds 3.5 million entities; materialising a dict of all of them
    # would cost hundreds of megabytes for the ~20,000 ids a release can name. The
    # filter must still keep both halves the rates are computed from: the undecided
    # companies being placed and the decided ones being compared.
    from pipeline import gleif as gleif_mod

    entities = {
        lei: gleif_mod.Entity(lei=lei, name=name, status="ACTIVE", jurisdiction=jurisdiction)
        for lei, name, jurisdiction in (
            ("LEI0000000000000001", "PLACED", "US-DE"),
            ("LEI0000000000000002", "COMPARED", "KY"),
            ("LEI0000000000000003", "NOT IN RELEASE", "TW"),
        )
    }
    index = gleif_mod.IssuerIndex(entities, {}, cache_date="2026-10-29", source="GLEIF")
    placed_id = entities["LEI0000000000000001"].company_id
    compared_id = entities["LEI0000000000000002"].company_id
    ignored_id = entities["LEI0000000000000003"].company_id

    found = build_mod._gleif_jurisdictions(index, {compared_id: "KY"}, [placed_id])
    assert found == {placed_id: "US-DE", compared_id: "KY"}
    assert ignored_id not in found, "an entity this release does not publish is not looked up"
    assert build_mod._gleif_jurisdictions(None, {}, ["l_x"]) is None
    assert build_mod._gleif_jurisdictions(index, {}, []) == {}
