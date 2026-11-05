"""The CUSIP half of the identifier layer: the shapes, the split, and the silence.

`scripts/harvest_identifiers.py` is a script, not a package module, so it is loaded
by path. Everything here is offline and deterministic: the enumeration and the
harvest are exercised against the running pipeline's cache in the real pass, and
what this file pins is the part a live run cannot prove — that the arithmetic is
right and that **no identifier value reaches a line of output**.

Every value in this file is synthetic. The CUSIPs are ``12345678`` and ``12345A7B``
with check digits computed by hand from the mod-10 double-add rule, not copied from
any real security.
"""

from __future__ import annotations

import importlib.util
import json
import pathlib
import sys

import pytest

SCRIPT = pathlib.Path(__file__).resolve().parents[2] / "scripts" / "harvest_identifiers.py"


def load_script():
    """Load ``scripts/harvest_identifiers.py`` as a module without running ``main``."""
    spec = importlib.util.spec_from_file_location("harvest_identifiers_script", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def script():
    return load_script()


# --- the shape rule --------------------------------------------------------


@pytest.mark.parametrize(
    "value",
    ["123456782", "12345A7B6", "555666771", " 123456782 ", "123456782".lower()],
)
def test_valid_cusip_accepts_nine_characters(script, value):
    assert script.valid_cusip(value)


@pytest.mark.parametrize(
    "value",
    ["", None, "12345678", "1234567821", "12345678Z", "ABC", "1234 6782", "XS0000000001"],
)
def test_valid_cusip_rejects_everything_else(script, value):
    assert not script.valid_cusip(value)


def test_check_digit_agrees_with_the_hand_computed_values(script):
    # 1,3,5,7 doubled-and-summed at the even positions: total 38 → check 2.
    assert script._cusip_check_digit_ok("123456782")
    assert not script._cusip_check_digit_ok("123456789")
    # 12345A7B: A=10 and B=11, doubled at positions 6 and 8 → total 34 → check 6.
    assert script._cusip_check_digit_ok("12345A7B6")
    assert not script._cusip_check_digit_ok("12345A7B0")


def test_check_digit_is_a_quality_count_not_a_filter(script):
    """A well-formed CUSIP with a wrong check digit is still *asked about*.

    Filtering on the check digit would silently drop a real identifier whose filed
    form has a typo, which is worse than spending one job on it. The count exists so
    a reader can see how much of the frame is only phonetically a CUSIP.
    """
    assert script.valid_cusip("123456789")
    assert not script._cusip_check_digit_ok("123456789")


# --- the request body ------------------------------------------------------


def test_request_body_sends_the_cusip_job_type(script):
    body = script._request_body(["123456782", "12345A7B6"])
    assert body == (
        b'[{"idType": "ID_CUSIP", "idValue": "123456782"}, '
        b'{"idType": "ID_CUSIP", "idValue": "12345A7B6"}]'
    )


def test_the_two_passes_cannot_collide_in_the_shared_cache(script):
    """Same value, different idType, different request hash — one cache, two passes.

    The response cache is content-addressed on the request body, so this is the whole
    isolation argument between `harvest` and `harvest-cusip`: nothing about the pass
    is in the key except the body, and the body carries the type.
    """
    from pipeline import identifiers

    value = "123456782"
    as_isin = identifiers._request_body([value])
    as_cusip = script._request_body([value])
    assert as_isin != as_cusip
    assert identifiers.cache_key(as_isin) != identifiers.cache_key(as_cusip)
    # And the same body hashes the same twice, which is what makes a re-run free.
    assert identifiers.cache_key(as_cusip) == identifiers.cache_key(script._request_body([value]))


# --- the enumeration document ---------------------------------------------


def fake_document():
    """Two values, one from the CUSIP column and one from the ticker column."""
    return {
        "totals": {
            "gross_bp": 1_000_000.0,
            "bp_with_cusip": 250_000.0,
            "bp_cusip_only": 50_000.0,
            "joined_rows": 3,
        },
        "values": [["123456782", "cusip"], ["12345A7B6", "ticker"]],
        "value_bp": {"123456782": 200_000.0, "12345A7B6": 50_000.0},
        "rows": [
            [200_000.0, "equity", 1, [0]],
            [40_000.0, "equity", 0, [1]],
            [10_000.0, "fund", 0, [0, 1]],
        ],
    }


def test_distinct_by_source_counts_each_value_once(script):
    assert script.distinct_by_source(fake_document()) == {"cusip": 1, "ticker": 1}


def test_coverage_bp_reads_the_frame_off_the_totals(script):
    assert script.coverage_bp(fake_document()) == 250_000.0


def test_the_enumeration_line_is_a_count_and_no_identifier(script):
    """The one-line summary states weight and counts, and names no value."""
    line = script.enum_line(fake_document())
    assert "2 distinct values" in line
    assert "250,000 bp" in line
    assert "25.00% of 1,000,000 published gross" in line
    for value in ("123456782", "12345A7B6"):
        assert value not in line
        assert value.lower() not in line.lower()


def test_enum_line_survives_an_empty_release(script):
    line = script.enum_line({"totals": {}, "values": [], "rows": []})
    assert "0 distinct values" in line
    assert "none" in line


# --- the marginal question: what did the ISIN pass not already have? --------


def test_build_splits_the_marginal_against_a_previous_isin_layer(script, tmp_path):
    """Four buckets, each a different answer about the previous pass.

    A row whose CUSIP resolves is only *new* coverage if the ISIN pass had not
    already resolved it. The three ways it might have are distinguished here —
    already resolved, asked and failed, never asked — plus the row that carried no
    ISIN at all, which the ISIN pass could not reach by construction.
    """
    from pipeline import identifiers

    cache = tmp_path / "cache"
    root = tmp_path / "identifier-layer"
    layer = root / "2026-11-04"
    previous = root / "2026-10-30.5"
    layer.mkdir(parents=True)
    previous.mkdir(parents=True)

    resolved_value, rejected_value = "123456782", "12345A7B6"
    isins = ["XS0000000001", "XS0000000002", "XS0000000003"]
    rows = [
        [1_000.0, "equity", -1, [0]],   # no ISIN at all → new
        [2_000.0, "equity", 0, [0]],    # ISIN resolved before → already covered
        [4_000.0, "equity", 1, [0]],    # ISIN asked and failed before → new
        [8_000.0, "fund", 2, [0]],      # ISIN never asked before → new
        [16_000.0, "fund", -1, [1]],    # CUSIP did not resolve → unresolved
    ]
    document = {
        "values": [[resolved_value, "cusip"], [rejected_value, "cusip"]],
        "isins": isins,
        "value_bp": {resolved_value: 15_000.0, rejected_value: 16_000.0},
        "totals": {
            "gross_bp": 100_000.0,
            "bp_with_cusip": 31_000.0,
            "joined_rows": len(rows),
            "published_target_bp": 31_000.0,
        },
        "rows": rows,
    }

    body = script._request_body([resolved_value, rejected_value])
    key = identifiers.cache_key(body)
    (layer / "harvest.json").write_text(
        json.dumps(
            {
                "batches": [
                    {
                        "key": key,
                        "values": [resolved_value, rejected_value],
                        "status": "requested",
                        "attempts": 1,
                    }
                ],
                "stats": {"requests_total": 1},
            }
        )
    )
    identifiers.write_cached_body(
        cache,
        key,
        json.dumps(
            [{"data": [{"figi": "BBG000000001"}]}, {"error": "No identifier found."}]
        ).encode(),
    )
    (previous / "isin_map.json").write_text(json.dumps({"XS0000000001": {"figi": "BBG000000009"}}))
    identifiers._write_gzip_json(
        previous / "isin_index.json.gz",
        {
            "funds": {
                "AAA": {
                    "rows": [
                        ["XS0000000001", "equity", 1.0],
                        ["XS0000000002", "equity", 2.0],
                    ]
                }
            }
        },
    )

    _mapping, measurement, report = script.build_cusips(
        document,
        release=tmp_path / "release",
        layer_dir=layer,
        cache_dir=cache,
        top=0,
    )

    weight = measurement["weight"]
    assert weight["resolved_bp"] == 15_000.0
    assert weight["unresolved_bp"] == 16_000.0
    assert weight["unresolved_bp_in_frame"] == 16_000.0
    assert weight["out_of_frame_bp"] == 0.0
    assert weight["resolved_bp_no_isin"] == 1_000.0
    assert weight["resolved_bp_isin_covered_before"] == 2_000.0
    assert weight["resolved_bp_isin_unresolved_before"] == 4_000.0
    assert weight["resolved_bp_isin_never_asked"] == 8_000.0
    assert weight["new_bp_total"] == 13_000.0
    assert measurement["distinct"]["values_resolved"] == 1
    assert measurement["distinct"]["values_unresolved"] == 1
    assert measurement["compared_against"]["isins_asked_before"] == 2
    assert measurement["compared_against"]["isins_resolved_before"] == 1
    assert (layer / "cusip_map.json").is_file()
    assert "13,000 bp newly identifiable" in report
    for value in (resolved_value, rejected_value):
        assert value not in report
        assert value not in json.dumps(measurement)


def test_a_re_run_issues_no_requests(script, tmp_path):
    """The second pass over a warm cache spends nothing — the acceptance check."""
    from pipeline import identifiers

    cache = tmp_path / "cache"
    layer = tmp_path / "identifier-layer" / "2026-11-04"
    layer.mkdir(parents=True)
    value = "123456782"
    document = {
        "values": [[value, "cusip"]],
        "isins": [],
        "value_bp": {value: 1_000.0},
        "totals": {"gross_bp": 100_000.0, "bp_with_cusip": 1_000.0, "joined_rows": 1},
        "rows": [[1_000.0, "equity", -1, [0]]],
    }
    release = tmp_path / "release"
    (release / "funds").mkdir(parents=True)

    body = script._request_body([value])
    key = identifiers.cache_key(body)
    identifiers.write_cached_body(
        cache, key, json.dumps([{"data": [{"figi": "BBG000000001"}]}]).encode()
    )

    def transport(*_args, **_kwargs):
        raise AssertionError("a warm cache must not reach the network")

    run = script.harvest_cusips(
        document,
        release=release,
        layer_dir=layer,
        cache_dir=cache,
        transport=transport,
        jobs_per_request=100,
        rpm=250.0,
    )
    assert run.requests == 0
    assert run.batches_cached == 1
    assert run.values_resolved == 1
    record = json.loads((layer / "harvest.json").read_text())
    assert record["stats"]["requests"] == 0
    assert record["id_type"] == "ID_CUSIP"
    # The record is deterministic: an idle re-run rewrites the same bytes.
    before = (layer / "harvest.json").read_bytes()
    # Same pinned settings, because the record says what the pass spent per request.
    script.harvest_cusips(
        document,
        release=release,
        layer_dir=layer,
        cache_dir=cache,
        transport=transport,
        jobs_per_request=100,
        rpm=250.0,
    )
    assert (layer / "harvest.json").read_bytes() == before


# --- publishing: a date-named directory is a promise to every other tool -----


def test_a_layer_is_published_only_when_it_is_whole(script, tmp_path):
    """A reader that finds one map in `2026-11-04/` will use the layer.

    So the directory must not exist until every file it claims to have is in place,
    and a second publish must refuse rather than merge into a live layer.
    """
    import pytest

    root = tmp_path / "identifier-layer"
    staging = root / "2026-11-04.staging"
    staging.mkdir(parents=True)
    (staging / "cusip_index.json.gz").write_text("{}")
    (staging / "cusip_map.json").write_text("{}")
    with pytest.raises(script.CusipError) as incomplete:
        script.promote_layer(staging)
    assert "missing" in str(incomplete.value)
    assert not (root / "2026-11-04").exists()

    (staging / "measurement.json").write_text("{}")
    (staging / "harvest.json").write_text("{}")
    published = script.promote_layer(staging)
    assert published == root / "2026-11-04"
    assert (published / "cusip_map.json").is_file()
    assert not staging.exists()

    staging.mkdir()
    for name in ("cusip_index.json.gz", "cusip_map.json", "measurement.json", "harvest.json"):
        (staging / name).write_text("{}")
    with pytest.raises(script.CusipError) as immutable:
        script.promote_layer(staging)
    assert "immutable" in str(immutable.value)
    assert (published / "cusip_map.json").is_file()


def test_the_default_layer_is_a_staging_directory(script, tmp_path):
    """The default must never be a date, or a half-written pass becomes a release."""
    layer = script.layer_for(tmp_path, None)
    assert layer.name.endswith(script.STAGING_SUFFIX)
    assert script.final_layer_name(layer) == layer.name[: -len(script.STAGING_SUFFIX)]
