"""GENERATED FILE — do not edit by hand.
Source: classification/classification.json
Regenerate: python scripts/gen_classification.py"""

from __future__ import annotations

from typing import Mapping

TIER_AS_OF = '2026-11-05'
DEFAULT_PROVIDER = 'MSCI'
PROVIDERS = ('MSCI', 'FTSE',)

PROVIDER_NAMES = {
    'MSCI': 'MSCI',
    'FTSE': 'FTSE Russell',
}

PROVIDER_LABELS = {
    'MSCI': 'MSCI-aligned classification, maintained by UnpackFund',
    'FTSE': 'FTSE Russell-aligned classification, maintained by UnpackFund',
}

PROVIDER_SOURCE_URLS = {
    'MSCI': 'https://www.msci.com/our-solutions/indexes/market-classification',
    'FTSE': 'https://www.lseg.com/en/ftse-russell/equity-country-classification',
}

#: ``provider -> ((iso2, effective_from, effective_to, tier, label), ...)``.
CLASSIFICATION_ROWS = {
    'MSCI': (
        ('AE', '1900-01-01', None, 'EMERGING', 'Emerging Markets'),
        ('AR', '1900-01-01', None, 'STANDALONE', 'Standalone Markets'),
        ('AT', '1900-01-01', None, 'DEVELOPED', 'Developed Markets'),
        ('AU', '1900-01-01', None, 'DEVELOPED', 'Developed Markets'),
        ('BD', '1900-01-01', None, 'FRONTIER', 'Frontier Markets'),
        ('BE', '1900-01-01', None, 'DEVELOPED', 'Developed Markets'),
        ('BG', '1900-01-01', '2027-06-01', 'STANDALONE', 'Standalone Markets'),
        ('BG', '2027-06-01', None, 'FRONTIER', 'Frontier Markets'),
        ('BH', '1900-01-01', None, 'FRONTIER', 'Frontier Markets'),
        ('BR', '1900-01-01', None, 'EMERGING', 'Emerging Markets'),
        ('CA', '1900-01-01', None, 'DEVELOPED', 'Developed Markets'),
        ('CH', '1900-01-01', None, 'DEVELOPED', 'Developed Markets'),
        ('CL', '1900-01-01', None, 'EMERGING', 'Emerging Markets'),
        ('CN', '1900-01-01', None, 'EMERGING', 'Emerging Markets'),
        ('CO', '1900-01-01', None, 'EMERGING', 'Emerging Markets'),
        ('CZ', '1900-01-01', None, 'EMERGING', 'Emerging Markets'),
        ('DE', '1900-01-01', None, 'DEVELOPED', 'Developed Markets'),
        ('DK', '1900-01-01', None, 'DEVELOPED', 'Developed Markets'),
        ('EE', '1900-01-01', None, 'FRONTIER', 'Frontier Markets'),
        ('EG', '1900-01-01', None, 'EMERGING', 'Emerging Markets'),
        ('ES', '1900-01-01', None, 'DEVELOPED', 'Developed Markets'),
        ('FI', '1900-01-01', None, 'DEVELOPED', 'Developed Markets'),
        ('FR', '1900-01-01', None, 'DEVELOPED', 'Developed Markets'),
        ('GB', '1900-01-01', None, 'DEVELOPED', 'Developed Markets'),
        ('GR', '1900-01-01', '2027-06-01', 'EMERGING', 'Emerging Markets'),
        ('GR', '2027-06-01', None, 'DEVELOPED', 'Developed Markets'),
        ('HK', '1900-01-01', None, 'DEVELOPED', 'Developed Markets'),
        ('HR', '1900-01-01', None, 'FRONTIER', 'Frontier Markets'),
        ('HU', '1900-01-01', None, 'EMERGING', 'Emerging Markets'),
        ('ID', '1900-01-01', None, 'EMERGING', 'Emerging Markets'),
        ('IE', '1900-01-01', None, 'DEVELOPED', 'Developed Markets'),
        ('IL', '1900-01-01', None, 'DEVELOPED', 'Developed Markets'),
        ('IN', '1900-01-01', None, 'EMERGING', 'Emerging Markets'),
        ('IS', '1900-01-01', None, 'FRONTIER', 'Frontier Markets'),
        ('IT', '1900-01-01', None, 'DEVELOPED', 'Developed Markets'),
        ('JO', '1900-01-01', None, 'FRONTIER', 'Frontier Markets'),
        ('JP', '1900-01-01', None, 'DEVELOPED', 'Developed Markets'),
        ('KE', '1900-01-01', None, 'FRONTIER', 'Frontier Markets'),
        ('KR', '1900-01-01', None, 'EMERGING', 'Emerging Markets'),
        ('KW', '1900-01-01', None, 'EMERGING', 'Emerging Markets'),
        ('KZ', '1900-01-01', None, 'FRONTIER', 'Frontier Markets'),
        ('LK', '1900-01-01', None, 'FRONTIER', 'Frontier Markets'),
        ('LT', '1900-01-01', None, 'FRONTIER', 'Frontier Markets'),
        ('MA', '1900-01-01', None, 'FRONTIER', 'Frontier Markets'),
        ('MU', '1900-01-01', None, 'FRONTIER', 'Frontier Markets'),
        ('MX', '1900-01-01', None, 'EMERGING', 'Emerging Markets'),
        ('MY', '1900-01-01', None, 'EMERGING', 'Emerging Markets'),
        ('NG', '1900-01-01', None, 'FRONTIER', 'Frontier Markets'),
        ('NL', '1900-01-01', None, 'DEVELOPED', 'Developed Markets'),
        ('NO', '1900-01-01', None, 'DEVELOPED', 'Developed Markets'),
        ('NZ', '1900-01-01', None, 'DEVELOPED', 'Developed Markets'),
        ('OM', '1900-01-01', None, 'FRONTIER', 'Frontier Markets'),
        ('PE', '1900-01-01', None, 'EMERGING', 'Emerging Markets'),
        ('PH', '1900-01-01', None, 'EMERGING', 'Emerging Markets'),
        ('PK', '1900-01-01', None, 'FRONTIER', 'Frontier Markets'),
        ('PL', '1900-01-01', None, 'EMERGING', 'Emerging Markets'),
        ('PT', '1900-01-01', None, 'DEVELOPED', 'Developed Markets'),
        ('QA', '1900-01-01', None, 'EMERGING', 'Emerging Markets'),
        ('RO', '1900-01-01', None, 'FRONTIER', 'Frontier Markets'),
        ('RS', '1900-01-01', None, 'FRONTIER', 'Frontier Markets'),
        ('SA', '1900-01-01', None, 'EMERGING', 'Emerging Markets'),
        ('SE', '1900-01-01', None, 'DEVELOPED', 'Developed Markets'),
        ('SG', '1900-01-01', None, 'DEVELOPED', 'Developed Markets'),
        ('SI', '1900-01-01', None, 'FRONTIER', 'Frontier Markets'),
        ('TH', '1900-01-01', None, 'EMERGING', 'Emerging Markets'),
        ('TN', '1900-01-01', None, 'FRONTIER', 'Frontier Markets'),
        ('TR', '1900-01-01', None, 'EMERGING', 'Emerging Markets'),
        ('TW', '1900-01-01', None, 'EMERGING', 'Emerging Markets'),
        ('US', '1900-01-01', None, 'DEVELOPED', 'Developed Markets'),
        ('VN', '1900-01-01', None, 'FRONTIER', 'Frontier Markets'),
        ('ZA', '1900-01-01', None, 'EMERGING', 'Emerging Markets'),
    ),
    'FTSE': (
        ('AE', '1900-01-01', None, 'EMERGING', 'Emerging'),
        ('AT', '1900-01-01', None, 'DEVELOPED', 'Developed'),
        ('AU', '1900-01-01', None, 'DEVELOPED', 'Developed'),
        ('BD', '1900-01-01', None, 'FRONTIER', 'Frontier'),
        ('BE', '1900-01-01', None, 'DEVELOPED', 'Developed'),
        ('BG', '1900-01-01', None, 'FRONTIER', 'Frontier'),
        ('BH', '1900-01-01', None, 'FRONTIER', 'Frontier'),
        ('BR', '1900-01-01', None, 'EMERGING', 'Emerging'),
        ('CA', '1900-01-01', None, 'DEVELOPED', 'Developed'),
        ('CH', '1900-01-01', None, 'DEVELOPED', 'Developed'),
        ('CL', '1900-01-01', None, 'EMERGING', 'Emerging'),
        ('CN', '1900-01-01', None, 'EMERGING', 'Emerging'),
        ('CO', '1900-01-01', None, 'EMERGING', 'Emerging'),
        ('CY', '1900-01-01', None, 'FRONTIER', 'Frontier'),
        ('CZ', '1900-01-01', None, 'EMERGING', 'Emerging'),
        ('DE', '1900-01-01', None, 'DEVELOPED', 'Developed'),
        ('DK', '1900-01-01', None, 'DEVELOPED', 'Developed'),
        ('EE', '1900-01-01', None, 'FRONTIER', 'Frontier'),
        ('EG', '1900-01-01', None, 'EMERGING', 'Emerging'),
        ('ES', '1900-01-01', None, 'DEVELOPED', 'Developed'),
        ('FI', '1900-01-01', None, 'DEVELOPED', 'Developed'),
        ('FR', '1900-01-01', None, 'DEVELOPED', 'Developed'),
        ('GB', '1900-01-01', None, 'DEVELOPED', 'Developed'),
        ('GR', '1900-01-01', None, 'DEVELOPED', 'Developed'),
        ('HK', '1900-01-01', None, 'DEVELOPED', 'Developed'),
        ('HR', '1900-01-01', None, 'FRONTIER', 'Frontier'),
        ('HU', '1900-01-01', None, 'EMERGING', 'Emerging'),
        ('ID', '1900-01-01', None, 'EMERGING', 'Emerging'),
        ('IE', '1900-01-01', None, 'DEVELOPED', 'Developed'),
        ('IL', '1900-01-01', None, 'DEVELOPED', 'Developed'),
        ('IN', '1900-01-01', None, 'EMERGING', 'Emerging'),
        ('IS', '1900-01-01', None, 'EMERGING', 'Emerging'),
        ('IT', '1900-01-01', None, 'DEVELOPED', 'Developed'),
        ('JO', '1900-01-01', None, 'FRONTIER', 'Frontier'),
        ('JP', '1900-01-01', None, 'DEVELOPED', 'Developed'),
        ('KE', '1900-01-01', None, 'FRONTIER', 'Frontier'),
        ('KR', '1900-01-01', None, 'DEVELOPED', 'Developed'),
        ('KW', '1900-01-01', None, 'EMERGING', 'Emerging'),
        ('KZ', '1900-01-01', None, 'FRONTIER', 'Frontier'),
        ('LK', '1900-01-01', None, 'FRONTIER', 'Frontier'),
        ('LT', '1900-01-01', None, 'FRONTIER', 'Frontier'),
        ('LU', '1900-01-01', None, 'DEVELOPED', 'Developed'),
        ('LV', '1900-01-01', None, 'FRONTIER', 'Frontier'),
        ('MA', '1900-01-01', None, 'FRONTIER', 'Frontier'),
        ('MT', '1900-01-01', None, 'FRONTIER', 'Frontier'),
        ('MU', '1900-01-01', None, 'FRONTIER', 'Frontier'),
        ('MX', '1900-01-01', None, 'EMERGING', 'Emerging'),
        ('MY', '1900-01-01', None, 'EMERGING', 'Emerging'),
        ('NG', '1900-01-01', None, 'FRONTIER', 'Frontier'),
        ('NL', '1900-01-01', None, 'DEVELOPED', 'Developed'),
        ('NO', '1900-01-01', None, 'DEVELOPED', 'Developed'),
        ('NZ', '1900-01-01', None, 'DEVELOPED', 'Developed'),
        ('OM', '1900-01-01', None, 'FRONTIER', 'Frontier'),
        ('PA', '1900-01-01', None, 'FRONTIER', 'Frontier'),
        ('PE', '1900-01-01', None, 'FRONTIER', 'Frontier'),
        ('PH', '1900-01-01', None, 'EMERGING', 'Emerging'),
        ('PK', '1900-01-01', None, 'FRONTIER', 'Frontier'),
        ('PL', '1900-01-01', None, 'DEVELOPED', 'Developed'),
        ('PT', '1900-01-01', None, 'DEVELOPED', 'Developed'),
        ('QA', '1900-01-01', None, 'EMERGING', 'Emerging'),
        ('RO', '1900-01-01', None, 'EMERGING', 'Emerging'),
        ('RS', '1900-01-01', None, 'FRONTIER', 'Frontier'),
        ('SA', '1900-01-01', None, 'EMERGING', 'Emerging'),
        ('SE', '1900-01-01', None, 'DEVELOPED', 'Developed'),
        ('SG', '1900-01-01', None, 'DEVELOPED', 'Developed'),
        ('SI', '1900-01-01', None, 'FRONTIER', 'Frontier'),
        ('SK', '1900-01-01', None, 'FRONTIER', 'Frontier'),
        ('TH', '1900-01-01', None, 'EMERGING', 'Emerging'),
        ('TN', '1900-01-01', None, 'FRONTIER', 'Frontier'),
        ('TR', '1900-01-01', None, 'EMERGING', 'Emerging'),
        ('TW', '1900-01-01', None, 'EMERGING', 'Emerging'),
        ('US', '1900-01-01', None, 'DEVELOPED', 'Developed'),
        ('VN', '1900-01-01', None, 'EMERGING', 'Emerging'),
        ('ZA', '1900-01-01', None, 'EMERGING', 'Emerging'),
    ),
}

