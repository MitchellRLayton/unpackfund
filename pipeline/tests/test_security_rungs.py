"""The two new rungs, held to the rules that make them safe to ship.

R3x (``isin_direct_join``): an ISIN that resolved to one company on another row's own filed LEI
resolves the same ISIN on a row that lacks the LEI. R7 (``figi_security``): OpenFIGI names the ISIN as
an equity share line, so the row gets an ``f_`` company.

Every test here is about a *rule*, not a recovery:

* H-CV1 — a row that maps without the new rungs keeps exactly its company with them;
* H-CV4 — neither rung writes to the cross-fund evidence table;
* inert — with no cache and no direct evidence the vector is the one built before the rungs existed;
* the refusals — shorts, non-equity, fund-typed answers and a second company all leave a row unmapped.

Every identifier is synthetic (``test_figi`` builds the ISINs and FIGIs).
"""

from __future__ import annotations

import json

import pytest

from pipeline import artifact, build, companies, figi, gleif, validate, weights
from pipeline.companies import IdentityEvidence, company_id
from pipeline.fixtures import sample_index, write_release
from pipeline.nport import Holding

from .test_figi import FIGI_A, FIGI_B, ISIN_A, ISIN_B, PEPPER, TODAY, synthetic_isin

LEI_ONE = "213800CHWARFAAN7UB85"
LEI_TWO = "549300E27V6N4OJCJ944"
ISIN_PERSEUS = synthetic_isin(31, "AU")
APPLE = company_id(320193)


def holding(name: str, value: float, **overrides) -> Holding:
    fields = dict(
        name=name, title="COMMON STOCK", cusip=None, isin=None, ticker=None, lei=None,
        balance=1.0, units="NS", cur_cd="USD", val_usd=value, pct_val=None, asset_cat="EC",
        issuer_cat="CORP", inv_country="KR", payoff_profile="Long", is_derivative=False,
    )
    fields.update(overrides)
    return Holding(**fields)


def vector(holdings, **kwargs):
    total = sum(h.val_usd for h in holdings if h.val_usd and h.val_usd > 0)
    return weights.build_vector(holdings, sample_index(), total, lag_days=59, **kwargs)


def by_name(vec) -> dict:
    return {row.name: row for row in vec.holdings}


def share_map(answers: dict[str, figi.Answer]) -> figi.ShareClassMap:
    cache = figi.ShareClassMap.empty(PEPPER)
    cache.merge(answers)
    return cache


def accepted(figi_value=FIGI_A, type2="Common Stock") -> figi.Answer:
    return figi.Answer("OK", TODAY, figi_value, "Equity", type2)


def issuer_index(*, isin_to_lei=None) -> gleif.IssuerIndex:
    index = gleif.IssuerIndex({}, {}, cache_date="2026-11-18", source="test")
    index.entities = {
        lei: gleif.Entity(lei=lei, name=name, status="ACTIVE", jurisdiction="AU", category="GENERAL")
        for lei, name in ((LEI_ONE, "Perseus Mining Limited"), (LEI_TWO, "Some Other Company Limited"))
    }
    index.isin_to_lei = dict(isin_to_lei or {})
    return index


# --- R7: an equity share line OpenFIGI names -------------------------------------------------


def test_an_accepted_figi_makes_an_f_company_with_no_local_ticker():
    vec = vector([holding("Kakao Corp", 100.0, isin=ISIN_A, ticker="035720")],
                 share_map=share_map({ISIN_A: accepted()}))
    row = vec.holdings[0]
    assert row.company_id == figi.security_id(FIGI_A)
    assert row.name == "Kakao Corp", "the filing's own name, never OpenFIGI's"
    assert row.ticker is None, "a filed ticker is a local listing code"
    assert vec.rung_counts[companies.RUNG_FIGI] == 1
    assert vec.coverage_pct == 100.0, "an f_ company counts toward coverage (OD-CV1)"


def test_rows_of_one_isin_merge_into_one_company_line():
    vec = vector([holding("Kakao Corp", 60.0, isin=ISIN_A), holding("KAKAO CORP ORD", 40.0, isin=ISIN_A)],
                 share_map=share_map({ISIN_A: accepted()}))
    assert len(vec.holdings) == 1 and vec.holdings[0].merged_rows == 2


def test_with_no_map_or_no_accepted_answer_the_vector_is_the_one_built_before():
    rows = [holding("Kakao Corp", 100.0, isin=ISIN_A), holding("Naver Corp", 50.0, isin=ISIN_B)]
    before = vector(rows)
    refused = share_map({ISIN_A: accepted(type2="Mutual Fund"),
                         ISIN_B: figi.Answer("NO_MATCH", TODAY)})
    after = vector(rows, share_map=refused)
    assert after.holdings == before.holdings
    assert after.rung_counts == before.rung_counts
    assert all(row.company_id is None for row in after.holdings)


