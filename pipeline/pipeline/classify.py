"""Turn N-PORT's raw codes into the four categories the artifact needs.

Every code here was observed in real filings on 2026-10-28 (VOO, AVUV, QQQ, ARKK):

* ``assetCat``: ``EC`` 653, ``EP`` 1, ``DE`` 15, ``STIV`` 7 — no other values.
* ``issuerCat``: ``CORP`` 947, ``RF`` 5, ``PF`` 2, absent on 15 derivative rows.

An unobserved code is **not** guessed into a category: it lands in ``other`` and
the release manifest records the full observed distribution, so a new filer
convention shows up as a number that changed rather than as a silent
misclassification. That is the difference between a mapper with a policy and a
mapper with a pile of if-statements.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

EQUITY = "equity"
DEBT = "debt"
CASH = "cash"
DERIVATIVE = "derivative"
FUND = "fund"
OTHER = "other"

_ASSET_CAT = {
    "EC": EQUITY,
    "EP": EQUITY,
    "DBT": DEBT,
    "ABS-MBS": DEBT,
    "STIV": CASH,
    "DE": DERIVATIVE,
    "CASH": CASH,
}

#: Categories that are a company exposure and therefore enter concentration math.
COMPANY_CATEGORIES = frozenset({EQUITY, DEBT, FUND})


@dataclass(frozen=True)
class Classification:
    category: str
    is_company_exposure: bool
    is_cash_or_derivative: bool
    is_fund_position: bool


def classify(asset_cat: str | None, issuer_cat: str | None, is_derivative: bool) -> Classification:
    if is_derivative:
        category = DERIVATIVE
    else:
        category = _ASSET_CAT.get((asset_cat or "").strip().upper(), OTHER)
        # A registered fund held as a position (issuerCat RF, assetCat equity) is a
        # fund-of-funds relationship, and look-through is one level deep only.
        if category == EQUITY and (issuer_cat or "").strip().upper() == "RF":
            category = FUND
    return Classification(
        category=category,
        is_company_exposure=category in COMPANY_CATEGORIES,
        is_cash_or_derivative=category in (CASH, DERIVATIVE),
        is_fund_position=category == FUND,
    )


#: ADR-0007 C3 splits the universe gate in three: series coverage, an explicit
#: ETF classifier, and ticker resolution. N-PORT's XML carries no ETF flag (the
#: 2026 form's ``fundInfo`` has no such element — checked against real filings),
#: so the free path is a **name rule** plus, later, N-CEN's flag. This is the name
#: rule, and it is labelled as such wherever it is used: it brackets the universe,
#: it never decides what a fund *is* for a displayed number.
_ETF_NAME = re.compile(r"\b(?:etf|exchange[\s-]traded)\b", re.IGNORECASE)


def looks_like_etf(series_name: str | None, registrant_name: str | None) -> bool:
    """Provisional ETF label from the fund's own filed names.

    ``SPDR S&P 500 ETF Trust`` and ``ARK Innovation ETF`` match on the series
    name; a unit investment trust whose series name is ``N/A`` (SPY) matches on
    the registrant. A fund named without "ETF" anywhere is *not* called one here
    even if it probably is — the label is used for the release's ``etf_count``,
    and a count that silently guesses is worse than one that undercounts and says
    how it counted.
    """
    for name in (series_name, registrant_name):
        if name and _ETF_NAME.search(name):
            return True
    return False
