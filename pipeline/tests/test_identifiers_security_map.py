"""The security side of the identity layer: FIGI recognition and the release's map.

Two things are tested here, and only one of them can be checked by eye.

*The check digit is the risky one.* A validator that accepts a bad FIGI is silent:
it marks a published row **identified** when it is not, and a downstream gate that
recomputes the same flag from the same function cannot catch it. So the tests below
pin real FIGIs taken from the layer, prove that every wrong last digit is refused,
and prove that the generator reproduces the digit instead of merely agreeing with
itself. One case is hand-calculated, per the repo's rule that a new computed value
ships with an independently derived expected value.

*The loader* is tested through synthetic directories: merge order, upper-casing, the
newest-directory rule, what counts as a reject, that a layer with no maps is not the
same as no layer, and that a build without a layer gets ``None`` rather than an
exception.

What may appear in this file: FIGIs, which OpenFIGI dedicates to the public domain,
and synthetic map keys. No ISIN, CUSIP or LEI value is written here — invariant I1
(``compliance-licensing-guard``), which also means the loader's log is asserted to
carry counts only.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from pipeline import identifiers
from pipeline.identifiers import (
    FIGI_RE,
    IdentifierError,
    SecurityMap,
    figi_check_digit,
    load_security_map,
    valid_figi,
)
from pipeline.nport import parse

# --- real FIGIs, taken from the layer --------------------------------------
#
# Real values, and deliberately so: a synthetic one would only prove the function
# agrees with itself. FIGIs are public domain (OpenFIGI's terms) and are not a
# security's licensed identifier, so they are safe to commit. Verified 2026-11-04
# against layer ``2026-10-30.5``.
#
# ``BBG000DKRVC9`` is a composite FIGI (a security across venues);
# ``BBG01NJ93237`` is a venue-level one, which is all a bond record carries. Between
# them the doubled and un-doubled positions both see letters, so both branches of
# the check-digit loop are exercised by real data.

REAL_FIGI_COMPOSITE = "BBG000DKRVC9"
REAL_FIGI_VENUE = "BBG01NJ93237"
REAL_FIGIS = (REAL_FIGI_COMPOSITE, REAL_FIGI_VENUE)

#: The same value upper-cased is what a normalising caller gets; the raw lowercase
#: form must be refused by ``valid_figi`` itself.
REAL_FIGI_LOWER = REAL_FIGI_COMPOSITE.lower()

#: A synthetic-but-valid FIGI: ``BBG`` plus eight zeros. The hand calculation of its
#: check digit (7, not read back from the implementation) is in
#: ``test_check_digit_is_the_hand_calculated_value``.
SYNTHETIC_FIGI = "BBG000000007"
SYNTHETIC_BODY = "BBG00000000"

# --- synthetic map keys ----------------------------------------------------
#
# The layer's keys are ISINs in practice, so the tests use ISIN-*shaped* strings with
# a real ISO 6166 check digit and an empty body — no security's ISIN. This is the
# same convention ``test_identifiers`` uses, and it is the only identifier-shaped
# thing this file writes.


def synthetic_key(serial: int) -> str:
    """A well-formed ISIN-shaped key that belongs to no security."""
    body = f"XS{serial:09d}"
    return body + identifiers.isin_check_digit(body)


KEY_ALPHA = synthetic_key(1)
KEY_BETA = synthetic_key(2)
KEY_COLLIDED = synthetic_key(3)
KEY_UNRESOLVED = synthetic_key(4)


# --- the check digit -------------------------------------------------------


@pytest.mark.parametrize("value", REAL_FIGIS)
def test_a_real_figi_from_the_layer_is_valid(value):
    assert valid_figi(value) is True


@pytest.mark.parametrize("value", REAL_FIGIS)
def test_the_generator_reproduces_the_real_check_digit(value):
    assert figi_check_digit(value[:11]) == value[11]


def test_check_digit_is_the_hand_calculated_value():
    """Worked by hand, not read back from the implementation.

    Body ``BBG00000000``: values are B=11, B=11, G=16, then eight zeros. Positions
    2, 4, 6, 8 and 10 double; position 2 is the second B, so 2 × 11 = 22 → 2 + 2 = 4,
    every other doubled position is a zero. The plain positions are B → 1 + 1 = 2
    and G → 1 + 6 = 7. Sum = 4 + 2 + 7 = 13, so the digit is (10 − 3) mod 10 = 7.
    """
    assert figi_check_digit(SYNTHETIC_BODY) == "7"
    assert valid_figi(SYNTHETIC_FIGI) is True


@pytest.mark.parametrize("value", REAL_FIGIS)
def test_no_wrong_check_digit_is_accepted(value):
    """A one-digit corruption is exactly the failure this must not miss."""
    wrong = [str(digit) for digit in range(10) if str(digit) != value[-1]]
    assert wrong, "a FIGI's last character is a digit"
    for digit in wrong:
        assert valid_figi(value[:11] + digit) is False


def test_a_corrupted_check_digit_is_rejected_by_name():
    corrupted = REAL_FIGI_COMPOSITE[:11] + str((int(REAL_FIGI_COMPOSITE[-1]) + 1) % 10)
    assert corrupted != REAL_FIGI_COMPOSITE
    assert valid_figi(corrupted) is False


@pytest.mark.parametrize(
    "candidate",
    [
        None,
        "",
        "N/A",
        "0",
        "NA",
        REAL_FIGI_COMPOSITE[:11],  # the body alone is not a FIGI
        REAL_FIGI_COMPOSITE + "7",  # too long
        REAL_FIGI_LOWER,  # lowercase is not normalised here
        " " + REAL_FIGI_COMPOSITE,  # nor is whitespace
        REAL_FIGI_COMPOSITE + " ",
        REAL_FIGI_COMPOSITE[:5] + " " + REAL_FIGI_COMPOSITE[6:],
        "BBX" + REAL_FIGI_COMPOSITE[3:],  # the prefix is part of the format
        REAL_FIGI_COMPOSITE[:11] + "A",  # a check digit is a digit
    ],
)
def test_valid_figi_rejects_everything_that_is_not_a_figi(candidate):
    assert valid_figi(candidate) is False


def test_the_body_pattern_is_three_letters_and_eight_alphanumerics():
    assert FIGI_RE.match(REAL_FIGI_COMPOSITE[:11]) is not None
    assert FIGI_RE.match(REAL_FIGI_COMPOSITE) is None
    assert FIGI_RE.match("BBG0000000") is None


@pytest.mark.parametrize("body", ["", "N/A", "bbg0000dkrvc", "BBG000DKRV", "BBG000DKRVCZ"])
def test_the_generator_refuses_a_body_that_is_not_a_figi_body(body):
    with pytest.raises(IdentifierError):
        figi_check_digit(body)


# --- the map object --------------------------------------------------------


def security_map(**overrides) -> SecurityMap:
    fields = {
        "release": "2026-10-30.5",
        "figi_by_key": {KEY_ALPHA: REAL_FIGI_COMPOSITE, KEY_BETA: REAL_FIGI_VENUE},
        "figis": frozenset({REAL_FIGI_COMPOSITE, REAL_FIGI_VENUE}),
        "sources": {"isin_map.json": 2, "isin_map.json:rejected": 0},
    }
    fields.update(overrides)
    return SecurityMap(**fields)


def test_figi_of_prefers_the_map_and_normalises_the_key():
    mapping = security_map()
    assert mapping.figi_of(KEY_ALPHA) == REAL_FIGI_COMPOSITE
    assert mapping.figi_of(" " + KEY_ALPHA.lower() + " ") == REAL_FIGI_COMPOSITE


def test_figi_of_accepts_a_value_that_is_itself_a_figi():
    """A filing can carry the FIGI directly; the map must not discard it."""
    mapping = security_map(figi_by_key={})
    assert mapping.figi_of(REAL_FIGI_VENUE) == REAL_FIGI_VENUE
    assert mapping.figi_of(REAL_FIGI_VENUE.lower()) == REAL_FIGI_VENUE


def test_figi_of_takes_the_first_value_that_resolves():
    mapping = security_map()
    assert mapping.figi_of(None, "", "N/A", KEY_BETA, KEY_ALPHA) == REAL_FIGI_VENUE


def test_an_identifier_the_layer_never_resolved_names_no_security():
    """The distinction the release publishes: seen is not named."""
    mapping = security_map()
    assert mapping.figi_of(KEY_UNRESOLVED) is None
    assert mapping.has(KEY_UNRESOLVED) is False


def test_has_is_true_for_any_value_that_names_a_security():
    mapping = security_map()
    assert mapping.has(KEY_ALPHA) is True
    assert mapping.has(KEY_UNRESOLVED, REAL_FIGI_VENUE) is True
    assert mapping.has(None, "", "not-a-figi") is False


def test_the_map_is_immutable():
    mapping = security_map()
    with pytest.raises(AttributeError):
        mapping.release = "2026-11-01.1"  # type: ignore[misc]


# --- the loader ------------------------------------------------------------


def write_layer(directory: Path, name: str, document: object) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / name
    path.write_text(json.dumps(document))
    return path


def layer_document() -> dict:
    """Two good records, one bad check digit and one placeholder — the reject path."""
    return {
        KEY_ALPHA: {"composite_figi": REAL_FIGI_COMPOSITE, "exch_code": "UH"},
        KEY_BETA: {"figi": REAL_FIGI_VENUE},  # no composite FIGI: fixed income's shape
        KEY_COLLIDED: {"composite_figi": REAL_FIGI_COMPOSITE[:-1] + "0"},  # bad digit
        KEY_UNRESOLVED: {"composite_figi": "N/A"},
    }


def test_the_loader_reads_a_named_layer_directory_and_counts_each_source(tmp_path):
    directory = tmp_path / "2026-10-30.5"
    write_layer(directory, "isin_map.json", layer_document())

    mapping = load_security_map(directory)

    assert mapping is not None
    assert mapping.release == "2026-10-30.5"
    assert sorted(mapping.figi_by_key) == sorted([KEY_ALPHA, KEY_BETA])
    assert mapping.figi_by_key[KEY_ALPHA] == REAL_FIGI_COMPOSITE
    # A record with only a venue-level FIGI still names its security.
    assert mapping.figi_by_key[KEY_BETA] == REAL_FIGI_VENUE
    assert mapping.sources == {"isin_map.json": 2, "isin_map.json:rejected": 2}
    assert mapping.figis == frozenset({REAL_FIGI_COMPOSITE, REAL_FIGI_VENUE})


def test_a_later_file_wins_a_collision(tmp_path):
    directory = tmp_path / "2026-10-30.5"
    write_layer(directory, "isin_map.json", layer_document())
    write_layer(directory, "cusip_map.json", {KEY_ALPHA: {"composite_figi": REAL_FIGI_VENUE}})

    mapping = load_security_map(directory)

    assert mapping is not None
    assert mapping.figi_of(KEY_ALPHA) == REAL_FIGI_VENUE
    assert mapping.sources["cusip_map.json"] == 1
    assert mapping.sources["cusip_map.json:rejected"] == 0


def test_the_newest_layer_with_maps_wins(tmp_path, monkeypatch):
    monkeypatch.setattr(identifiers.paths, "REPO_ROOT", tmp_path)
    older = tmp_path / "data" / "identifier-layer" / "2026-10-01.1"
    newer = tmp_path / "data" / "identifier-layer" / "2026-10-30.5"
    write_layer(older, "isin_map.json", {KEY_ALPHA: {"figi": REAL_FIGI_COMPOSITE}})
    write_layer(newer, "isin_map.json", {KEY_BETA: {"figi": REAL_FIGI_VENUE}})

    mapping = load_security_map()

    assert mapping is not None
    assert mapping.release == "2026-10-30.5"
    assert mapping.figi_of(KEY_BETA) == REAL_FIGI_VENUE
    assert mapping.figi_of(KEY_ALPHA) is None


def test_a_layer_directory_without_maps_does_not_hide_the_previous_one(tmp_path, monkeypatch):
    """A harvest writes a new release directory with its index only, at first."""
    monkeypatch.setattr(identifiers.paths, "REPO_ROOT", tmp_path)
    older = tmp_path / "data" / "identifier-layer" / "2026-10-01.1"
    newer = tmp_path / "data" / "identifier-layer" / "2026-10-30.5"
    write_layer(older, "isin_map.json", {KEY_ALPHA: {"figi": REAL_FIGI_COMPOSITE}})
    newer.mkdir(parents=True)
    (newer / "isin_index.json.gz").write_bytes(b"")

    mapping = load_security_map()

    assert mapping is not None
    assert mapping.release == "2026-10-01.1"


def test_no_layer_at_all_is_none_so_a_build_still_runs(tmp_path, monkeypatch):
    monkeypatch.setattr(identifiers.paths, "REPO_ROOT", tmp_path)
    assert load_security_map() is None
    assert load_security_map(tmp_path / "absent") is None


def test_an_unreadable_map_is_an_error_not_an_empty_map(tmp_path):
    directory = tmp_path / "2026-10-30.5"
    directory.mkdir()
    (directory / "isin_map.json").write_text("{not json")
    with pytest.raises(IdentifierError):
        load_security_map(directory)


def test_the_loader_logs_counts_and_never_a_value(tmp_path, capsys):
    directory = tmp_path / "2026-10-30.5"
    write_layer(directory, "isin_map.json", layer_document())

    load_security_map(directory)

    logged = capsys.readouterr()
    output = logged.out + logged.err
    assert "security map: isin_map.json" in output
    assert "2 identifiers to a FIGI" in output
    assert "2 rejected" in output
    # Invariant I1: an identifier value never reaches a log line.
    for key in (KEY_ALPHA, KEY_BETA, KEY_COLLIDED, KEY_UNRESOLVED):
        assert key not in output
        assert key.lower() not in output.lower()


# --- the parser: ``other`` identifiers -------------------------------------


OTHER_IDENTIFIERS_XML = b"""<edgarSubmission xmlns="http://www.sec.gov/edgar/nport">
  <headerData>
    <submissionType>NPORT-P</submissionType>
    <filerInfo><seriesClassInfo><seriesId>S000000001</seriesId></seriesClassInfo></filerInfo>
  </headerData>
  <formData>
    <genInfo><repPdDate>2026-06-30</repPdDate></genInfo>
    <fundInfo><netAssets>1000</netAssets></fundInfo>
    <invstOrSecs>
      <invstOrSec>
        <name>Synthetic Row</name>
        <identifiers>
          <other otherDesc="BBGID" value="bbg000dkrvc9"/>
          <other otherDesc="SEDOL" value="B0YQ5W0"/>
          <other otherDesc="Duplicate" value=" BBG000DKRVC9 "/>
          <other otherDesc="N/A" value="N/A"/>
          <other otherDesc="Blank" value="   "/>
          <other otherDesc="Text">BBG01NJ93237</other>
        </identifiers>
      </invstOrSec>
      <invstOrSec>
        <name>Row With No Identifiers</name>
        <identifiers><ticker value="SYN"/></identifiers>
      </invstOrSec>
      <invstOrSec><name>Row With No Identifiers Subtree</name></invstOrSec>
    </invstOrSecs>
  </formData>
