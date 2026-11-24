"""SEDOL as an internal OpenFIGI lookup key (owner approval 2026-11-24).

A row with no ISIN may still be a known share line. These tests hold the rules that make that safe:

* a SEDOL is read only when the filing labels it, and only a check-digit-valid one is sent;
* its cache keys live in their own namespace and every ISIN key is unchanged;
* the ISIN decides when OpenFIGI names it; a refused ISIN is final; SEDOLs must agree;
* no SEDOL is ever written to the cache file or to a published document.

Every SEDOL here is synthetic (check digit computed, never a real security's).
"""

from __future__ import annotations

import json

import pytest

from pipeline import figi, identifiers, nport, weights
from pipeline.fixtures import sample_index

from .test_figi import FIGI_A, FIGI_B, ISIN_A, PEPPER, TODAY, Clock, record, synthetic_isin
from .test_security_rungs import accepted, holding, share_map

_CHARS = "0123456789BCDFGHJKLMNPQRSTVWXYZ"


def synthetic_sedol(serial: int) -> str:
    body = "".join(_CHARS[(serial * m + i) % len(_CHARS)] for i, m in enumerate((3, 5, 7, 11, 13, 17)))
    for digit in "0123456789":
        if identifiers.valid_sedol(body + digit):
            return body + digit
    raise AssertionError("a SEDOL always has one check digit")


SEDOL_A, SEDOL_B, SEDOL_C = synthetic_sedol(1), synthetic_sedol(2), synthetic_sedol(3)


def sedol_map(*pairs: tuple[str, figi.Answer]) -> figi.ShareClassMap:
    cache = figi.ShareClassMap.empty(PEPPER)
    for sedol, answer in pairs:
        cache.merge({sedol: answer}, figi.KIND_SEDOL)
    return cache


# --- the check digit ----------------------------------------------------------------------------


def test_the_published_sedol_example_is_valid():
    assert identifiers.valid_sedol("0263494")  # BAE Systems, the worked example in LSEG's own guide


@pytest.mark.parametrize("value", [SEDOL_A, SEDOL_B, SEDOL_C, " " + SEDOL_A.lower() + " "])
def test_a_synthetic_sedol_is_valid(value):
    assert identifiers.valid_sedol(value)


@pytest.mark.parametrize(
    "value",
    ["0263495", "026349", "02634944", "AEIOU12", "", None, "B0YQ5WO", "B0YQ5W!"],
)
def test_a_wrong_check_digit_length_vowel_or_symbol_is_refused(value):
    assert not identifiers.valid_sedol(value)


# --- the filing: only a labelled SEDOL ------------------------------------------------------------


def _filing(others: str) -> nport.Filing:
    xml = f"""<edgarSubmission xmlns="http://www.sec.gov/edgar/nport">
  <headerData><submissionType>NPORT-P</submissionType>
    <filerInfo><seriesClassInfo><seriesId>S000000001</seriesId></seriesClassInfo></filerInfo></headerData>
  <formData><genInfo><repPdDate>2026-06-30</repPdDate></genInfo><fundInfo><netAssets>1000</netAssets></fundInfo>
    <invstOrSecs><invstOrSec><name>Row</name><identifiers>{others}</identifiers></invstOrSec></invstOrSecs>
  </formData></edgarSubmission>""".encode()
    return nport.parse(xml)


def test_only_a_value_the_filing_labels_sedol_is_captured():
    filing = _filing(
        f'<other otherDesc="SEDOL" value="{SEDOL_A.lower()}"/>'
        f'<other otherDesc="sedol" value="{SEDOL_A}"/>'  # duplicate, other case
        f'<other otherDesc="Internal" value="{SEDOL_B}"/>'  # unlabelled: could be any code
        '<other otherDesc="SEDOL" value="TOOLONGVALUE"/>'  # not 7 characters
        '<other otherDesc="SEDOL" value="N/A"/>'
    )
    assert filing.holdings[0].sedols == (SEDOL_A,)


def test_a_row_without_a_sedol_has_none():
    assert _filing("").holdings[0].sedols == ()


# --- the cache: its own namespace -----------------------------------------------------------------


def test_the_key_is_namespaced_and_isin_keys_are_unchanged():
    import hashlib
    import hmac

    legacy = hmac.new(PEPPER, b"isin:" + ISIN_A.encode(), hashlib.sha256).hexdigest()[:32]
    assert figi.cache_key(PEPPER, ISIN_A) == legacy, "the cache already in R2 must stay valid"
    assert figi.cache_key(PEPPER, SEDOL_A, figi.KIND_SEDOL) != figi.cache_key(PEPPER, SEDOL_A)


def test_the_cache_file_holds_no_sedol_and_passes_the_shape_check(tmp_path):
    cache = sedol_map((SEDOL_A, accepted()))
    path = tmp_path / "c.jsonl"
    cache.write(path)
    text = path.read_text()
    assert SEDOL_A not in text and SEDOL_A.lower() not in text
    assert figi.verify_cache_shape(path) == 1


# --- the lookup order ------------------------------------------------------------------------------


def test_a_row_with_no_isin_gets_its_f_id_from_its_sedol():
    cache = sedol_map((SEDOL_A, accepted(FIGI_A)))
    assert cache.security_for_row(None, (SEDOL_A,)) == figi.security_id(FIGI_A)


