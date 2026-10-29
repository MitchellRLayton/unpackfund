"""Licensed identifiers, and the rule that keeps them out of the artifacts.

A CUSIP is licensed data: it may be used to compute a result, and it may not be
redistributed. The pipeline reads one from a filing's ``<cusip>`` element, uses it
to resolve a company, and then has to make sure it cannot reach a published artifact
by a side door. It does: as-filed ``<ticker>`` values that are really CUSIPs, names
that are nothing but a CUSIP, and — once — a ``metrics.effective_n`` of
``100000000.0``, which the release's own CUSIP check flagged on two funds.

One pattern, in one module, used by the artifact (to redact), the ordering (so a
rebuilt file sorts the way the validator expects) and the validator (to check).
Three copies of this rule would drift apart silently.
"""

from __future__ import annotations

import re

#: Three digits, five alphanumerics, a final digit, not glued to a longer token.
#: ``742718109`` and ``912810PT9`` match; ``100000000.0`` does not once a decimal
#: point is treated as part of a number rather than as a boundary.
LICENSED_ID_RE = re.compile(r"(?<![0-9A-Za-z.])([0-9]{3}[0-9A-Z]{5}[0-9])(?![0-9A-Za-z]|\.[0-9])")

#: What a row is called when its filed name was the identifier and nothing else.
UNNAMED_HOLDING = "Unnamed holding"


def public_name(name: str | None) -> str:
    """Return ``name`` with any licensed identifier removed."""
    cleaned = LICENSED_ID_RE.sub("", name or "").strip(" -,:;")
    return cleaned or UNNAMED_HOLDING


def is_licensed(value: str | None) -> bool:
    """True when ``value`` contains a licensed identifier."""
    return bool(value) and LICENSED_ID_RE.search(value) is not None
