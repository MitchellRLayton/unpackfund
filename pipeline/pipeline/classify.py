"""Turn N-PORT's raw codes into the six categories the artifact needs.

Every code here was observed in real filings. The first pass (2026-10-28, VOO, AVUV, QQQ,
ARKK) saw only ``EC``/``EP``/``DE``/``STIV``; the full-universe pass (2026-11-02, a 400-fund
sample of 12,274 series) saw the rest of the schema:

* ``assetCat``: ``EC`` 59,237 · ``DBT`` 28,306 · ``DFE`` 6,309 · ``ABS-MBS`` 6,222 · ``DE``
  4,439 · ``ABS-CBDO`` 2,593 · ``ABS-O`` 1,534 · ``DIR`` 1,234 · ``LON`` 1,126 · ``STIV`` 548
  · ``DCO`` 537 · ``EP`` 328 · blank 267 · ``RA`` 139 · ``DCR`` 132 · ``RE`` 63 · ``DO`` 32 ·
  ``SN`` 23 · ``ABS-APCP`` 1.
* ``issuerCat``: ``CORP``, ``MUN``, ``USGSE``, ``USGA``, ``UST``, ``NUSS``, ``RF``, ``PF``,
  absent on derivative rows.

An unobserved code is **not** guessed into a category: it lands in ``other`` and the release
manifest records the full observed distribution, so a new filer convention shows up as a
number that changed rather than as a silent misclassification. That is the difference
between a mapper with a policy and a mapper with a pile of if-statements.

The table was completed on 2026-11-02 for exactly that reason. Publishing ``categories``
(ADR-0016) made the ``other`` bucket visible for the first time, and 1.5% of the release sat
in it: ``SN`` (23 rows, 3,399 bp in the sample) is how Vanguard files **Treasury
Inflation-Indexed Bonds**, so VTIP published ``other: 9900`` — a TIPS fund whose entire
portfolio was "other" — and ``RA`` (repo, the largest by weight) read as unclassified cash.
Every code added below names an instrument whose category is not a judgement call: a
structured note, a loan, a securitisation tranche and commercial paper are debt; a
repurchase agreement is cash. ``blank`` and ``RE`` stay ``other``, because those are the
cases where the filing does not say what the row is.
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
    # Asset-backed tranches and commercial paper: debt instruments by construction.
    "ABS-O": DEBT,
    "ABS-CBDO": DEBT,
    "ABS-APCP": DEBT,
    # A loan is a debt exposure, and one that can resolve to its issuer.
    "LON": DEBT,
    # A structured note is a debt security — and ``SN`` is also how Vanguard files TIPS.
    "SN": DEBT,
    # A repurchase agreement is collateralised short-term lending, i.e. cash.
    "RA": CASH,
    "STIV": CASH,
    "DE": DERIVATIVE,
    "CASH": CASH,
}

#: Categories that are a company exposure and therefore enter concentration math.
COMPANY_CATEGORIES = frozenset({EQUITY, DEBT, FUND})

#: Publication order for the six categories. Every published object keyed by category
#: uses this order, so a diff between two releases is a diff in values, not in key order.
CATEGORY_ORDER = (EQUITY, DEBT, CASH, DERIVATIVE, FUND, OTHER)


@dataclass(frozen=True)
class Classification:
    category: str
    is_company_exposure: bool
    is_cash_or_derivative: bool
    is_fund_position: bool


def classify(
    asset_cat: str | None,
    issuer_cat: str | None,
    is_derivative: bool,
    *,
    published_fund: bool = False,
) -> Classification:
    """Map one filed row to a category. ``published_fund`` is an *identity*, not a label.

    A row is a fund position when the filer says so (``issuerCat=RF``, below) **or** when
    the row's LEI is the ``seriesLei`` of a fund this release publishes (ADR-0016
    decision 1). The second test exists because the first trusts a label a filer can get
    wrong, and one does: **Vanguard's Target Retirement funds file their four underlying
    funds as ``assetCat=EC``, ``issuerCat=CORP``** — a fund position declared as a
    corporate equity. Sixty share classes published 99.5% "coverage" that was entirely
    fund positions (VFIFX listed *Vanguard Total Stock Market Index Fund* as its largest
    "company" at 53.69%) until this rule was added. Equality against a series LEI cannot
    produce a false positive: one series, one LEI.
    """
    if is_derivative:
        category = DERIVATIVE
    else:
        category = _ASSET_CAT.get((asset_cat or "").strip().upper(), OTHER)
        # Identity outranks the label, with the same cash/derivative exception the RF
        # rule makes below: a sweep row whose LEI happens to be a fund series is still
        # the fund's cash, and a derivative is a contract, not a share of a fund.
        if published_fund and category not in (CASH, DERIVATIVE):
            category = FUND
        # A registered fund held as a position is a fund-of-funds edge (ADR-0013).
        #
        # **``issuerCat=RF`` is the whole test, not ``RF`` *and* ``assetCat=EC``.**
        # Measured 2026-11-01 over 30,758 real filings: 15,173 of 92,208 registered-
        # fund rows (16.5%) file **no ``assetCat`` at all** — iShares' entire Core
        # Allocation range is in that stratum (AOA holds `iShares Core S&P 500 ETF`
        # at 45.72%), so requiring ``EC`` classified a fund-of-funds as ``other``,
        # which is neither a company nor a fund and produced no warning at all. A
        # bond fund held as a position (``DBT`` + ``RF``) is equally a fund edge.
        #
        # Money-market and lending vehicles are the exception: ``STIV``/``CASH`` +
        # ``RF`` is the fund's cash sweep, and a sweep is not a look-through target —
        # it has no portfolio to look through, and calling it a fund edge would make
        # every fund with a sweep look like a fund-of-funds.
        if (
            (issuer_cat or "").strip().upper() == "RF"
            and category not in (CASH, DERIVATIVE)
        ):
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

#: Name of the test behind every published ``etf`` flag. A release names it once
#: (manifest and catalogue), so a consumer can tell a fact from a heuristic.
ETF_CLASSIFIER = "name_rule_v1"


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
