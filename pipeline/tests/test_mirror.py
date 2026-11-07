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

from pipeline import fund_pages, mirror, r2


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


def _host(
    *,
    release: str = "2026-10-31.2",
    tickers=("AAA", "BBB"),
    catalogue: dict | None = None,
    countries: dict[str, str] | None = None,
    funds: dict[str, bytes] | None = None,
):
    """A release on the public host, with the pointer describing what it publishes.

    `countries` is the release's company→domicile map: omitted, the release does not
    publish one, which is a real state for a release that placed no companies.
    """
    body = json.dumps(
        catalogue
        if catalogue is not None
        else {"as_of": release, "funds": {ticker: ["Example Fund", "Trust", 1, 27.0] for ticker in tickers}}
    ).encode()
    objects = {
        f"releases/{release}/catalogue.json": body,
    }
    for ticker in tickers:
        objects[f"releases/{release}/funds/{ticker}.json"] = (funds or {}).get(ticker) or _fund(ticker)
    pointer: dict = {
        "schema_version": 2,
        "kind": "release",
        "as_of": release,
        "objects": {"catalogue": {"path": "catalogue.json", "sha256": mirror.sha256_hex(body)}},
    }
    if countries is not None:
        blob = json.dumps({"companies": countries}).encode()
        objects[f"releases/{release}/companies/countries.json"] = blob
        pointer["objects"]["companies"] = {
            "countries": {"path": "companies/countries.json", "sha256": mirror.sha256_hex(blob)}
        }
    objects[mirror.POINTER_KEY] = json.dumps(pointer).encode()
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


# --- The page inputs, not just the ledger's objects -----------------------------
#
# A mirrored release exists to build fund pages, so "what the ledger reads" is not the
# measure — "what the page reads" is. The country map was read by the generator while
# this module copied only the catalogue and the documents, so every mirrored release
# would have shipped 9,016 pages with no geography on a site about geography. These
# tests read the generator's own declaration rather than a list written here.


def _page_fund(ticker: str = "AAA") -> bytes:
    """A fund document with everything a page needs, including a placed company."""
    from tests.test_fund_pages import fund

    return json.dumps({**fund(), "ticker": ticker}).encode()


def test_pages_built_from_a_mirrored_release_know_who_is_american(tmp_path):
    objects = _host(
        tickers=("AAA",),
        funds={"AAA": _page_fund()},
        countries={"c_0001045810": "US", "c_0000000002": "US"},
    )
    reader, _ = _reader(objects)

    report = mirror.mirror(out=tmp_path, reader=reader)

    assert report.countries == 2
    assert report.objects == {"companies/countries.json": len(objects["releases/2026-10-31.2/companies/countries.json"])}
    # The size table is declared optional by `fund_pages.RELEASE_INPUTS` and this host
    # does not publish one, so it is a *named* gap rather than a silent absence.
    assert report.missing == ["companies/sizes.json"]
    assert (tmp_path / "companies" / "countries.json").read_bytes() == objects[
        "releases/2026-10-31.2/companies/countries.json"
    ]

    pages = tmp_path / "pages"
    fund_pages.build(tmp_path, pages)
    page = (pages / "f" / "AAA" / "index.html").read_text()
    assert '<span class="country-tag">' in page
    assert '<span aria-hidden="true">🇺🇸</span> US' in page
    assert "Not traced" not in page


def test_a_release_without_a_country_map_still_mirrors_and_says_what_is_missing(tmp_path, capsys):
    """The fallback is a real state — but it is the exception, and the run says so."""
    objects = _host(tickers=("AAA",), funds={"AAA": _page_fund()})
    reader, _ = _reader(objects)

    report = mirror.mirror(out=tmp_path, reader=reader)

    assert report.countries == 0
    assert report.missing == ["companies/countries.json", "companies/sizes.json"]
    assert "no country map" in report.summary()
    assert "companies/countries.json is not published by this release" in capsys.readouterr().err
    assert not (tmp_path / "companies" / "countries.json").exists()

    pages = tmp_path / "pages"
    fund_pages.build(tmp_path, pages)
    page = (pages / "f" / "AAA" / "index.html").read_text()
    assert "<strong>Not traced.</strong>" in page
    assert "data-tier" not in page


def test_the_mirrored_release_holds_every_input_the_generator_declares(tmp_path):
    """The drift guard: the mirror is measured against `RELEASE_INPUTS`, not a list here.

    A release-wide input added to the generator is served by this test without editing
    it, and copied by the mirror without editing that — so the test fails if the mirror
    stops covering a declared object, which is the failure that produced this change.
    """
    release = "2026-10-31.2"
    objects = _host(tickers=("AAA",), countries={"c_0000000001": "US"})
    injected = []
    for item in fund_pages.RELEASE_INPUTS:
        if "{ticker}" in item.path or item.path == fund_pages.CATALOGUE_FILE:
            continue
        key = f"releases/{release}/{item.path}"
        if key not in objects:
            # A body the mirror has never seen the shape of: it checks JSON, not meaning.
            objects[key] = b"{}"
            injected.append(item.path)
    reader, _ = _reader(objects)

    mirror.mirror(out=tmp_path, reader=reader)

    assert fund_pages.missing_release_inputs(tmp_path, ["AAA"]) == {"required": [], "optional": []}
    for item in fund_pages.RELEASE_INPUTS:
        path = item.path.format(ticker="AAA")
        assert (tmp_path / path).is_file(), path
    # Every release-wide input was actually copied, not just the two named above.
    assert {
        item.path
        for item in fund_pages.RELEASE_INPUTS
        if "{ticker}" not in item.path and item.path != fund_pages.CATALOGUE_FILE
    } <= set(injected) | {"companies/countries.json"}


def test_refuses_a_release_that_is_missing_a_required_page_input(tmp_path, monkeypatch):
    extra = fund_pages.ReleaseInput("companies/index.json", True, "a required object the release lacks")
    monkeypatch.setattr(mirror, "RELEASE_WIDE_INPUTS", (extra,))
    reader, _ = _reader(_host(tickers=("AAA",)))

    with pytest.raises(mirror.MirrorError, match="HTTP 404"):
        mirror.mirror(out=tmp_path, reader=reader)


def test_refuses_a_release_wide_object_that_does_not_match_the_pointer(tmp_path):
    objects = _host(tickers=("AAA",), countries={"c_0000000001": "US"})
    pointer = json.loads(objects[mirror.POINTER_KEY])
    pointer["objects"]["companies"]["countries"]["sha256"] = "0" * 64
    objects[mirror.POINTER_KEY] = json.dumps(pointer).encode()
    reader, _ = _reader(objects)

    with pytest.raises(mirror.MirrorError, match="does not match the pointer"):
        mirror.mirror(out=tmp_path, reader=reader)


def test_refuses_a_truncated_release_wide_object(tmp_path):
    """Half a country map would read as a release that placed half the companies."""
    objects = _host(tickers=("AAA",), countries={"c_0000000001": "US"})
    objects["releases/2026-10-31.2/companies/countries.json"] = b'{"companies": {"c_000'
    reader, _ = _reader(objects)

    with pytest.raises(mirror.MirrorError, match="not JSON"):
        mirror.mirror(out=tmp_path, reader=reader)


def test_the_cli_names_the_country_map_it_copied(tmp_path, capsys):
    objects = _host(tickers=("AAA",), countries={"c_0000000001": "US"})
    reader, _ = _reader(objects)

    report = mirror.mirror(out=tmp_path, reader=reader)

    assert "1 companies placed" in report.summary()
    assert "companies/countries.json" in str(tmp_path / "companies" / "countries.json")
