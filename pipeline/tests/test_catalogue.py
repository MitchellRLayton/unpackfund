"""The objects a browser reads: shards, catalogue, and the reverse index.

These are the files a visitor's browser fetches, so each test here is about a
consumer's assumption rather than an internal detail: a shard must name the release
it belongs to, a company shard must be the reverse of the fund documents, and the
pointer document must describe the bytes next to it.
"""

from __future__ import annotations

import json

import pytest

from pipeline import catalogue, release, validate
from tests.conftest import fund_document, write_release


def test_shard_is_the_first_letter_and_underscore_for_the_rest():
    assert catalogue.shard_for("VOO") == "V"
    assert catalogue.shard_for("voo") == "V"
    assert catalogue.shard_for("1234") == catalogue.SHARD_OTHER
    assert catalogue.shard_for("-ABC") == catalogue.SHARD_OTHER
    assert catalogue.shard_for("") == catalogue.SHARD_OTHER


def test_index_shards_are_grouped_and_carry_the_release():
    files = [
        {"path": "funds/VOO.json", "bytes": 10, "sha256": "a" * 64},
        {"path": "funds/VTI.json", "bytes": 11, "sha256": "b" * 64},
        {"path": "funds/QQQ.json", "bytes": 12, "sha256": "c" * 64},
        {"path": "manifest.json", "bytes": 13, "sha256": "d" * 64},
    ]
    shards = catalogue.index_shards("2026-10-30.1", files)
    assert sorted(shards) == ["Q", "V"]
    assert sorted(shards["V"]["funds"]) == ["VOO", "VTI"]
    assert shards["V"]["funds"]["VTI"] == {"bytes": 11, "sha256": "b" * 64}
    assert shards["V"]["as_of"] == "2026-10-30.1"
    # A file that is not a fund is not in a fund shard.
    assert "manifest.json" not in json.dumps(shards)


def test_catalogue_entries_are_four_positional_fields():
    document = catalogue.catalogue_object(
        "2026-10-30.1",
        [
            {
                "ticker": "VOO",
                "name": "Vanguard 500 Index Fund",
                "issuer": "Vanguard",
                "etf": True,
                "coverage_pct": 96.7,
            }
        ],
    )
    assert document["funds"]["VOO"] == ["Vanguard 500 Index Fund", "Vanguard", 1, 96.7]


def test_company_shards_are_the_reverse_of_the_documents():
    document = fund_document()
    index, shards = catalogue.company_objects("2026-10-30.1", [document])

    holders: dict[str, dict[str, int]] = {}
    for holding in document["holdings"]:
        company_id = holding.get("company_id")
        if not company_id or holding["weight_bp"] == 0:
            continue
        holders.setdefault(company_id, {})[document["ticker"]] = (
            holders.setdefault(company_id, {}).get(document["ticker"], 0)
            + holding["weight_bp"]
        )

    assert {row[0] for row in index["companies"]} == set(holders)
    for company_id, funds in holders.items():
        shard = shards[company_id]
        assert dict(shard["funds"]) == funds
        assert shard["as_of"] == "2026-10-30.1"
        assert shard["company_id"] == company_id
        # Sorted by weight, largest first, so the UI does not have to.
        weights = [weight for _ticker, weight in shard["funds"]]
        assert weights == sorted(weights, reverse=True)


def test_two_holdings_of_one_company_in_one_fund_are_summed():
    document = fund_document()
    # The fixture holds one company twice: equity and a derivative line.
    duplicated = document["holdings"][0]
    document["holdings"].append({**duplicated, "weight_bp": 5, "asset_cat": "derivative"})
    _index, shards = catalogue.company_objects("2026-10-30.1", [document])
    shard = shards[duplicated["company_id"]]
    assert len(shard["funds"]) == 1
    assert shard["funds"][0][1] == duplicated["weight_bp"] + 5


def test_write_release_objects_is_deterministic(tmp_path):
    first = write_release(tmp_path / "a", [fund_document()])
    second = write_release(tmp_path / "b", [fund_document()])
    for relative in ("release.json", "tickers.json", "catalogue.json", "companies/index.json"):
        assert (first / relative).read_bytes() == (second / relative).read_bytes(), relative


def test_release_descriptor_describes_the_bytes_beside_it(tmp_path):
    release_dir = write_release(tmp_path, [fund_document()])
    descriptor = json.loads((release_dir / "release.json").read_text())
    assert descriptor["kind"] == "release"
    assert descriptor["schema_version"] == 2
    assert descriptor["objects"]["tickers"]["bytes"] == (release_dir / "tickers.json").stat().st_size
    assert descriptor["objects"]["companies"]["count"] == len(
        list((release_dir / "companies").glob("c_*.json"))
    )
    assert descriptor["objects"]["fund_index"]["shards"] == ["T"]


def test_validator_rejects_a_stale_company_shard(tmp_path):
    release_dir = write_release(tmp_path, [fund_document()])
    shard_path = next((release_dir / "companies").glob("c_*.json"))
    shard = json.loads(shard_path.read_text())
    shard["funds"][0][1] += 1
    shard_path.write_text(json.dumps(shard, indent=2, sort_keys=True) + "\n")
    assert validate.validate(release_dir) == 1


def test_validator_rejects_a_ticker_list_that_omits_a_fund(tmp_path):
    release_dir = write_release(tmp_path, [fund_document()])
    tickers = json.loads((release_dir / "tickers.json").read_text())
    tickers["tickers"] = []
    (release_dir / "tickers.json").write_text(json.dumps(tickers, indent=2) + "\n")
    assert validate.validate(release_dir) == 1


def test_validator_rejects_a_descriptor_that_points_at_another_manifest(tmp_path):
    release_dir = write_release(tmp_path, [fund_document()])
    descriptor = json.loads((release_dir / "release.json").read_text())
    descriptor["objects"]["manifest"]["sha256"] = "0" * 64
    (release_dir / "release.json").write_text(json.dumps(descriptor, indent=2) + "\n")
    assert validate.validate(release_dir) == 1


def test_release_without_a_descriptor_is_refused(tmp_path):
    release_dir = write_release(tmp_path, [fund_document()])
    (release_dir / "release.json").unlink()
    with pytest.raises(release.ReleaseError):
        release.read_release(release_dir)


def test_read_release_returns_every_published_object(tmp_path):
    release_dir = write_release(tmp_path, [fund_document()])
    manifest, objects, descriptor = release.read_release(release_dir)
    published = {relative for relative, _body, _digest in objects}
    on_disk = {
        path.relative_to(release_dir).as_posix()
        for path in release_dir.rglob("*")
        if path.is_file() and path.name not in release.NOT_PUBLISHED
    }
    assert published == on_disk
    assert objects[0][0] == "release.json"
    assert descriptor["as_of"] == manifest["as_of"]


def test_read_release_refuses_a_descriptor_hash_mismatch(tmp_path):
    release_dir = write_release(tmp_path, [fund_document()])
    descriptor = json.loads((release_dir / "release.json").read_text())
    descriptor["objects"]["catalogue"]["sha256"] = "f" * 64
    (release_dir / "release.json").write_text(json.dumps(descriptor, indent=2) + "\n")
    with pytest.raises(release.ReleaseError):
        release.read_release(release_dir)
