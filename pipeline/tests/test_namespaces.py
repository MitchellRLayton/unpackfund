"""The company-id shape is declared once; the browser's copy may not drift from it.

The Python side (`pipeline/namespaces.py`) is the declaration. The web app needs the same
pattern as a TypeScript literal, so this test reads `web/lib/types.ts` and fails if the literal is
not exactly the declared pattern. `view-fragment.ts` carries no copy at all: it imports the constant,
and this test fails if a second literal of the shape ever appears there.
"""

from __future__ import annotations

import re

import pytest

from pipeline import namespaces, paths

WEB = paths.REPO_ROOT / "web" / "lib"


def test_the_typescript_pattern_is_the_declared_pattern():
    source = (WEB / "types.ts").read_text()
    found = re.search(r"export const COMPANY_ID_PATTERN = /(.+)/;", source)
    assert found is not None, "COMPANY_ID_PATTERN is no longer declared in web/lib/types.ts"
    assert found.group(1) == namespaces.COMPANY_ID_PATTERN


def test_the_fragment_parser_carries_no_second_copy_of_the_shape():
    source = (WEB / "view-fragment.ts").read_text()
    assert "COMPANY_ID_PATTERN" in source
    assert not re.search(r"/\^\(\?:c_", source), "a literal copy of the company-id shape is back"


@pytest.mark.parametrize(
    "value, expected",
    [
        ("c_0000320193", True),
        ("l_0123456789abcdef", True),
        ("f_fedcba9876543210", True),
        ("f_FEDCBA9876543210", False),
        ("f_0123456789abcde", False),
        ("x_0123456789abcdef", False),
        ("", False),
        (None, False),
    ],
)
def test_the_shared_pattern_accepts_exactly_three_namespaces(value, expected):
    assert namespaces.is_company_id(value) is expected


def test_only_f_ids_are_security_ids():
    assert namespaces.is_security_id("f_fedcba9876543210")
    assert not namespaces.is_security_id("l_fedcba9876543210")
    assert not namespaces.is_security_id("c_0000320193")
