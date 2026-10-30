"""Fund name → style bucket, plus the exact tokens that decided it.

**Why a name rule.** A fund document carries weights, not a mandate: nothing in
N-PORT says "small cap value". The only field in the release that says anything
about what a fund is *for* is its filed name, and the name is not decoration — SEC
Rule 35d-1 (the Names Rule) requires a fund whose name suggests a particular type
of investment to adopt an 80% investment policy, so "Small Cap Value" is a
regulatory promise, not marketing. That is the whole basis of this module: an
80%-policy name read as a rule, offline, with every decision naming its tokens.

**What it is not.** It is not a holdings classifier and it never looks at the
issuer to decide what a fund holds — "Fidelity" says nothing about size or style,
and a rule that borrows credibility from a brand is not explainable. A name that
does not support a confident bucket returns ``None`` and the page falls back to
same-issuer links; ``None`` is a result here, not a failure.

**Taxonomy.** The vocabulary is the standard one, encoded as an ordered rule list
(confirmed against the published methodology on 2026-10-29, see
``.dsh/search-ledger.jsonl``):

* Morningstar's 3×3 style grid — vertical axis size (large = top 70% of the zone's
  float-adjusted capitalisation, mid = next 20%, small = bottom 10%), horizontal
  axis value / blend / growth. Morningstar calls the middle *stock* column "core"
  and the middle *fund* column "blend"; this module emits ``blend`` for funds and
  accepts both words as tokens, because a fund named "Core" is in that column.
* Market-cap vocabulary as it appears in US fund names: micro / small / mid / large
  / mega / smid / all-cap, plus the index brands that stand in for a size band
  (S&P 500 and Russell 1000 → large, S&P 400 and Russell Midcap → mid, S&P 600 and
  Russell 2000 → small, Russell 3000 and total-market → all-cap).
* The GICS sectors and the factor families that name products: momentum, dividend,
  quality, low volatility, equal weight, buyback, multi-factor, ESG.
* Asset classes and regions: international developed, emerging markets, global,
  single country, municipal / Treasury / corporate / high-yield / inflation-linked
  debt, real estate, commodity, money market, target-date, balanced.

**Key grammar.** ``key`` is lower-kebab and stable; it is what a page groups by.

* equity, size/style known: ``{region}-{size}-{style}`` — ``us-small-value``,
  ``developed-large-blend``, ``emerging-mid-growth``, ``us-all-blend``.
* equity, one axis known: ``{region}-{size}`` (``us-small``) or ``{region}-{style}``
  (``us-value``); a broad name is ``{region}-equity`` (``us-equity``).
* equity by theme or sector: ``{region}-{theme}`` — ``us-dividend``,
  ``us-technology``, ``developed-small-buywrite`` is *not* a bucket: a theme fund's
  peers are other funds with that theme, so size and style stay in the fields and do
  not multiply the key. Region alone when the name names none: ``momentum``.
* fixed income: ``{region}-{subtype}`` — ``us-municipal-bond``,
  ``us-high-yield-bond``, ``emerging-bond``, ``global-core-bond``.
* allocation, commodity, money market: region-free — ``target-date``,
  ``balanced-allocation``, ``gold``, ``commodity``, ``money-market``. A balanced
  fund's peers are balanced funds, not "U.S. balanced funds".
* real estate: ``{region}-real-estate``. Real assets (a blend of property,
  infrastructure and commodities) is ``real-assets`` in group ``other``.

**Rule order** (first match wins; the order is the documentation):

1. money market, equity-by-industry (miners), commodity, real estate, real
   assets, target-date/balanced, fixed income, equity, bare "Income", else
   ``None``. A word specific enough to name two groups is decided by this order,
   and the order is the answer to "why is that fund in this bucket".
2. Inside equity: region → size (index brands before size words) → style
   (benchmark-implied blend only when the name has no style word) → theme, and a
   theme bucket outranks the 3×3 key.

**Traps this handles, each with a test:**

* ``VALUE LINE`` is an issuer (nine funds), not a value fund — the brand is
  stripped before matching, so *First Trust Value Line Dividend* is ``us-dividend``.
* ``GROWTH AND INCOME`` / ``EQUITY INCOME`` is neither growth nor value: it is the
  equity-income bucket, style ``blend``.
* ``S&P 600`` / ``Russell 2000`` imply small, ``S&P 500`` / ``Russell 1000`` imply
  large, ``Russell 3000`` / total market imply all-cap — even though none contains
  the word "cap".
* ``SECTOR ROTATION`` is a strategy, not a sector; ``ENHANCED`` is an index
  variant and creates no bucket; ``LONG/SHORT`` gets its own theme because a
  hedged fund is not a plain long-only one; ``MEGATRENDS`` is not mega cap;
  ``F/K/A …`` tails are a fund's old name and are discarded.
* Brands that read like a mandate are stripped: ``GLOBAL X`` (so *Global X
  Technology* is not global), ``VALUE LINE``, ``PACIFIC CAPITAL``, ``FRONTIER
  ASSET``, ``GOVERNMENT STREET``. Likewise index brands are not region claims —
  *First Trust Dow Jones International Internet* is developed — and *Dow Jones
  Industrial Average* is an index name, not an industrials fund.
* ``NEW MEXICO`` is a state, not the country; a bare ``500`` is the S&P 500
  unless the name says which index (*CSI 500*, *Nifty 500*).
* Bare "Income" is fixed income only after equity words have had their chance
  (*Madison Diversified Income* is a bond fund, *Fidelity Dividend Income* is not).

**Unstated region.** A US-registered fund that carries a size or style word and
names no region is filed as U.S.: an internationally invested fund must say so in
its name to keep its 80% policy, so the absence of a region word is evidence, and
it is the only inference this module makes that is not a token in the name. It is
applied to region only — size and style are never inferred from anything but a
token (or the benchmark-implied blend above).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable, Iterable, NamedTuple

# --- the coarse family a bucket belongs to -----------------------------------

EQUITY = "equity"
FIXED_INCOME = "fixed income"
ALLOCATION = "allocation"
COMMODITY = "commodity"
REAL_ESTATE = "real estate"
MONEY_MARKET = "money market"
OTHER = "other"

#: The closed set of ``Style.group`` values.
GROUPS = frozenset(
    {EQUITY, FIXED_INCOME, ALLOCATION, COMMODITY, REAL_ESTATE, MONEY_MARKET, OTHER}
)

# --- region vocabulary -------------------------------------------------------

US = "U.S."
DEVELOPED = "international developed"
EMERGING = "emerging markets"
GLOBAL = "global"
SINGLE_COUNTRY = "single country"

#: The closed set of ``Style.region`` values.
REGIONS = frozenset({US, DEVELOPED, EMERGING, GLOBAL, SINGLE_COUNTRY})

# --- size / style vocabulary -------------------------------------------------

SMALL = "small"
MID = "mid"
LARGE = "large"
ALL_CAP = "all"

VALUE = "value"
BLEND = "blend"
GROWTH = "growth"

#: The closed set of ``Style.size`` and ``Style.style`` values.
SIZES = frozenset({SMALL, MID, LARGE, ALL_CAP})
STYLES = frozenset({VALUE, BLEND, GROWTH})


@dataclass(frozen=True)
class Style:
    """One fund's bucket, with the tokens that decided it.

    ``matched`` is the audit trail: the uppercased, punctuation-normalised name
    fragments that made each decision, in decision order. A bucket with no
    ``matched`` tokens would be a guess, and there are none: group and region both
    come from a token, except the documented U.S. default for an unqualified equity
    name (which adds no token because no token exists).
    """

    key: str
    label: str
    group: str
    region: str | None
    size: str | None
    style: str | None
    theme: str | None
    matched: tuple[str, ...]


# --- normalisation -----------------------------------------------------------

#: Trademark marks carry no meaning and break phrase matching ("SPDR(R) S&P(R)").
_MARKS = re.compile(r"\((?:R|TM|SM)\)")
#: Everything that is not a letter, digit or ``&`` separates tokens. ``&`` is kept
#: because "S&P 500" and "Growth & Income" read better (and match more precisely)
#: with it than as "S AND P" / "AND".
_SEPARATORS = re.compile(r"[^A-Z0-9&]+")
#: A fund's old name, when the filing helpfully appends it: "FUND, INC. F/K/A …".
_FORMERLY = re.compile(r"\bF K A\b|\bFORMERLY\b")
#: Issuer words that collide with the taxonomy. "Global X" is an issuer, not a
#: global fund; "Value Line" is an issuer, not a value fund. Both are stripped from
#: the searchable text only — ``matched`` reports what remained.
#: Issuer brands that would otherwise read as a mandate: "Global X" would say
#: global, "Value Line" would say value, "Pacific Capital" would say the Pacific.
_BRANDS = re.compile(
    r"\bGLOBAL X\b|\bVALUE LINE\b|\bPACIFIC CAPITAL\b|\bFRONTIER ASSET\b|\bGOVERNMENT STREET\b"
)

#: "Emerging Markets ex China", "Developed Asia Pacific ex Japan": the country is
#: being excluded, so it must not become the fund's single-country bucket.
_EXCLUDED_REGION = re.compile(
    r"\bEX (?:CHINA|JAPAN|KOREA|TAIWAN|US|U S|USA|BRAZIL|INDIA|RUSSIA|MEXICO|CANADA|UK)\b"
)


def normalise(name: str) -> str:
    """Uppercase, strip marks and old names, and reduce punctuation to spaces."""
    text = _MARKS.sub(" ", name.upper())
    text = _FORMERLY.split(text, maxsplit=1)[0]
    text = _SEPARATORS.sub(" ", text)
    text = _EXCLUDED_REGION.sub(" ", text)
    return " ".join(text.split())


def _text(name: str) -> str:
    """The searchable form: normalised, with issuer brands removed."""
    return " ".join(_BRANDS.sub(" ", normalise(name)).split())


def _pattern(source: str) -> re.Pattern[str]:
    return re.compile(source)


# --- rule tables -------------------------------------------------------------


class _Rule(NamedTuple):
    """One documented row of a rule list: the decision, and the tokens for it."""

    slug: str  # key fragment, or the field value
    label: str  # human words for a label
    pattern: re.Pattern[str]


class _RegionRule(NamedTuple):
    region: str | None  # one of REGIONS, or None for a region the enum lacks
    slug: str  # key prefix, e.g. "us", "developed", "china"
    label: str  # label words, e.g. "U.S.", "China"
    pattern: re.Pattern[str]


class _SizeRule(NamedTuple):
    size: str | None  # one of SIZES, or None when the size is real but off-grid
    slug: str  # key fragment, e.g. "small", "smid", "extended"
    label: str  # e.g. "small cap"
    implied_style: str | None  # a broad benchmark index has a style of its own
    pattern: re.Pattern[str]


class _GroupRule(NamedTuple):
    group: str
    pattern: re.Pattern[str]


# Countries. A single-country name is the most specific region there is, so these
# are checked before every supranational region. "Greater China" is grouped with
# them deliberately: its members trade as one market and share a peer set.
_COUNTRY_RULES: tuple[_RegionRule, ...] = (
    _RegionRule(SINGLE_COUNTRY, "greater-china", "Greater China", _pattern(r"\bGREATER CHINA\b")),
    _RegionRule(SINGLE_COUNTRY, "china", "China", _pattern(r"\bCHINA\b")),
    _RegionRule(SINGLE_COUNTRY, "japan", "Japan", _pattern(r"\bJAPAN\b")),
    _RegionRule(SINGLE_COUNTRY, "india", "India", _pattern(r"\bINDIA\b")),
    _RegionRule(SINGLE_COUNTRY, "korea", "Korea", _pattern(r"\bKOREA\b")),
    _RegionRule(SINGLE_COUNTRY, "taiwan", "Taiwan", _pattern(r"\bTAIWAN\b")),
    _RegionRule(SINGLE_COUNTRY, "hong-kong", "Hong Kong", _pattern(r"\bHONG KONG\b")),
    _RegionRule(SINGLE_COUNTRY, "brazil", "Brazil", _pattern(r"\bBRAZIL\b")),
    # "New Mexico" is a state and must not read as the country; the state rule in
    # _is_state_municipal is what sees it.
    _RegionRule(SINGLE_COUNTRY, "mexico", "Mexico", _pattern(r"(?<!NEW )\bMEXICO\b")),
    _RegionRule(SINGLE_COUNTRY, "canada", "Canada", _pattern(r"\bCANADA\b")),
    _RegionRule(SINGLE_COUNTRY, "united-kingdom", "United Kingdom", _pattern(r"\bUNITED KINGDOM\b|\bUK\b")),
    _RegionRule(SINGLE_COUNTRY, "germany", "Germany", _pattern(r"\bGERMANY\b")),
    _RegionRule(SINGLE_COUNTRY, "france", "France", _pattern(r"\bFRANCE\b")),
    _RegionRule(SINGLE_COUNTRY, "italy", "Italy", _pattern(r"\bITALY\b")),
    _RegionRule(SINGLE_COUNTRY, "spain", "Spain", _pattern(r"\bSPAIN\b")),
    _RegionRule(SINGLE_COUNTRY, "switzerland", "Switzerland", _pattern(r"\bSWITZERLAND\b")),
    _RegionRule(SINGLE_COUNTRY, "netherlands", "Netherlands", _pattern(r"\bNETHERLANDS\b")),
    _RegionRule(SINGLE_COUNTRY, "sweden", "Sweden", _pattern(r"\bSWEDEN\b")),
    _RegionRule(SINGLE_COUNTRY, "norway", "Norway", _pattern(r"\bNORWAY\b")),
    _RegionRule(SINGLE_COUNTRY, "denmark", "Denmark", _pattern(r"\bDENMARK\b")),
    _RegionRule(SINGLE_COUNTRY, "finland", "Finland", _pattern(r"\bFINLAND\b")),
    _RegionRule(SINGLE_COUNTRY, "ireland", "Ireland", _pattern(r"\bIRELAND\b")),
    _RegionRule(SINGLE_COUNTRY, "austria", "Austria", _pattern(r"\bAUSTRIA\b")),
    _RegionRule(SINGLE_COUNTRY, "belgium", "Belgium", _pattern(r"\bBELGIUM\b")),
    _RegionRule(SINGLE_COUNTRY, "portugal", "Portugal", _pattern(r"\bPORTUGAL\b")),
    _RegionRule(SINGLE_COUNTRY, "greece", "Greece", _pattern(r"\bGREECE\b")),
    _RegionRule(SINGLE_COUNTRY, "poland", "Poland", _pattern(r"\bPOLAND\b")),
    _RegionRule(SINGLE_COUNTRY, "turkey", "Turkey", _pattern(r"\bTURKEY\b")),
    _RegionRule(SINGLE_COUNTRY, "israel", "Israel", _pattern(r"\bISRAEL\b")),
    _RegionRule(SINGLE_COUNTRY, "saudi-arabia", "Saudi Arabia", _pattern(r"\bSAUDI\b")),
    _RegionRule(SINGLE_COUNTRY, "uae", "United Arab Emirates", _pattern(r"\bUNITED ARAB EMIRATES\b|\bUAE\b")),
    _RegionRule(SINGLE_COUNTRY, "qatar", "Qatar", _pattern(r"\bQATAR\b")),
    _RegionRule(SINGLE_COUNTRY, "kuwait", "Kuwait", _pattern(r"\bKUWAIT\b")),
    _RegionRule(SINGLE_COUNTRY, "south-africa", "South Africa", _pattern(r"\bSOUTH AFRICA\b")),
    _RegionRule(SINGLE_COUNTRY, "nigeria", "Nigeria", _pattern(r"\bNIGERIA\b")),
    _RegionRule(SINGLE_COUNTRY, "kenya", "Kenya", _pattern(r"\bKENYA\b")),
    _RegionRule(SINGLE_COUNTRY, "egypt", "Egypt", _pattern(r"\bEGYPT\b")),
    _RegionRule(SINGLE_COUNTRY, "indonesia", "Indonesia", _pattern(r"\bINDONESIA\b")),
    _RegionRule(SINGLE_COUNTRY, "thailand", "Thailand", _pattern(r"\bTHAILAND\b")),
    _RegionRule(SINGLE_COUNTRY, "malaysia", "Malaysia", _pattern(r"\bMALAYSIA\b")),
    _RegionRule(SINGLE_COUNTRY, "vietnam", "Vietnam", _pattern(r"\bVIETNAM\b")),
    _RegionRule(SINGLE_COUNTRY, "philippines", "Philippines", _pattern(r"\bPHILIPPINES\b")),
    _RegionRule(SINGLE_COUNTRY, "pakistan", "Pakistan", _pattern(r"\bPAKISTAN\b")),
    _RegionRule(SINGLE_COUNTRY, "bangladesh", "Bangladesh", _pattern(r"\bBANGLADESH\b")),
    _RegionRule(SINGLE_COUNTRY, "sri-lanka", "Sri Lanka", _pattern(r"\bSRI LANKA\b")),
    _RegionRule(SINGLE_COUNTRY, "australia", "Australia", _pattern(r"\bAUSTRALIA\b")),
    _RegionRule(SINGLE_COUNTRY, "new-zealand", "New Zealand", _pattern(r"\bNEW ZEALAND\b")),
    _RegionRule(SINGLE_COUNTRY, "argentina", "Argentina", _pattern(r"\bARGENTINA\b")),
    _RegionRule(SINGLE_COUNTRY, "chile", "Chile", _pattern(r"\bCHILE\b")),
    _RegionRule(SINGLE_COUNTRY, "peru", "Peru", _pattern(r"\bPERU\b")),
    _RegionRule(SINGLE_COUNTRY, "colombia", "Colombia", _pattern(r"\bCOLOMBIA\b")),
    _RegionRule(SINGLE_COUNTRY, "singapore", "Singapore", _pattern(r"\bSINGAPORE\b")),
    _RegionRule(SINGLE_COUNTRY, "russia", "Russia", _pattern(r"\bRUSSIA\b")),
)

#: Supranational regions, most specific first. The US rule carries the index
#: brands that are unambiguously American: a fund named "S&P 500" is a U.S. fund
#: even without the word.
_REGION_RULES: tuple[_RegionRule, ...] = (
    *_COUNTRY_RULES,
    _RegionRule(
        EMERGING,
        "emerging",
        "emerging markets",
        # "Latin America" and "Africa" are emerging-market regions in the MSCI
        # classification, which is the one these products are named against.
        _pattern(r"\bEMERGING\b|\bDEVELOPING\b|\bEM\b|\bLATIN AMERICA\b|\bAFRICA\b|\bMIDDLE EAST\b"),
    ),
    _RegionRule(
        US,
        "us",
        "U.S.",
        # Index brands are deliberately absent: "Dow Jones" and "Nasdaq" name
        # indexes that also exist abroad (*First Trust Dow Jones International
        # Internet*), so they are an equity signal, not a region claim. A bare
        # "S&P 500" still lands here through the index's own number.
        _pattern(
            r"\bU S\b|\bUS\b|\bUSA\b|\bUNITED STATES\b|\bDOMESTIC\b|\bTOTAL (?:U S )?STOCK MARKET\b"
            r"|\b500\b|\b1000\b|\b1500\b|\b2000\b|\b3000\b"
        ),
    ),
    _RegionRule(
        DEVELOPED,
        "developed",
        "international developed",
        _pattern(
            r"\bINTERNATIONAL\b|\bFOREIGN\b|\bOVERSEAS\b|\bDEVELOPED\b|\bEAFE\b|\bEUROPE\b"
            r"|\bEURO ZONE\b|\bEUROZONE\b|\bPACIFIC\b|\bNORDIC\b|\bEX US\b|\bNON US\b"
        ),
    ),
    _RegionRule(GLOBAL, "global", "global", _pattern(r"\bGLOBAL\b|\bWORLD\b|\bWORLDWIDE\b|\bACWI\b")),
)

#: The region an unqualified equity name gets, with no token to record for it.
_US_DEFAULT = _RegionRule(US, "us", "U.S.", _pattern(r"(?!)"))

#: Regions a fund name can carry that the closed ``Style.region`` vocabulary does
#: not have a value for. They still make a bucket — "Asia" is a peer set — so they
#: contribute a key prefix and a label, and leave ``region`` as ``None`` rather than
#: forcing the nearest enum value, which would be a factually wrong claim.
_OTHER_REGION_RULES: tuple[_RegionRule, ...] = (
    _RegionRule(None, "asia-pacific", "Asia Pacific", _pattern(r"\bASIA PACIFIC\b|\bSOUTHEAST ASIA\b")),
    _RegionRule(None, "asia", "Asia", _pattern(r"\bASIA\b")),
    _RegionRule(None, "frontier", "frontier markets", _pattern(r"\bFRONTIER\b")),
    _RegionRule(None, "bric", "BRIC", _pattern(r"\bBRIC\b")),
)

# Size, most specific index brand first. ``implied_style`` is the style a broad
# benchmark index already has: nobody writes "S&P 500 Blend" on a cover, but the
# index is the large-blend benchmark, so a fund tracking it belongs in that bucket.
_SIZE_RULES: tuple[_SizeRule, ...] = (
    _SizeRule(SMALL, "small", "small cap", BLEND, _pattern(r"S&P SMALL ?CAP 600|\bS&P 600\b")),
    _SizeRule(SMALL, "small", "small cap", BLEND, _pattern(r"\bRUSSELL 2000\b")),
    _SizeRule(MID, "mid", "mid cap", BLEND, _pattern(r"\bRUSSELL MID ?CAP\b|\bS&P MID ?CAP 400\b|\bS&P 400\b")),
    _SizeRule(LARGE, "large", "large cap", BLEND, _pattern(r"\bRUSSELL 1000\b|\bS&P 500\b|\bS&P 100\b")),
    # A bare "500" in a US fund name is the S&P 500: *Vanguard 500 Index*,
    # *Fidelity 500 Index*, *Strive 500*. "5000" does not match (word boundary).
    _SizeRule(LARGE, "large", "large cap", BLEND, _pattern(r"(?<!CSI )(?<!NIFTY )\b500\b")),
    _SizeRule(ALL_CAP, "all", "all cap", BLEND, _pattern(r"\bRUSSELL 3000\b|\bS&P 1500\b")),
    _SizeRule(ALL_CAP, "all", "all cap", BLEND, _pattern(r"\bTOTAL (?:U S )?STOCK MARKET\b|\bTOTAL MARKET\b|\bWILSHIRE 5000\b")),
    _SizeRule(LARGE, "large", "large cap", GROWTH, _pattern(r"\bNASDAQ 100\b|\bQQQ\b")),
    _SizeRule(LARGE, "large", "large cap", BLEND, _pattern(r"\bDOW JONES INDUSTRIAL\b|\bDOW JONES 30\b|\bDOW 30\b")),
    _SizeRule(None, "extended", "extended market", None, _pattern(r"\bEXTENDED MARKET\b")),
    _SizeRule(SMALL, "micro", "micro cap", None, _pattern(r"\bMICRO ?CAP\b")),
    _SizeRule(LARGE, "mega", "mega cap", None, _pattern(r"\bMEGA ?CAP\b")),
    _SizeRule(None, "smid", "small/mid cap", None, _pattern(r"\bSMID\b|\bSMALL MID\b")),
    # "Small Company" is the mutual-fund phrasing of the same band as "small cap".
    _SizeRule(SMALL, "small", "small cap", None, _pattern(r"\bSMALL ?CAPS?\b|\bSMALL COMPAN(?:Y|IES)\b")),
    _SizeRule(MID, "mid", "mid cap", None, _pattern(r"\bMID ?CAPS?\b|\bMID COMPAN(?:Y|IES)\b")),
    _SizeRule(
        LARGE,
        "large",
        "large cap",
        None,
        _pattern(
            r"\bLARGE ?CAPS?\b|\bLARGE CAPITALIZATION\b|\bLARGER COMPANIES\b"
            r"|\bLARGE COMPAN(?:Y|IES)\b"
        ),
    ),
    _SizeRule(ALL_CAP, "all", "all cap", None, _pattern(r"\bALL ?CAPS?\b|\bMULTI ?CAPS?\b")),
)

# Style, most specific first: "growth and income" is its own (blend-ish) thing and
# must be read before either word is taken at face value.
_STYLE_RULES: tuple[_Rule, ...] = (
    _Rule(VALUE, "value", _pattern(r"\bVALUE\b")),
    # "Capital appreciation" is the older mutual-fund phrasing of a growth objective.
    _Rule(GROWTH, "growth", _pattern(r"\bGROWTH\b|\bAPPRECIATION\b")),
    _Rule(BLEND, "blend", _pattern(r"\bBLEND\b|\bCORE\b")),
)

# Themes and sectors. A theme bucket replaces the 3×3 key: an investor looking for
# peers of a semiconductor fund wants other semiconductor funds, not "large blend".
_THEME_RULES: tuple[_Rule, ...] = (
    # Equity income is a distinct product family, and the phrase that names it
    # ("Growth and Income") would otherwise read as a growth fund.
    _Rule(
        "equity-income",
        "equity income",
        _pattern(r"\bGROWTH (?:&|AND) INCOME\b|\bEQUITY (?:&|AND) INCOME\b|\bEQUITY INCOME\b"),
    ),
    # Hedged and geared products are not plain long-only funds, and their peers are
    # the other geared products rather than the index they gear.
    _Rule("long-short", "long/short", _pattern(r"\bLONG[/ ]SHORT\b")),
    _Rule("leveraged", "leveraged/inverse", _pattern(r"\bLEVERAGED\b|\bBULL\b|\bBEAR\b|\bINVERSE\b|\b[23]X\b")),
    # Factor families, before sectors: a name that says "Quality" is a factor fund
    # even when it also names an index.
    _Rule("momentum", "momentum", _pattern(r"\bMOMENTUM\b")),
    _Rule(
        "low-volatility",
        "low volatility",
        # No VIX-futures product carries a bare "Volatility" name in the universe,
        # so the word alone is the low-volatility family rather than a volatility bet.
        _pattern(r"\bVOLATILITY\b|\bMINIMUM VARIANCE\b|\bMIN VOL\b"),
    ),
    _Rule("quality", "quality", _pattern(r"\bQUALITY\b|\bFCF\b")),
    _Rule("dividend", "dividend", _pattern(r"\bDIVIDEND\b|\bSUPERDIVIDEND\b|\bRISING DIVIDEND|\bYIELD\b")),
    _Rule("buyback", "buyback", _pattern(r"\bBUYBACK\b")),
    _Rule("equal-weight", "equal weight", _pattern(r"\bEQUAL WEIGHT(?:ED)?\b")),
    _Rule("esg", "ESG", _pattern(r"\bESG\b|\bSUSTAINABLE\b|\bSUSTAINABILITY\b|\bSRI\b|\bRESPONSIBLE\b|\bIMPACT\b")),
    # Options-overlay product families, before sectors: *Technology Covered Call*
    # belongs with the other covered-call funds, and *S&P 500 Buffer* with the
    # other buffers — the overlay, not the index under it, is what makes the fund.
    _Rule(
        "covered-call",
        "covered call",
        _pattern(
            r"\bCOVERED CALL|\bBUY ?WRITE\b|\bWEEKLYPAY\b|\bWEEKLY INCOME\b|\bDAILY INCOME\b"
            r"|\bOPTION(?:S)? INCOME\b|\bYIELD PREMIUM\b|\bPREMIUM INCOME\b|\bCOLLARED?\b"
        ),
    ),
    _Rule(
        "buffered-outcome",
        "buffered outcome",
        _pattern(
            r"\bBUFFER\b|\bSTRUCTURED OUTCOME\b|\bDEFINED OUTCOME\b|\bSTRUCTURED ALT\b"
            r"|\bSWAN SOS\b|\bSOS\b"
        ),
    ),
    # Clean energy is a theme, not the energy sector: its peers are the other
    # clean-energy funds, not *Energy Select Sector*.
    _Rule(
        "clean-energy",
        "clean energy",
        _pattern(r"\bCLEAN ENERGY\b|\bRENEWABLE\b|\bSOLAR\b|\bWIND ENERGY\b|\bALTERNATIVE ENERGY\b"),
    ),
    # Sectors (GICS 11) and the equity themes that behave like one.
    _Rule("information-technology", "technology", _pattern(r"\bTECHNOLOGY\b|\bTECH\b|\bSEMICONDUCTOR|\bSOFTWARE\b|\bCYBER\b|\bROBOTIC|\bARTIFICIAL INTELLIGENCE\b|\bAI\b")),
    _Rule(
        "health-care",
        "health care",
        _pattern(r"\bHEALTH ?CARE\b|\bHEALTH\b|\bMEDICAL\b|\bBIOTECHNOLOGY\b|\bBIOTECH\b|\bPHARMA\b|\bGENOMIC\b"),
    ),
    _Rule("financials", "financials", _pattern(r"\bFINANCIAL\b|\bBANK(?:S|ING)\b|\bINSURANCE\b|\bFINTECH\b")),
    _Rule("energy", "energy", _pattern(r"\bENERGY\b|\bOIL (?:&|AND) GAS\b|\bMLP\b|\bPIPELINE")),
    _Rule("materials", "materials", _pattern(r"\bMATERIALS\b|\bMINERS?\b|\bMINING\b|\bGOLD MINERS?\b")),
    #: "Dow Jones Industrial Average" is the name of the 30-stock index; the word
    #: "Industrial" there is not a sector claim, so it is excluded by lookbehind.
    _Rule(
        "industrials",
        "industrials",
        _pattern(r"(?<!DOW JONES )\bINDUSTRIALS?\b|\bAEROSPACE\b|\bDEFENSE\b"),
    ),
    _Rule("utilities", "utilities", _pattern(r"\bUTILIT(?:Y|IES)\b|\bWATER\b")),
    _Rule("communication-services", "communication services", _pattern(r"\bCOMMUNICATION SERVICES\b|\bTELECOM\b|\bMEDIA\b")),
    _Rule("consumer-discretionary", "consumer discretionary", _pattern(r"\bCONSUMER DISCRETIONARY\b|\bRETAIL\b|\bAUTOMOTIVE\b|\bHOTEL\b")),
    _Rule("consumer-staples", "consumer staples", _pattern(r"\bCONSUMER STAPLES\b|\bSTAPLES\b|\bFOOD (?:&|AND) BEVERAGE\b")),
    _Rule("consumer", "consumer", _pattern(r"\bCONSUMER\b")),
    _Rule("infrastructure", "infrastructure", _pattern(r"\bINFRASTRUCTURE\b")),
    _Rule("natural-resources", "natural resources", _pattern(r"\bNATURAL RESOURCES\b|\bRESOURCES\b|\bREAL ASSETS\b")),
    _Rule("digital-assets", "digital assets", _pattern(r"\bDIGITAL ASSETS?\b|\bBLOCKCHAIN\b")),
    # "Factor" on its own: the name is making a factor claim without naming which.
    _Rule("multi-factor", "multi-factor", _pattern(r"\bMULTI ?FACTOR\b|\bFACTOR\b")),
)

# Fixed income subtypes, narrowest first: a short-term municipal fund is a
# municipal fund, and an inflation-linked Treasury fund is inflation-linked.
_FIXED_INCOME_SUBTYPES: tuple[_Rule, ...] = (
    _Rule(
        "municipal-bond",
        "municipal bond",
        _pattern(r"\bMUNICIPAL\b|\bMUNIS?\b|\bTAX FREE\b|\bTAX EXEMPT\b|\bAMT FREE\b|\bTAX CONSCIOUS\b"),
    ),
    _Rule("high-yield-bond", "high yield bond", _pattern(r"\bHIGH YIELD\b|\bJUNK\b|\bHIGH INCOME\b")),
    _Rule(
        "inflation-protected-bond",
        "inflation-protected bond",
        _pattern(r"\bINFLATION PROTECTED\b|\bINFLATION LINKED\b|\bTREASURY INFLATION\b|\bTIPS\b"),
    ),
    _Rule("treasury-bond", "Treasury bond", _pattern(r"\bTREASUR(?:Y|IES)\b|\bGOVERNMENT\b|\bGNMA\b|\bAGENCY\b")),
    _Rule(
        "securitized-bond",
        "securitized bond",
        _pattern(r"\bSECURITIZED\b|\bCLO\b|\bMBS\b|\bASSET BACKED\b|\bMORTGAGE\b"),
    ),
    _Rule("bank-loan", "bank loan", _pattern(r"\bSENIOR LOAN\b|\bBANK LOAN\b|\bLEVERAGED LOAN\b|\bFLOATING RATE\b")),
    _Rule("convertible-bond", "convertible bond", _pattern(r"\bCONVERTIBLES?\b")),
    _Rule("preferred", "preferred", _pattern(r"\bPREFERREDS?\b")),
    _Rule("corporate-bond", "corporate bond", _pattern(r"\bCORPORATE\b|\bINVESTMENT GRADE\b")),
    _Rule("credit-bond", "credit bond", _pattern(r"\bCREDIT\b")),
    _Rule(
        "target-maturity-bond",
        "target maturity bond",
        _pattern(r"\bTARGET MATURITY\b|\bDEFINED DURATION\b|\bDEFINED MATURITY\b|\bZERO COUPON\b"),
    ),
    _Rule("long-term-bond", "long term bond", _pattern(r"\bLONG TERM\b|\bLONG DURATION\b|\bEXTENDED DURATION\b")),
    _Rule(
        "short-term-bond",
        "short term bond",
        _pattern(
            r"\bSHORT TERM\b|\bULTRA SHORT\b|\bULTRASHORT\b|\bMICROSHORT\b|\bSHORT DURATION\b"
            r"|\bLIMITED TERM\b|\bLIMITED DURATION\b|\bLOW DURATION\b|\b0 3 MONTH\b|\b1 3 MONTH\b"
            r"|\bT BILLS?\b"
        ),
    ),
    _Rule("core-bond", "core bond", _pattern(r"\bCORE\b|\bAGGREGATE\b|\bTOTAL BOND\b|\bCORE PLUS\b|\bMULTI SECTOR\b")),
    _Rule("bond", "bond", _pattern(r"\bBONDS?\b|\bFIXED INCOME\b|\bDEBT\b")),
)

#: The regional-flavour row of the fixed-income table, named for the state rule.
_MUNICIPAL_BOND = _FIXED_INCOME_SUBTYPES[0]

#: Fixed-income credit/duration words. A name carrying one of these is a bond fund
#: before it is anything else.
_BOND_STRONG = _pattern(
    r"\bBONDS?\b|\bFIXED INCOME\b|\bDEBT\b|\bTREASUR(?:Y|IES)\b|\bMUNICIPAL\b|\bMUNIS?\b"
    r"|\bTAX FREE\b|\bTAX EXEMPT\b|\bAMT FREE\b|\bHIGH YIELD\b|\bJUNK\b|\bCORPORATE\b"
    r"|\bCONVERTIBLES?\b|\bSENIOR LOAN\b|\bBANK LOAN\b|\bLEVERAGED LOAN\b|\bFLOATING RATE\b"
    r"|\bPREFERREDS?\b|\bTIPS\b|\bINFLATION PROTECTED\b|\bINFLATION LINKED\b"
    r"|\bINVESTMENT GRADE\b|\bGNMA\b|\bAGENCY\b|\bMICROSHORT\b|\bSHORT TERM\b"
    r"|\bSHORT DURATION\b|\bGOVERNMENT\b|\bDURATION\b|\bSECURITIZED\b|\bCLO\b|\bMBS\b"
    r"|\bCREDIT\b|\bZERO COUPON\b|\bT BILLS?\b"
)

#: US states and territories, for the municipal names that never say "municipal"
#: ("AB New York Portfolio", "Victory California Bond Fund").
_STATE = _pattern(
    r"\bALABAMA\b|\bALASKA\b|\bARIZONA\b|\bARKANSAS\b|\bCALIFORNIA\b|\bCOLORADO\b"
    r"|\bCONNECTICUT\b|\bDELAWARE\b|\bFLORIDA\b|\bHAWAII\b|\bIDAHO\b|\bILLINOIS\b"
    r"|\bINDIANA\b|\bIOWA\b|\bKANSAS\b|\bKENTUCKY\b|\bLOUISIANA\b|\bMAINE\b"
    r"|\bMARYLAND\b|\bMASSACHUSETTS\b|\bMICHIGAN\b|\bMINNESOTA\b|\bMISSISSIPPI\b"
    r"|\bMISSOURI\b|\bMONTANA\b|\bNEBRASKA\b|\bNEVADA\b|\bNEW HAMPSHIRE\b"
    r"|\bNEW JERSEY\b|\bNEW MEXICO\b|\bNEW YORK\b|\bNORTH CAROLINA\b|\bNORTH DAKOTA\b"
    r"|\bOHIO\b|\bOKLAHOMA\b|\bOREGON\b|\bPENNSYLVANIA\b|\bRHODE ISLAND\b"
    r"|\bSOUTH CAROLINA\b|\bSOUTH DAKOTA\b|\bTENNESSEE\b|\bTEXAS\b|\bUTAH\b"
    r"|\bVERMONT\b|\bVIRGINIA\b|\bWASHINGTON\b|\bWEST VIRGINIA\b|\bWISCONSIN\b"
    r"|\bWYOMING\b"
)

#: What must sit beside a state name for it to mean a municipal fund. Without one of
#: these, "Massachusetts Investors Trust" and "Washington Mutual Investors Fund" are
#: equity funds wearing a place name.
_STATE_CONTEXT = _pattern(
    r"\bBONDS?\b|\bINCOME\b|\bINTERMEDIATE\b|\bLONG\b|\bLIMITED TERM\b|\bSHORT TERM\b"
    r"|\bPORTFOLIO\b|\bSERIES\b|\bMUNICIPAL\b|\bTAX FREE\b|\bTAX EXEMPT\b"
)

def _union(patterns: Iterable[re.Pattern[str]]) -> re.Pattern[str]:
    """One pattern that matches anything any of ``patterns`` matches."""
    return re.compile("|".join(f"(?:{pattern.pattern})" for pattern in patterns))


#: Everything that can name an equity *group* on its own: an asset-class word, a
#: region, a size band, a style, or a theme. Built from the tables above rather than
#: retyped, so a token added to one table is a token the group rule knows.
_EQUITY_STRONG = _union(
    (
        _pattern(
            r"\bEQUITY\b|\bEQUITIES\b|\bSTOCKS?\b|\bCOMMON STOCK\b|\bCAPS?\b|\bSECTOR\b"
            r"|\bREITS?\b|\bS&P\b|\bRUSSELL\b|\bNASDAQ\b|\bDOW JONES\b|\bWILSHIRE\b"
            r"|\bMSCI\b|\bFTSE\b"
        ),
        *(_rule.pattern for _rule in _REGION_RULES),
        *(_rule.pattern for _rule in _OTHER_REGION_RULES),
        *(_rule.pattern for _rule in _SIZE_RULES),
        *(_rule.pattern for _rule in _STYLE_RULES),
        *(_rule.pattern for _rule in _THEME_RULES),
    )
)

#: Allocation families. Target-date first, because it is the most specific.
_ALLOCATION_SUBTYPES: tuple[_Rule, ...] = (
    _Rule(
        "target-date",
        "target-date",
        _pattern(
            r"\bTARGET DATE\b|\bTARGET RETIREMENT\b|\bLIFETIME\b|\bLIFECYCLE\b"
            r"|\bSMART ?RETIREMENT\b|\bRETIREMENT INCOME\b|\bRETIREMENT (?:FUND|PORTFOLIO)\b"
            r"|\bTARGET (?:INDEX )?20\d\d\b|\bFREEDOM (?:INDEX )?20\d\d\b"
            r"|\b20\d\d (?:TARGET|RETIREMENT)\b"
        ),
    ),
    _Rule("conservative-allocation", "conservative", _pattern(r"\bCONSERVATIVE\b")),
    _Rule("moderate-allocation", "moderate", _pattern(r"\bMODERATE\b")),
    _Rule("aggressive-allocation", "aggressive", _pattern(r"\bAGGRESSIVE\b")),
    _Rule("growth-allocation", "growth", _pattern(r"\bGROWTH\b")),
    _Rule("income-allocation", "income", _pattern(r"\bINCOME\b")),
    _Rule("balanced-allocation", "balanced", _pattern(r"\bBALANCED\b|\bALLOCATION\b|\bALLOCATOR\b")),
)

#: The allocation families, as one pattern the group rule can use.
_ALLOCATION_SIGNAL = _union(
    (
        _pattern(
            r"\bTARGET DATE\b|\bTARGET RETIREMENT\b|\bLIFETIME\b|\bLIFECYCLE\b"
            r"|\bSMART ?RETIREMENT\b|\bRETIREMENT INCOME\b|\bRETIREMENT (?:FUND|PORTFOLIO)\b"
            r"|\bTARGET (?:INDEX )?20\d\d\b|\bFREEDOM (?:INDEX )?20\d\d\b"
            r"|\b20\d\d (?:TARGET|RETIREMENT)\b|\bBALANCED\b|\bALLOCATION\b|\bALLOCATOR\b"
            # "Moderate Growth and Income" is a 60/40 portfolio, not an equity income fund.
            r"|\b(?:CONSERVATIVE|MODERATE|AGGRESSIVE) (?:GROWTH (?:&|AND) INCOME|ALLOCATION|BALANCED)\b"
            # "Multi-Asset Income" and "One Choice Portfolio: Moderate" are asset
            # allocation products whose names carry no "allocation" word.
            r"|\bMULTI ?ASSET\b|\bPORTFOLIO (?:VERY )?(?:CONSERVATIVE|MODERATE|AGGRESSIVE)\b"
            # LifeStrategy is a static-allocation family: no target date, no equity.
            r"|\bLIFESTRATEGY\b"
        ),
    )
)

#: Commodity families.
_COMMODITY_SUBTYPES: tuple[_Rule, ...] = (
    _Rule("crypto", "crypto asset", _pattern(r"\bBITCOIN\b|\bETHEREUM\b|\bCRYPTO\b|\bDIGITAL ASSET")),
    _Rule("gold", "gold", _pattern(r"\bGOLD\b")),
    _Rule("silver", "silver", _pattern(r"\bSILVER\b")),
    _Rule("precious-metals", "precious metals", _pattern(r"\bPRECIOUS METALS?\b|\bPLATINUM\b|\bPALLADIUM\b")),
    _Rule("oil", "oil", _pattern(r"\bCRUDE\b|\bOIL FUND\b|\bBRENT\b|\bWTI\b|\bHEATING OIL\b")),
    _Rule("natural-gas", "natural gas", _pattern(r"\bNATURAL GAS\b|\bGASOLINE\b")),
    _Rule("agriculture", "agriculture", _pattern(r"\bAGRICULTURE\b|\bCORN\b|\bWHEAT\b|\bSOYBEAN\b|\bLIVESTOCK\b")),
    _Rule("commodity", "commodity", _pattern(r"\bCOMMODIT(?:Y|IES)\b|\bGOLD TRUST\b|\bPHYSICAL\b")),
)

#: Group detection, in order. Each entry is a token set that settles the group;
#: what subtype sits inside the group is decided later by that group's table.
_GROUP_RULES: tuple[_GroupRule, ...] = (
    _GroupRule(MONEY_MARKET, _pattern(r"\bMONEY MARKET\b")),
    # Companies that dig, drill or refine are equities, even when the name reads
    # like a metal: this must beat the commodity rule below.
    _GroupRule(EQUITY, _pattern(r"\bMINERS?\b|\bMINING\b|\bGOLD MINERS?\b")),
    _GroupRule(
        COMMODITY,
        _pattern(
            r"\bGOLD\b|\bSILVER\b|\bCOMMODIT(?:Y|IES)\b|\bPRECIOUS METALS?\b|\bBITCOIN\b"
            r"|\bETHEREUM\b|\bCRYPTO\b|\bOIL FUND\b|\bCRUDE\b|\bBRENT\b|\bWTI\b"
            r"|\bNATURAL GAS\b|\bAGRICULTURE\b|\bCORN\b|\bWHEAT\b|\bSOYBEAN\b"
            r"|\bLIVESTOCK\b|\bGASOLINE\b|\bHEATING OIL\b"
        ),
    ),
    _GroupRule(REAL_ESTATE, _pattern(r"\bREAL ESTATE\b|\bREITS?\b|\bREALTY\b")),
    _GroupRule(OTHER, _pattern(r"\bREAL ASSETS\b")),
    _GroupRule(ALLOCATION, _ALLOCATION_SIGNAL),
    _GroupRule(FIXED_INCOME, _BOND_STRONG),
    _GroupRule(EQUITY, _EQUITY_STRONG),
    # Bare "Income": a bond fund only if nothing above claimed the name.
    _GroupRule(FIXED_INCOME, _pattern(r"\bINCOME\b")),
)


class _Evidence:
    """The tokens that decided a bucket, in decision order, de-duplicated."""

    def __init__(self) -> None:
        self._tokens: list[str] = []

    def add(self, *tokens: str | None) -> None:
        for token in tokens:
            if not token:
                continue
            cleaned = " ".join(token.split())
            if cleaned not in self._tokens:
                self._tokens.append(cleaned)

    def matched(self) -> tuple[str, ...]:
        return tuple(self._tokens)


@dataclass(frozen=True)
class _Bucket:
    """A decided bucket before the audit trail is attached."""

    key: str
    label: str
    group: str
    region: str | None = None
    size: str | None = None
    style: str | None = None
    theme: str | None = None


def _find(rules: Iterable[_Rule], text: str) -> tuple[_Rule, str] | None:
    for rule in rules:
        match = rule.pattern.search(text)
        if match:
            return rule, match.group(0)
    return None


def _find_region(text: str) -> tuple[_RegionRule, str] | None:
    """The most specific region the name states: a country, then a region, then
    one of the named regions the closed ``region`` vocabulary has no value for."""
    for rule in (*_REGION_RULES, *_OTHER_REGION_RULES):
        match = rule.pattern.search(text)
        if match:
            return rule, match.group(0)
    return None


def _find_size(text: str) -> tuple[_SizeRule, str] | None:
    for rule in _SIZE_RULES:
        match = rule.pattern.search(text)
        if match:
            return rule, match.group(0)
    return None


def _is_state_municipal(text: str) -> str | None:
    """A state name plus a bond context, and no equity claim: municipal debt."""
    state = _STATE.search(text)
    if not state or not _STATE_CONTEXT.search(text):
        return None
    if _EQUITY_STRONG.search(text) or _EQUITY_STYLE_WORDS.search(text):
        return None
    return state.group(0)


#: Words that make a state-named fund an equity fund ("MFS Massachusetts Investors
#: Growth Stock"), so the state rule must stand down.
_EQUITY_STYLE_WORDS = _pattern(r"\bGROWTH\b|\bVALUE\b|\bVENTURE\b|\bINVESTORS\b|\bSTOCK\b|\bEQUITY\b")


def _group(text: str, evidence: _Evidence) -> str | None:
    """Which coarse family the name belongs to (first ordered rule wins)."""
    state = _is_state_municipal(text)
    if state is not None:
        evidence.add(state)
        return FIXED_INCOME
    for rule in _GROUP_RULES:
        match = rule.pattern.search(text)
        if match:
            evidence.add(match.group(0))
            return rule.group
    return None


def _region(text: str, evidence: _Evidence) -> _RegionRule | None:
    found = _find_region(text)
    if found is None:
        return None
    rule, token = found
    evidence.add(token)
    return rule


def _label(region: _RegionRule | None, *words: str | None) -> str:
    """Join the region and the bucket's own words into the page's noun phrase."""
    parts = [region.label if region else None, *words]
    return " ".join(part for part in parts if part)


def _equity_bucket(text: str, evidence: _Evidence) -> _Bucket | None:
    theme = _find(_THEME_RULES, text)
    region = _region(text, evidence)
    size = _find_size(text)
    if size is not None:
        evidence.add(size[1])
    style = _find(_STYLE_RULES, text)
    if style is not None:
        evidence.add(style[1])

    # A name that states no region is a U.S. fund: a fund invested abroad has to
    # say so to keep an 80% policy, and every fund here is SEC-registered. The
    # default stops at a name that states a region this vocabulary cannot hold
    # ("Asia"), which keeps its own bucket instead of being called American.
    if region is None:
        region = _US_DEFAULT

    size_rule = size[0] if size else None
    style_word = style[0].slug if style else None
    if style_word is None and size_rule is not None:
        style_word = size_rule.implied_style

    if theme is not None:
        theme_rule, token = theme
        evidence.add(token)
        if theme_rule.slug == "equity-income":
            # The mandate is explicitly neither column: it holds both. The middle
            # of the style grid is the honest field value, whatever words the name
            # uses to get there ("Growth & Income" contains "Growth").
            style_word = BLEND
        key = "-".join(part for part in (region.slug if region else None, theme_rule.slug) if part)
        return _Bucket(
            key=key,
            label=_label(region, theme_rule.label),
            group=EQUITY,
            region=region.region if region else None,
            size=size_rule.size if size_rule else None,
            style=style_word,
            theme=theme_rule.label,
        )

    key_parts = [
        part
        for part in (
            region.slug if region else None,
            size_rule.slug if size_rule else None,
            style_word,
        )
        if part
    ]
    words = [size_rule.label if size_rule else None, style_word]
    if not size_rule and not style_word:
        # A region and nothing else: the broad-index bucket, "U.S. equity".
        key_parts.append("equity")
        words = ["equity"]
    if not key_parts:  # pragma: no cover - the region default always fills one part
        return None
    return _Bucket(
        key="-".join(key_parts),
        label=_label(region, *words),
        group=EQUITY,
        region=region.region if region else None,
        size=size_rule.size if size_rule else None,
        style=style_word,
        theme=None,
    )



def _fixed_income_bucket(text: str, evidence: _Evidence) -> _Bucket:
    region = _region(text, evidence)
    if region is None:
        region = _US_DEFAULT
    # "AB New York Portfolio" is a New York municipal fund: the state rule read the
    # name as municipal debt, so the bucket a state fund lands in is the municipal
    # one even though the name never says the word.
    state = _is_state_municipal(text)
    subtype = (_MUNICIPAL_BOND, state) if state else _find(_FIXED_INCOME_SUBTYPES, text)
    if subtype is None:  # pragma: no cover - a group rule always brings a subtype
        subtype = (_FIXED_INCOME_SUBTYPES[-1], "")
    rule, token = subtype
    evidence.add(token)
    return _Bucket(
        key=f"{region.slug}-{rule.slug}",
        label=_label(region, rule.label),
        group=FIXED_INCOME,
        region=region.region,
        theme=rule.label.replace(" bond", "") if rule.slug != "bond" else None,
    )


def _allocation_bucket(text: str, evidence: _Evidence) -> _Bucket:
    subtype = _find(_ALLOCATION_SUBTYPES, text)
    rule, token = subtype if subtype else (_ALLOCATION_SUBTYPES[-1], "")
    evidence.add(token)
    region = _region(text, evidence)
    return _Bucket(
        key=rule.slug,
        label=f"{rule.label} allocation",
        group=ALLOCATION,
        region=region.region if region else None,
        theme=rule.label,
    )


def _commodity_bucket(text: str, evidence: _Evidence) -> _Bucket:
    subtype = _find(_COMMODITY_SUBTYPES, text)
    rule, token = subtype if subtype else (_COMMODITY_SUBTYPES[-1], "")
    evidence.add(token)
    return _Bucket(key=rule.slug, label=rule.label, group=COMMODITY, theme=rule.label)


def _real_estate_bucket(text: str, evidence: _Evidence) -> _Bucket:
    region = _region(text, evidence)
    if region is None:
        region = _US_DEFAULT
    return _Bucket(
        key=f"{region.slug}-real-estate",
        label=_label(region, "real estate"),
        group=REAL_ESTATE,
        region=region.region,
    )


def _real_assets_bucket(text: str, evidence: _Evidence) -> _Bucket:
    region = _region(text, evidence)
    return _Bucket(
        key="real-assets",
        label="real assets",
        group=OTHER,
        region=region.region if region else None,
        theme="real assets",
    )


def _money_market_bucket(text: str, evidence: _Evidence) -> _Bucket:
    return _Bucket(key="money-market", label="money market", group=MONEY_MARKET)


_BUILDERS: dict[str, Callable[[str, _Evidence], _Bucket | None]] = {
    EQUITY: _equity_bucket,
    FIXED_INCOME: _fixed_income_bucket,
    ALLOCATION: _allocation_bucket,
    COMMODITY: _commodity_bucket,
    REAL_ESTATE: _real_estate_bucket,
    MONEY_MARKET: _money_market_bucket,
    OTHER: _real_assets_bucket,
}


def classify(name: str, issuer: str = "") -> Style | None:
    """The bucket a fund's filed name supports, or ``None`` when it supports none.

    ``issuer`` is accepted so a caller can pass the catalogue row it already has,
    and deliberately unused: an issuer decides nothing about size, style, region or
    asset class, and a classifier that quietly leaned on a brand would be neither
    explainable nor testable. Vague names — "FPA Crescent Fund", "AB Disruptors
    ETF", "Equity Series" — return ``None`` and the page falls back to its issuer
    links.
    """
    if not name:
        return None
    text = _text(name)
    if not text:
        return None
    evidence = _Evidence()
    group = _group(text, evidence)
    if group is None:
        return None
    bucket = _BUILDERS[group](text, evidence)
    if bucket is None or not bucket.key:
        return None
    return Style(
        key=bucket.key,
        label=bucket.label,
        group=bucket.group,
        region=bucket.region,
        size=bucket.size,
        style=bucket.style,
        theme=bucket.theme,
        matched=evidence.matched(),
    )


__all__ = [
    "ALL_CAP",
    "ALLOCATION",
    "BLEND",
    "COMMODITY",
    "DEVELOPED",
    "EMERGING",
    "EQUITY",
    "FIXED_INCOME",
    "GLOBAL",
    "GROUPS",
    "GROWTH",
    "LARGE",
    "MID",
    "MONEY_MARKET",
    "OTHER",
    "REAL_ESTATE",
    "REGIONS",
    "SINGLE_COUNTRY",
    "SIZES",
    "SMALL",
    "STYLES",
    "Style",
    "US",
    "VALUE",
    "classify",
    "normalise",
]
