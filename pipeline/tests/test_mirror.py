"""Mirroring the live release is a copy of what the ledger reads, or it is nothing.

The module exists so a code deploy can build fund pages without rebuilding the world.
That makes every one of its refusals load-bearing: pages built from a stale catalogue, a
document for another fund, or a half-finished copy would each look fine on the site and
say something the ledger contradicts.
"""

from __future__ import annotations

import io
import json
import urllib.error
import urllib.parse

import pytest

from pipeline import mirror, r2


class Response(io.BytesIO):
    def __init__(self, status: int, body: bytes):
        super().__init__(body)
        self.status = status
        self.headers: dict[str, str] = {}

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _reader(objects: dict[str, bytes]):
    """A PublicReader serving `objects` by key; anything else is a 404."""
    asked: list[str] = []

    def opener(request, timeout=0):
        key = urllib.parse.urlsplit(request.full_url).path.lstrip("/")
        asked.append(key)
        if key not in objects:
            raise urllib.error.HTTPError(request.full_url, 404, "not found", None, io.BytesIO(b""))
        return Response(200, objects[key])

    return r2.PublicReader("https://data.example", opener=opener), asked


def _fund(ticker: str, name: str = "Example Fund") -> bytes:
    return json.dumps({"ticker": ticker, "name": name, "holdings": []}).encode()


def _host(*, release: str = "2026-10-31.2", tickers=("AAA", "BBB"), catalogue: dict | None = None):
    """The three objects a mirror needs, with the pointer hashing the catalogue it names."""
    body = json.dumps(
        catalogue
        if catalogue is not None
        else {"as_of": release, "funds": {ticker: ["Example Fund", "Trust", 1, 27.0] for ticker in tickers}}
    ).encode()
    pointer = {
        "schema_version": 2,
        "kind": "release",
        "as_of": release,
        "objects": {"catalogue": {"path": "catalogue.json", "sha256": mirror.sha256_hex(body)}},
    }
    objects = {
        mirror.POINTER_KEY: json.dumps(pointer).encode(),
        f"releases/{release}/catalogue.json": body,
    }
    for ticker in tickers:
        objects[f"releases/{release}/funds/{ticker}.json"] = _fund(ticker)
    return objects


def test_copies_the_release_the_pointer_names(tmp_path):
    objects = _host()
    reader, _ = _reader(objects)

    report = mirror.mirror(out=tmp_path, reader=reader)

    assert report.release == "2026-10-31.2"
    assert (report.documents, report.funds, report.fetched, report.reused) == (2, 2, 2, 0)
    assert sorted(path.name for path in (tmp_path / "funds").iterdir()) == ["AAA.json", "BBB.json"]
    # The catalogue is copied, not rewritten: the generator reads the same bytes the
    # browser's directory page reads.
    assert (tmp_path / "catalogue.json").read_bytes() == objects["releases/2026-10-31.2/catalogue.json"]
    assert json.loads((tmp_path / "funds" / "AAA.json").read_text())["ticker"] == "AAA"
    assert report.catalogue_sha256 == mirror.sha256_hex((tmp_path / "catalogue.json").read_bytes())


def test_refuses_a_catalogue_that_does_not_match_the_pointer(tmp_path):
    objects = _host()
    pointer = json.loads(objects[mirror.POINTER_KEY])
    pointer["objects"]["catalogue"]["sha256"] = "0" * 64
    objects[mirror.POINTER_KEY] = json.dumps(pointer).encode()
    reader, _ = _reader(objects)

    with pytest.raises(mirror.MirrorError, match="does not match the pointer"):
        mirror.mirror(out=tmp_path, reader=reader)
    assert not (tmp_path / "funds").exists()


def test_refuses_a_document_that_belongs_to_another_fund(tmp_path):
    objects = _host(tickers=("AAA",))
    objects["releases/2026-10-31.2/funds/AAA.json"] = _fund("ZZZ")
    reader, _ = _reader(objects)

    with pytest.raises(mirror.MirrorError, match="document is for 'ZZZ'"):
        mirror.mirror(out=tmp_path, reader=reader)


def test_fails_when_a_document_is_missing_rather_than_building_a_smaller_site(tmp_path):
    objects = _host(tickers=("AAA", "BBB", "CCC"))
    del objects["releases/2026-10-31.2/funds/CCC.json"]
    reader, _ = _reader(objects)

    with pytest.raises(mirror.MirrorError, match="HTTP 404"):
        mirror.mirror(out=tmp_path, reader=reader)


def test_reuses_documents_already_copied(tmp_path):
    objects = _host()
    reader, _ = _reader(objects)
    mirror.mirror(out=tmp_path, reader=reader)

    again, asked = _reader(objects)
    report = mirror.mirror(out=tmp_path, reader=again)

    assert (report.fetched, report.reused) == (0, 2)
    assert [key for key in asked if "/funds/" in key] == []


def test_replaces_a_truncated_document_instead_of_reusing_it(tmp_path):
    objects = _host()
    reader, _ = _reader(objects)
    mirror.mirror(out=tmp_path, reader=reader)
    (tmp_path / "funds" / "AAA.json").write_bytes(b'{"ticker": "AA')

    again, asked = _reader(objects)
    report = mirror.mirror(out=tmp_path, reader=again)

    assert report.fetched == 1
    assert json.loads((tmp_path / "funds" / "AAA.json").read_text())["ticker"] == "AAA"
    assert "releases/2026-10-31.2/funds/AAA.json" in asked


def test_an_explicit_release_ignores_what_the_pointer_names(tmp_path):
    objects = _host()
    older = json.loads(objects["releases/2026-10-31.2/catalogue.json"])
    older["as_of"] = "2026-10-30.8"
    objects["releases/2026-10-30.8/catalogue.json"] = json.dumps(older).encode()
    objects["releases/2026-10-30.8/funds/AAA.json"] = _fund("AAA")
    objects["releases/2026-10-30.8/funds/BBB.json"] = _fund("BBB")
    reader, _ = _reader(objects)

    report = mirror.mirror(out=tmp_path, reader=reader, release="2026-10-30.8")

    assert report.release == "2026-10-30.8"
    assert report.documents == 2


def test_limit_copies_a_prefix_for_a_dry_run(tmp_path):
    objects = _host(tickers=("AAA", "BBB", "CCC"))
    reader, asked = _reader(objects)

    report = mirror.mirror(out=tmp_path, reader=reader, limit=1)

    assert report.documents == 1
    assert [key.split("/")[-1] for key in asked if "/funds/" in key] == ["AAA.json"]


def test_cli_exit_code_is_failure_when_mirroring_fails(tmp_path, monkeypatch):
    def boom(*args, **kwargs):
        raise mirror.MirrorError("latest/release.json: HTTP 404")

    monkeypatch.setattr(mirror, "mirror", boom)
    assert mirror.main(["--out", str(tmp_path)]) == 1