TIER_FOLD = {
    'DEVELOPED': 'DM',
    'EMERGING': 'EM',
    'FRONTIER': 'EM',
    'STANDALONE': 'EM',
    'UNCLASSIFIED': 'EM',
}

SHARED_BUCKETS = {
    'AS': 'US',
    'BM': 'US',
    'BS': 'US',
    'GG': 'US',
    'GI': 'US',
    'GU': 'US',
    'IM': 'US',
    'JE': 'US',
    'KY': 'US',
    'MC': 'US',
    'MH': 'US',
    'MP': 'US',
    'PA': 'US',
    'PR': 'US',
    'US': 'US',
    'VG': 'US',
    'VI': 'US',
}

PROVIDER_BUCKETS = {
    'MSCI': {
        'LU': 'DM',
    },
    'FTSE': {
        'BG': 'DM',
        'CY': 'DM',
        'EE': 'DM',
        'HR': 'DM',
        'LT': 'DM',
        'LV': 'DM',
        'MT': 'DM',
        'SI': 'DM',
        'SK': 'DM',
    },
}


def _index(provider: str) -> Mapping[str, tuple]:
    return _INDEX[provider]


_INDEX = {
    provider: {
        iso2: tuple(r for r in rows if r[0] == iso2)
        for iso2 in {r[0] for r in rows}
    }
    for provider, rows in CLASSIFICATION_ROWS.items()
}


def market_tier_of(
    country: str | None,
    as_of: str | None = None,
    provider: str | None = None,
) -> str | None:
    """The provider's tier for a domicile, or ``None`` when there is no domicile."""
    if not country:
        return None
    code = country.strip().upper()
    if not code:
        return None
    provider = provider or DEFAULT_PROVIDER
    as_of = as_of or TIER_AS_OF
    rows = _index(provider).get(code)
    if not rows:
        return "UNCLASSIFIED"
    for _iso2, start, end, tier, _label in rows:
        if start <= as_of and (end is None or as_of < end):
            return tier
    return "UNCLASSIFIED"


def tier_of(
    country: str | None,
    as_of: str | None = None,
    provider: str | None = None,
) -> str | None:
    """The bar's three segments for a domicile, or ``None`` when there is no domicile."""
    if not country:
        return None
    code = country.strip().upper()
    if not code:
        return None
    provider = provider or DEFAULT_PROVIDER
    shared = SHARED_BUCKETS.get(code)
    if shared:
        return shared
    override = PROVIDER_BUCKETS[provider].get(code)
    if override:
        return override
    tier = market_tier_of(code, as_of=as_of, provider=provider)
    return None if tier is None else TIER_FOLD[tier]
