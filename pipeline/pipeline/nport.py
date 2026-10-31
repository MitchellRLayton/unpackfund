"""Form N-PORT ``primary_doc.xml`` parser.

The form has its own XML specification (``eis_NPORT_Filer.xsd``, namespace
``http://www.sec.gov/edgar/nport``) and is unrelated to XBRL. Elements are matched
by **local name** so a namespace-version bump cannot silently empty the parse —
the failure mode of matching on the full qualified tag is a fund that parses to
zero holdings and reports 100% coverage of nothing.

Nothing here interprets a holding. Raw codes (``assetCat``, ``issuerCat``,
``payoffProfile``) are preserved as filed so the interpretation happens in one
place (``classify.py``) against recorded distributions, not from memory.
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field


class NportParseError(RuntimeError):
    pass


_SERIES_ID = re.compile(rb"<seriesId>\s*([^<]*?)\s*</seriesId>")


def peek_series_id(xml: bytes) -> str | None:
    """The filing's ``seriesId`` without parsing the holdings.

    Walking a trust's filing history to find one series used to parse every
    document it passed — thousands of holdings each, for one string. A regex over
    the first kilobyte answers the same question, which is what makes a
    per-registrant index affordable on a 12,000-series run.
    """
    match = _SERIES_ID.search(xml)
    if not match:
        return None
    value = match.group(1).decode("utf-8", "replace").strip()
    return None if value.upper() in ("", "N/A") else value


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _children(element: ET.Element | None, name: str) -> list[ET.Element]:
    if element is None:
        return []
    return [child for child in element if _local(child.tag) == name]


def _find(element: ET.Element | None, *path: str) -> ET.Element | None:
    current = element
    for name in path:
        if current is None:
            return None
        matches = _children(current, name)
        current = matches[0] if matches else None
    return current


def _text(element: ET.Element | None, *path: str) -> str | None:
    node = _find(element, *path)
    if node is None or node.text is None:
        return None
    stripped = node.text.strip()
    return stripped or None


def _attr_value(element: ET.Element | None, child: str) -> str | None:
    node = _find(element, child)
    if node is None:
        return None
    value = node.get("value")
    if value is None:
        return None
    value = value.strip()
    return value or None


def _float(value: str | None) -> float | None:
    if value is None:
        return None
    try:
        return float(value.replace(",", ""))
    except ValueError:
        return None


@dataclass(frozen=True)
class Holding:
    """One ``invstOrSec`` row, as filed.

    ``cusip``/``isin`` are internal join keys only: they never reach a published
    artifact (compliance rule — CUSIP is licensed by CUSIP Global Services).
    """

    name: str
    title: str | None
    cusip: str | None
    isin: str | None
    ticker: str | None
    lei: str | None
    balance: float | None
    units: str | None
    cur_cd: str | None
    val_usd: float | None
    pct_val: float | None
    asset_cat: str | None
    issuer_cat: str | None
    inv_country: str | None
    payoff_profile: str | None
    is_derivative: bool


@dataclass
class NportFiling:
    accession: str | None
    submission_type: str | None
    cik: str | None
    registrant_name: str | None
    series_name: str | None
    series_id: str | None
    class_ids: list[str]
    report_date: str | None
    fiscal_year_end: str | None
    total_assets: float | None
    total_liabilities: float | None
    net_assets: float | None
    holdings: list[Holding] = field(default_factory=list)


def parse(xml: bytes) -> NportFiling:
    try:
        root = ET.fromstring(xml)
    except ET.ParseError as error:
        raise NportParseError(f"malformed XML: {error}") from error

    header = _find(root, "headerData")
    form = _find(root, "formData")
    if header is None or form is None:
        raise NportParseError("missing headerData/formData — not an N-PORT document")

    gen = _find(form, "genInfo")
    fund = _find(form, "fundInfo")
    series_class_info = _find(header, "filerInfo", "seriesClassInfo")
    class_ids = [
        (node.text or "").strip()
        for node in _children(series_class_info, "classId")
        if (node.text or "").strip()
    ]

    report_date = _text(gen, "repPdDate")
    if report_date is None:
        raise NportParseError("missing genInfo/repPdDate")

    holdings: list[Holding] = []
    invst = _find(form, "invstOrSecs")
    if invst is not None:
        for row in _children(invst, "invstOrSec"):
            identifiers = _find(row, "identifiers")
            holdings.append(
                Holding(
                    name=_holding_name(row),
                    title=_text(row, "title"),
                    cusip=_none_if_placeholder(_text(row, "cusip")),
                    isin=_none_if_placeholder(_attr_value(identifiers, "isin")),
                    ticker=_none_if_placeholder(_attr_value(identifiers, "ticker")),
                    lei=_none_if_placeholder(_text(row, "lei")),
                    balance=_float(_text(row, "balance")),
                    units=_text(row, "units"),
                    cur_cd=_text(row, "curCd"),
                    val_usd=_float(_text(row, "valUSD")),
                    pct_val=_float(_text(row, "pctVal")),
                    asset_cat=_text(row, "assetCat"),
                    issuer_cat=_text(row, "issuerCat"),
                    inv_country=_text(row, "invCountry"),
                    payoff_profile=_text(row, "payoffProfile"),
                    # A derivative row carries a derivativeInfo subtree; the
                    # presence of that subtree is the reliable signal, since
                    # assetCat and payoffProfile are both optional in practice.
                    is_derivative=_find(row, "derivativeInfo") is not None,
                )
            )

    # Unit investment trusts (SPY) file "N/A" for seriesName and seriesId rather
    # than omitting them, so placeholders are normalised to absent here — otherwise
    # a fund publishes the name "N/A".
    return NportFiling(
        accession=_text(header, "accessionNumber"),
        submission_type=_text(header, "submissionType"),
        cik=_text(gen, "regCik"),
        registrant_name=_none_if_placeholder(_text(gen, "regName")),
        series_name=_none_if_placeholder(_text(gen, "seriesName")),
        series_id=_none_if_placeholder(_text(gen, "seriesId")),
        class_ids=class_ids,
        report_date=report_date,
        fiscal_year_end=_text(gen, "repPdEnd"),
        total_assets=_float(_text(fund, "totAssets")),
        total_liabilities=_float(_text(fund, "totLiabs")),
        net_assets=_float(_text(fund, "netAssets")),
        holdings=holdings,
    )


_PLACEHOLDERS = {"", "N/A", "NA", "NONE", "000000000", "0000000000"}

#: A holding name that is a form artefact rather than a name. Measured 2026-10-30: one
#: filer writes ``<name>Default</name>`` and puts the real security in ``<title>``
#: (252 rows across its filings, naming 13 company pages "Default"). "Default" is a
#: wrong name, and a wrong name on a fund page is worse than a blank, so the title is
#: used instead when the name is one of these.
_NAME_PLACEHOLDERS = _PLACEHOLDERS | {"DEFAULT", "UNKNOWN", "NOT APPLICABLE", "-", "--"}


def _none_if_placeholder(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = value.strip().upper()
    return None if cleaned in _PLACEHOLDERS else value.strip()


def _holding_name(row: ET.Element) -> str:
    """The holding's name, from ``<name>`` and then ``<title>``.

    ``title`` is the security description the form requires separately, and it is the
    only usable label when a filer leaves ``name`` as a placeholder. When both are
    absent the row keeps the historical ``"unknown"`` marker, which the artifact test
    for a blank name looks for.
    """
    name = _none_if_placeholder(_text(row, "name"))
    if name is None or name.strip().upper() in _NAME_PLACEHOLDERS:
        name = _none_if_placeholder(_text(row, "title"))
    if name is not None and name.strip().upper() in _NAME_PLACEHOLDERS:
        name = None
    return name or "unknown"