</edgarSubmission>"""


def test_other_ids_are_upper_cased_deduped_and_kept_in_filed_order():
    """The value is in the ``value`` attribute; text is the schema's other spelling."""
    filing = parse(OTHER_IDENTIFIERS_XML)
    assert filing.holdings[0].other_ids == (
        REAL_FIGI_COMPOSITE.upper(),
        "B0YQ5W0",
        REAL_FIGI_VENUE,
    )


def test_a_row_without_other_children_has_no_other_ids():
    filing = parse(OTHER_IDENTIFIERS_XML)
    assert filing.holdings[1].other_ids == ()
    assert filing.holdings[2].other_ids == ()


def test_other_ids_default_to_empty_on_a_hand_built_holding():
    """Trailing and defaulted, so every existing constructor still works."""
    from pipeline import fixtures

    assert fixtures.sample_filing().holdings[0].other_ids == ()


# --- the layer selector --------------------------------------------------------------
#
# Found by a real build on 2026-11-04: a harvest that writes into a working directory
# beside the release directories (`identifier-layer/live/`) made `newest_layer_with_maps`
# pick `live` out of the lexical sort, and the build then read a 48 kB partial map
# *instead of* the 283,974-key layer sitting beside it. It did not fail loudly — it
# published almost no security identity, which is the quiet version of the same bug.