@pytest.mark.parametrize(
    "overrides",
    [
        dict(balance=-1.0, val_usd=-50.0, payoff_profile="Short"),  # a short
        dict(balance=0.0),                                          # no position
        dict(asset_cat="DBT"),                                      # not equity
    ],
)
def test_shorts_and_non_equity_are_not_candidates(overrides):
    rows = [holding("Anchor Corp", 100.0), holding("Kakao Corp", 50.0, isin=ISIN_A, **overrides)]
    vec = vector(rows, share_map=share_map({ISIN_A: accepted()}))
    assert by_name(vec)["Kakao Corp"].company_id is None


def test_a_row_that_maps_without_the_cache_keeps_its_company_with_it():
    """H-CV1: R7 sees only rows every other rung declined."""
    rows = [
        holding("Apple Inc.", 70.0, ticker="AAPL", isin=ISIN_A),   # the ladder maps this
        holding("Kakao Corp", 30.0, isin=ISIN_B),
    ]
    without = by_name(vector(rows))
    with_cache = by_name(vector(rows, share_map=share_map(
        {ISIN_A: accepted(FIGI_A), ISIN_B: accepted(FIGI_B)})))
    assert without["Apple Inc."].company_id == APPLE == with_cache["Apple Inc."].company_id
    assert without["Kakao Corp"].company_id is None
    assert with_cache["Kakao Corp"].company_id == figi.security_id(FIGI_B)


def test_the_new_rungs_never_feed_the_evidence_table():
    """H-CV4: the table may not learn from its own inferences."""
    evidence = IdentityEvidence()
    rows = [holding("Kakao Corp", 50.0, isin=ISIN_A), holding("Naver Corp", 50.0, isin=ISIN_B)]
    vector(rows, evidence=evidence, share_map=share_map({ISIN_A: accepted(), ISIN_B: accepted(FIGI_B)}))
    table = evidence.table()
    assert not evidence.isin and not evidence.lei and not evidence.direct_isin
    assert table.by_isin == table.by_isin_direct == {}


# --- R3x: the same ISIN resolved on another row's own LEI -------------------------------------


def _learn(rows, *, issuers=None):
    evidence = IdentityEvidence()
    vector(rows, evidence=evidence, issuers=issuers or issuer_index())
    return evidence


def test_an_isin_resolved_by_its_own_lei_resolves_the_same_isin_without_one():
    issuers = issuer_index()
    pass_one = _learn([holding("Perseus Mining Ltd", 100.0, isin=ISIN_PERSEUS, lei=LEI_ONE)], issuers=issuers)
    perseus = gleif.issuer_id(LEI_ONE)
    assert dict(pass_one.direct_isin[ISIN_PERSEUS]) == {perseus: 1}

    table = pass_one.table()
    lacking = [holding("Perseus Mining", 100.0, isin=ISIN_PERSEUS)]
    joined = vector(lacking, identity=table, issuers=issuers)
    assert joined.holdings[0].company_id == perseus
    assert joined.rung_counts[companies.RUNG_ISIN_DIRECT] == 1
    # the control: no table, no join
    assert vector(lacking, issuers=issuers).holdings[0].company_id is None


def test_a_second_company_for_the_same_isin_refuses_the_join():
    evidence = IdentityEvidence()
    evidence.observe_direct(ISIN_PERSEUS, gleif.issuer_id(LEI_ONE))
    evidence.observe_direct(ISIN_PERSEUS, gleif.issuer_id(LEI_TWO))
    table = evidence.table()
    assert table.by_isin_direct == {} and table.contested["isin_direct"] == 1
    assert table.resolve_direct(ISIN_PERSEUS) == (None, "unmapped")


def test_only_a_rows_own_filed_lei_teaches_an_isin():
    # resolved by ticker/name, not by its own LEI
    by_ladder = _learn([holding("Apple Inc.", 100.0, ticker="AAPL", isin=ISIN_A)])
    # resolved through the *ISIN's* LEI (R6, an inference): the row carries no LEI of its own
    inferred = _learn([holding("Perseus Mining Ltd", 100.0, isin=ISIN_PERSEUS)],
                      issuers=issuer_index(isin_to_lei={ISIN_PERSEUS: LEI_ONE}))
    assert not by_ladder.direct_isin and not inferred.direct_isin


