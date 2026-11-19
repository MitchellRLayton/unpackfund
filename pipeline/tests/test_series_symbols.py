"""A share class the SEC file writes oddly must not become an alias the release's own gate refuses.

The 2026-11-19 nightly built 9,791 funds and then failed ``aliases.shape`` on four symbols such as
``(NWAGX)``. ``_primary_symbol`` already cleaned them; the alias set did not.
"""

from __future__ import annotations

import re

import pytest

from pipeline import universe
from pipeline.validate import TICKER_RE


@pytest.fixture
def fund_file(monkeypatch):
    rows = {
        "NWAFX": ("0000000001", "S000000001", "C000000001"),
        "(NWAGX)": ("0000000001", "S000000001", "C000000002"),   # parenthesised in the SEC file
        " nwahx ": ("0000000001", "S000000001", "C000000003"),   # stray case and space
        "N/A": ("0000000001", "S000000001", "C000000004"),       # a literal placeholder
        "VOO": ("0000000002", "S000000002", "C000000005"),
        "ORPHAN": ("0000000003", None, "C000000006"),            # no series: not an alias
    }
    universe._series_symbols.cache_clear()
    monkeypatch.setattr(universe, "_mf_map", lambda: rows)
    yield
    universe._series_symbols.cache_clear()


def test_class_symbols_are_cleaned_before_they_become_aliases(fund_file):
    symbols = universe._series_symbols()
    assert symbols["S000000001"] == ("NWAFX", "NWAGX", "NWAHX")
    assert symbols["S000000002"] == ("VOO",)
    assert "S000000003" not in symbols


def test_every_alias_passes_the_release_gate_shape(fund_file):
    for series_symbols in universe._series_symbols().values():
        for symbol in series_symbols:
            assert TICKER_RE.match(symbol), symbol
            assert not re.search(r"[()/\s]", symbol)
