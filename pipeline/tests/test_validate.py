"""``net_assets``: one filed size, from the fund document to the catalogue.

The field is additive to fund schema 1 (the same pattern as ``etf``), so the
validator has to keep three separate promises, and each of them is a test here:

- present, it is a non-negative number — the `/funds` directory orders every fund
  by it, so a string or a negative would sort the list by something that is not a
  size, and ``null`` is "the filing reported none", never zero;
- absent, the release is still valid, because a release built before 2026-11-02
  was never asked for it and a four-element catalogue row is still readable;
- where both a catalogue row and a fund document publish it, the numbers must be
  the same — the catalogue is a projection of the documents, not a second reader of
  the filing.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from pipeline import validate

from .conftest import corrupt_release, fund_document, write_release


def with_net_assets(document: dict, net_assets) -> dict:
    """The fixture document with the size attached where the builder puts it.

    Same position as ``build._with_net_assets``: after ``coverage_pct``, because the
    document's key order is the contract and a field that moves changes the hash.
    """
    published: dict = {}
    for key, value in document.items():
        published[key] = value
        if key == "coverage_pct":
            published["net_assets"] = net_assets
    return published


def rewrite_catalogue(release_dir: Path, mutate) -> Path:
    """Apply ``mutate`` to ``catalogue.json`` and repair its descriptor in the pointer.

    Without the repair the release's own object hash gate fires first, and every
    tampering test would pass for the same wrong reason — the defect each one names
    would never reach the checker it is about.
    """
    path = release_dir / "catalogue.json"
    payload = json.loads(path.read_text())
    mutate(payload)
    body = json.dumps(payload, indent=2, sort_keys=False).encode() + b"\n"
    path.write_bytes(body)
    pointer_path = release_dir / "release.json"
    pointer = json.loads(pointer_path.read_text())
    entry = pointer["objects"]["catalogue"]
    entry["bytes"] = len(body)
    entry["sha256"] = hashlib.sha256(body).hexdigest()
    pointer_path.write_bytes(json.dumps(pointer, indent=2, sort_keys=False).encode() + b"\n")
    return release_dir


def test_a_release_publishes_the_filed_size(tmp_path, document):
    published = with_net_assets(document, 1_234_567_890)
    release_dir = write_release(tmp_path, [published])
    catalogue = json.loads((release_dir / "catalogue.json").read_text())

    assert catalogue["funds"][document["ticker"]][4] == 1_234_567_890
    assert validate.validate(release_dir) == 0


def test_a_filing_without_a_size_is_valid_and_is_not_zero(tmp_path, document):
    release_dir = write_release(tmp_path, [document])

    stored = json.loads((release_dir / "funds" / f"{document['ticker']}.json").read_text())
    assert "net_assets" not in stored
    catalogue = json.loads((release_dir / "catalogue.json").read_text())
    assert catalogue["funds"][document["ticker"]][4] is None
    assert validate.validate(release_dir) == 0


def test_a_release_built_before_the_field_still_validates(tmp_path, document):
    """The dual read: a five-element document, a four-element row, no disagreement.

    A release built before 2026-11-02 has four-element catalogue rows, and the
    projection gate only compares tickers that publish a figure. The app treats the
    missing element as null, so the release stays valid and the directory falls back
    rather than failing to load.
    """
    published = with_net_assets(document, 500_000)
    release_dir = write_release(tmp_path, [published])

    def drop_the_size(payload):
        payload["funds"] = {ticker: row[:4] for ticker, row in payload["funds"].items()}

    rewrite_catalogue(release_dir, drop_the_size)
    assert validate.validate(release_dir) == 0


@pytest.mark.parametrize("value", [-1, -0.01, "1500000", [1_500_000], True])
def test_a_size_that_is_not_a_non_negative_number_fails(
    tmp_path, document, value, capsys
):
    def mutate(fund):
        fund["net_assets"] = value

    assert validate.validate(corrupt_release(tmp_path, document, mutate)) == 1
    # The failure has to be the gate this test is about, not a hash that broke on
    # the way there, or the case would pass for a reason nobody can act on.
    assert "FAIL TEST.net_assets" in capsys.readouterr().out


def test_the_catalogue_size_must_be_the_funds_size(tmp_path, document, capsys):
    """A projection gate, like the company→country map: one number, one owner.

    The catalogue is written from the fund documents in the same build, so if the
    two disagree then one writer is reading a different number — and the directory
    would rank funds by a size no fund page states.
    """
    published = with_net_assets(document, 1_000)
    release_dir = write_release(tmp_path, [published])
    ticker = document["ticker"]

    def inflate(payload):
        payload["funds"][ticker][4] = 2_000

    rewrite_catalogue(release_dir, inflate)
    assert validate.validate(release_dir) == 1
    assert "FAIL catalogue.net_assets" in capsys.readouterr().out


def test_a_null_catalogue_size_must_match_a_null_document_size(
    tmp_path, document, capsys
):
    """Null is a value the gate compares, not a hole it skips.

    A fund that filed no figure but whose catalogue row says ``0`` would sort at the
    bottom of the list as if it held nothing; that is a disagreement, and the same
    projection gate catches it in the other direction.
    """
    release_dir = write_release(tmp_path, [document])
    ticker = document["ticker"]

    def zero_it(payload):
        payload["funds"][ticker][4] = 0

    rewrite_catalogue(release_dir, zero_it)
    assert validate.validate(release_dir) == 1
    assert "FAIL catalogue.net_assets" in capsys.readouterr().out


@pytest.mark.parametrize("length", [3, 6])
def test_a_catalogue_row_of_an_unknown_length_fails(
    tmp_path, document, length, capsys
):
    """Four and five are the only shapes the positional format allows.

    The app reads a row by position, so a third shape is not a compatible field —
    it is a row whose fifth element is somebody else's number.
    """
    published = with_net_assets(document, 7_000)
    release_dir = write_release(tmp_path, [published])
    ticker = document["ticker"]

    def resize(payload):
        row = payload["funds"][ticker]
        payload["funds"][ticker] = (row + [None, None])[:length]

    rewrite_catalogue(release_dir, resize)
    assert validate.validate(release_dir) == 1
    assert "FAIL catalogue.entry" in capsys.readouterr().out


def test_a_catalogue_size_of_null_against_a_filed_size_fails(
    tmp_path, document, capsys
):
    """Dropping the figure is a disagreement, not the old-release allowance."""
    published = with_net_assets(document, 7_000)
    release_dir = write_release(tmp_path, [published])
    ticker = document["ticker"]

    def hide_it(payload):
        payload["funds"][ticker][4] = None

    rewrite_catalogue(release_dir, hide_it)
    assert validate.validate(release_dir) == 1
    assert "FAIL catalogue.net_assets" in capsys.readouterr().out