def test_the_join_never_moves_a_row_that_maps_without_it():
    """H-CV1 for R3x: it is consulted last, so a mapped row cannot change."""
    issuers = issuer_index()
    table = _learn([holding("Perseus Mining Ltd", 100.0, isin=ISIN_PERSEUS, lei=LEI_ONE)], issuers=issuers).table()
    rows = [
        holding("Apple Inc.", 40.0, ticker="AAPL", isin=ISIN_PERSEUS),            # ladder maps it
        holding("Other Co", 60.0, isin=ISIN_PERSEUS, lei=LEI_TWO),                # its own LEI maps it
    ]
    without = by_name(vector(rows, issuers=issuers))
    with_table = by_name(vector(rows, issuers=issuers, identity=table))
    for name in without:
        assert without[name].company_id == with_table[name].company_id, name


def test_the_join_runs_before_the_figi_rung_so_a_known_company_is_not_split():
    issuers = issuer_index()
    table = _learn([holding("Perseus Mining Ltd", 100.0, isin=ISIN_PERSEUS, lei=LEI_ONE)], issuers=issuers).table()
    vec = vector([holding("Perseus Mining", 100.0, isin=ISIN_PERSEUS)], issuers=issuers, identity=table,
                 share_map=share_map({ISIN_PERSEUS: accepted()}))
    assert vec.holdings[0].company_id == gleif.issuer_id(LEI_ONE), "the real company, not an f_ line"
    assert vec.rung_counts[companies.RUNG_FIGI] == 0


# --- the published field and the gate that holds it ---------------------------------------


def test_security_matched_pct_is_present_only_when_there_is_an_f_row():
    f_id = figi.security_id(FIGI_A)
    mixed = [{"company_id": f_id, "weight_bp": 2500}, {"company_id": APPLE, "weight_bp": 7500}]
    assert artifact.security_matched_fields(mixed) == {"security_matched_pct": 25.0}
    assert artifact.security_matched_fields([{"company_id": APPLE, "weight_bp": 10_000}]) == {}
    assert artifact.security_matched_fields([]) == {}


def _with_security_row(document: dict, *, pct: float | None) -> dict:
    """The fixture fund with its first company row swapped for an ``f_`` row, field in contract order."""
    document["holdings"][0]["company_id"] = figi.security_id(FIGI_A)
    gross = sum(abs(row["weight_bp"]) for row in document["holdings"])
    if pct is None:
        pct = round(100 * abs(document["holdings"][0]["weight_bp"]) / gross, 1)
    rebuilt: dict = {}
    for key, value in document.items():
        rebuilt[key] = value
        if key == "identified_by_cat":
            rebuilt["security_matched_pct"] = pct
    return rebuilt


def test_the_validator_accepts_f_ids_and_a_correct_security_matched_pct(tmp_path, document):
    release = write_release(tmp_path, [_with_security_row(document, pct=None)])
    assert validate.validate(release) == 0


@pytest.mark.parametrize("pct", [0.1, 99.9])
def test_the_validator_rejects_a_security_matched_pct_the_rows_do_not_carry(tmp_path, document, pct):
    release = write_release(tmp_path, [_with_security_row(document, pct=pct)])
    assert validate.validate(release) == 1


def test_the_validator_rejects_the_field_without_a_row_and_a_row_without_the_field(tmp_path, document):
    orphan = dict(document)
    orphan["security_matched_pct"] = 10.0
    assert validate.validate(write_release(tmp_path / "a", [orphan])) == 1

    unlabelled = _with_security_row(dict(document, holdings=[dict(r) for r in document["holdings"]]), pct=None)
    del unlabelled["security_matched_pct"]
    assert validate.validate(write_release(tmp_path / "b", [unlabelled])) == 1


# --- the manifest ---------------------------------------------------------------------------


def test_the_f_namespace_is_declared_only_when_a_cache_was_used():
    assert "f_" not in build._identity_namespaces(None, {})
    cache = share_map({ISIN_A: accepted()})
    declared = build._identity_namespaces(None, {companies.RUNG_FIGI: 7}, cache)["f_"]
    assert declared["counts_toward_coverage"] is True
    assert declared["rows"] == {"figi_security": 7}
    assert declared["cache"]["accepted"] == 1 and declared["cache"]["version"] == figi.CACHE_VERSION
    assert "Mutual Fund" not in json.dumps(declared)


# --- the two switches are off unless asked for ----------------------------------------------


def test_r3x_is_off_by_default_because_it_changes_published_numbers():
    """H-CV7: a number-changing rung ships as a staged release the owner compares, never silently."""
    import inspect

    assert inspect.signature(build.build_release).parameters["isin_direct_join"].default is False
    assert inspect.signature(build.build_release).parameters["figi_cache"].default is None
    assert inspect.signature(build.build_release).parameters["share_map"].default is None


def test_both_switches_are_command_line_flags(capsys):
    with pytest.raises(SystemExit):
        build.main(["--help"])
    help_text = capsys.readouterr().out
    assert "--isin-direct-join" in help_text and "--figi-cache" in help_text