def test_an_unknown_sedol_gives_nothing():
    assert sedol_map().security_for_row(None, (SEDOL_A,)) is None
    assert sedol_map((SEDOL_A, figi.Answer("NO_MATCH", TODAY))).security_for_row(None, (SEDOL_A,)) is None


def test_an_accepted_isin_wins_over_a_sedol():
    cache = sedol_map((SEDOL_A, accepted(FIGI_B)))
    cache.merge({ISIN_A: accepted(FIGI_A)})
    assert cache.security_for_row(ISIN_A, (SEDOL_A,)) == figi.security_id(FIGI_A)


def test_an_isin_openfigi_named_and_refused_is_final():
    cache = sedol_map((SEDOL_A, accepted(FIGI_B)))
    cache.merge({ISIN_A: accepted(FIGI_A, type2="Mutual Fund")})
    assert cache.security_for_row(ISIN_A, (SEDOL_A,)) is None


def test_an_isin_with_no_match_falls_back_to_the_sedol():
    cache = sedol_map((SEDOL_A, accepted(FIGI_B)))
    cache.merge({ISIN_A: figi.Answer("NO_MATCH", TODAY)})
    assert cache.security_for_row(ISIN_A, (SEDOL_A,)) == figi.security_id(FIGI_B)


def test_sedols_that_disagree_refuse_the_row():
    cache = sedol_map((SEDOL_A, accepted(FIGI_A)), (SEDOL_B, accepted(FIGI_B)))
    assert cache.security_for_row(None, (SEDOL_A, SEDOL_B)) is None


def test_sedols_that_agree_give_one_id():
    cache = sedol_map((SEDOL_A, accepted(FIGI_A)), (SEDOL_B, accepted(FIGI_A)))
    assert cache.security_for_row(None, (SEDOL_A, SEDOL_B)) == figi.security_id(FIGI_A)


def test_a_refused_sedol_vetoes_an_accepted_one():
    cache = sedol_map((SEDOL_A, accepted(FIGI_A)), (SEDOL_B, accepted(FIGI_B, type2="Mutual Fund")))
    assert cache.security_for_row(None, (SEDOL_A, SEDOL_B)) is None


# --- the refresh ------------------------------------------------------------------------------------


class TypedFake:
    """Answers by (idType, value) and records what it was asked."""

    def __init__(self, table):
        self.table, self.asked = table, []

    def __call__(self, body, headers):
        jobs = json.loads(body)
        self.asked.append([(j["idType"], j["idValue"]) for j in jobs])
        payload = [
            {"data": [self.table[(j["idType"], j["idValue"])]]}
            if (j["idType"], j["idValue"]) in self.table
            else {"warning": "No identifier found."}
            for j in jobs
        ]
        return 200, {}, json.dumps(payload).encode()


def _refresh(tmp_path, transport, isins, sedols):
    clock = Clock()
    return figi.refresh(
        isins, sedols, cache_path=tmp_path / "c.jsonl", pepper=PEPPER, api_key="test-key-not-real",
        today=TODAY, transport=transport, sleep=clock.sleep, clock=clock.time,
    )


def test_sedols_are_sent_as_id_sedol_and_isins_as_id_isin(tmp_path):
    transport = TypedFake({("ID_SEDOL", SEDOL_A): record(FIGI_A), ("ID_ISIN", ISIN_A): record(FIGI_B)})
    stats = _refresh(tmp_path, transport, [ISIN_A], [SEDOL_A, "not-a-sedol"])
    assert sorted(job for batch in transport.asked for job in batch) == sorted(
        [("ID_ISIN", ISIN_A), ("ID_SEDOL", SEDOL_A)]
    )
    assert (stats.asked, stats.sedols_asked, stats.ok) == (1, 1, 2)
    cache = figi.ShareClassMap.load(tmp_path / "c.jsonl", PEPPER)
    assert cache.security_for_row(None, (SEDOL_A,)) == figi.security_id(FIGI_A)
    assert SEDOL_A not in (tmp_path / "c.jsonl").read_text()


def test_a_second_run_asks_for_nothing(tmp_path):
    transport = TypedFake({("ID_SEDOL", SEDOL_A): record(FIGI_A)})
    _refresh(tmp_path, transport, [], [SEDOL_A])
    again = TypedFake({})
    stats = _refresh(tmp_path, again, [], [SEDOL_A])
    assert again.asked == [] and stats.sedols_asked == 0


# --- the build -----------------------------------------------------------------------------------------


def test_a_sedol_only_row_becomes_an_f_company_and_counts_toward_coverage():
    cache = sedol_map((SEDOL_A, accepted(FIGI_A)))
    rows = [holding("Foreign Co Ltd", 100.0, sedols=(SEDOL_A,))]
    total = 100.0
    vec = weights.build_vector(rows, sample_index(), total, lag_days=59, share_map=cache)
    assert vec.holdings[0].company_id == figi.security_id(FIGI_A)
    assert vec.holdings[0].ticker is None
    assert vec.coverage_pct == 100.0
    assert SEDOL_A not in json.dumps(vec.holdings[0].__dict__, default=str)


def test_without_a_map_a_sedol_changes_nothing():
    rows = [holding("Foreign Co Ltd", 100.0, sedols=(SEDOL_A,))]
    with_sedol = weights.build_vector(rows, sample_index(), 100.0, lag_days=59)
    without = weights.build_vector([holding("Foreign Co Ltd", 100.0)], sample_index(), 100.0, lag_days=59)
    assert with_sedol.holdings == without.holdings
