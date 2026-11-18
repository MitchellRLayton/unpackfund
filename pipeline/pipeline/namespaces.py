"""The company-id namespaces, declared once.

``company_id`` is one published field with three kinds of value, and every consumer that
validates its shape used to carry its own copy of the pattern (the release validator, the
web app's type guard, the URL-fragment parser). A fourth copy for a new namespace is how a
release ships ids the browser then drops. The shape lives here; ``validate`` imports it, and
``tests/test_namespaces.py`` pins the two TypeScript literals to it, so a change to one cannot
pass CI without the others.

| prefix | id | describes | source |
|---|---|---|---|
| ``c_`` | ``c_`` + 10-digit CIK | an SEC operating company | EDGAR |
| ``l_`` | ``l_`` + 16 hex of sha256(LEI) | a GLEIF-registered legal entity | GLEIF (CC0) |
| ``f_`` | ``f_`` + 16 hex of sha256(share-class FIGI) | an equity *share line* the ladder could not tie to a company | OpenFIGI |

An ``f_`` id is a **security-matched** company: OpenFIGI names the share line (``securityType2``
``Common Stock``, ``Depositary Receipt``, ``REIT`` …) and nothing else, so it has no size, sector
or industry. It counts toward ``coverage_pct`` (owner decision OD-CV1, 2026-11-18) and the weight
it carries is published beside it as ``security_matched_pct``, so no surface can show the
attributed figure without the means to say how much of it is security-matched only.

The id is a **hash** of the FIGI, not the FIGI. FIGIs are public domain (compliance skill §3a) so
this is not a licence precaution; it keeps the three namespaces the same shape (``l_`` is a hash of a
LEI for the same reason) and means a published artifact never carries a vendor identifier as
product data (compliance skill §3, "never expose … OpenFIGI ``figi``").
"""

from __future__ import annotations

import re

SEC_PREFIX = "c_"
ISSUER_PREFIX = "l_"
SECURITY_PREFIX = "f_"

#: Hex digits of a sha256 kept in an ``l_`` or ``f_`` id: 16 hex = 64 bits.
ID_HEX_DIGITS = 16

#: The one shape every published ``company_id`` must have. ``web/lib/types.ts`` and
#: ``web/lib/view-fragment.ts`` carry this text verbatim; ``tests/test_namespaces.py`` pins both.
COMPANY_ID_PATTERN = r"^(?:c_\d{10}|l_[0-9a-f]{16}|f_[0-9a-f]{16})$"
COMPANY_ID_RE = re.compile(COMPANY_ID_PATTERN)

_SECURITY_RE = re.compile(r"^f_[0-9a-f]{16}$")


def is_security_id(value: str | None) -> bool:
    """True when ``value`` is in the security-matched namespace (shape only)."""
    return bool(value) and _SECURITY_RE.match(value) is not None


def is_company_id(value: str | None) -> bool:
    """True when ``value`` is a well-formed company id in any namespace."""
    return bool(value) and COMPANY_ID_RE.match(value) is not None