def _layer(tmp_path, name, payload):
    layer = tmp_path / name
    layer.mkdir()
    (layer / "isin_map.json").write_text(json.dumps(payload))
    return layer


def test_a_working_directory_never_outranks_a_release(tmp_path):
    _layer(tmp_path, "2026-10-30.5", {"A": {"composite_figi": REAL_FIGI_COMPOSITE}})
    _layer(tmp_path, "live", {"B": {"composite_figi": REAL_FIGI_COMPOSITE}})

    assert identifiers.newest_layer_with_maps(tmp_path).name == "2026-10-30.5"


def test_the_newest_layer_is_the_newest_date_not_the_last_path(tmp_path):
    _layer(tmp_path, "2026-09-30.10", {"A": {"composite_figi": REAL_FIGI_COMPOSITE}})
    _layer(tmp_path, "2026-10-04", {"A": {"composite_figi": REAL_FIGI_COMPOSITE}})

    assert identifiers.newest_layer_with_maps(tmp_path).name == "2026-10-04"


def test_a_same_day_suffix_orders_above_the_bare_date(tmp_path):
    _layer(tmp_path, "2026-11-04", {"A": {"composite_figi": REAL_FIGI_COMPOSITE}})
    _layer(tmp_path, "2026-11-04.2", {"A": {"composite_figi": REAL_FIGI_COMPOSITE}})

    assert identifiers.newest_layer_with_maps(tmp_path).name == "2026-11-04.2"


def test_a_release_directory_without_a_map_is_skipped(tmp_path):
    _layer(tmp_path, "2026-10-30.5", {"A": {"composite_figi": REAL_FIGI_COMPOSITE}})
    (tmp_path / "2026-11-04").mkdir()
    (tmp_path / "2026-11-04" / "harvest.json").write_text("{}")

    assert identifiers.newest_layer_with_maps(tmp_path).name == "2026-10-30.5"


def test_no_layer_at_all_returns_none(tmp_path):
    assert identifiers.newest_layer_with_maps(tmp_path) is None
