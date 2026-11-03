"""The filed size reaches the fund document, in the place the contract puts it.

The validator and the web directory both read the fifth catalogue element, and the
catalogue is written from the fund documents — so the one thing worth pinning here is
that the builder actually puts the number in the document, rounded, after
``coverage_pct``, and that "the filing reported none" stays distinguishable from zero.
"""

from __future__ import annotations

from pipeline import build


def test_net_assets_are_published_as_whole_dollars():
    assert build._net_assets_usd(None) is None
    # Zero is a figure a filing can report; it must survive as one.
    assert build._net_assets_usd(0) == 0
    assert build._net_assets_usd(1_234_567_890.4) == 1_234_567_890
    assert build._net_assets_usd(9_999.6) == 10_000


def test_the_size_sits_after_coverage_in_the_document():
    document = {
        "schema_version": 1,
        "ticker": "VOO",
        "coverage_pct": 96.7,
        "warnings": [],
    }
    published = build._with_net_assets(document, 1_500_000_000_000)

    assert list(published) == [
        "schema_version",
        "ticker",
        "coverage_pct",
        "net_assets",
        "warnings",
    ]
    assert published["net_assets"] == 1_500_000_000_000
    # The document handed in is the flattener's input, not scratch space.
    assert "net_assets" not in document


def test_no_size_is_published_as_null_not_zero():
    """A fund with no figure has no size answer; zero would rank it as empty."""
    assert build._with_net_assets({"coverage_pct": 0}, None)["net_assets"] is None
    assert build._with_net_assets({"coverage_pct": 0}, 0)["net_assets"] == 0
