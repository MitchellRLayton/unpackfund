"""The foreign-issuer namespace: LEI → legal entity, from GLEIF open data.

A US fund holds Toyota, Nestlé and TSMC. None of those issuers files with the SEC,
so none has a CIK, and the CIK-keyed ladder can never name them — that is 96.6% of
the international coverage gap measured on 2026-10-30 (``docs/01-research/
2026-10-30-international-holdings-plan.md``). What those rows *do* carry is the
issuer's LEI: 82.65% of the foreign-listed unmapped weight, 20,909 distinct
entities across the whole corpus.

So identity gets a second namespace, in parallel with the CIK one and never mixed:

| prefix | means | key | source |
|---|---|---|---|
| ``c_`` | an SEC operating company | zero-padded CIK | EDGAR ``company_tickers.json`` |
| ``l_`` | a GLEIF-registered legal entity | LEI, hashed (see below) | GLEIF golden copy, **CC0** |

**The id is not the LEI.** GLEIF data is CC0 — attribution only, redistribution
fine — but the compliance rule for this product is stricter than the licence: no
security or entity identifier appears in an artifact or in HTML (the same rule
that keeps CUSIP and ISIN out). An ``l_`` id is therefore
``"l_" + sha256(lei)[:16]``: deterministic across builds and machines, opaque to a
reader, and collision-free at our scale (n < 100k → p < 1e-10). The LEI itself
never leaves ``data/cache/``.

**What the name is.** The published label is GLEIF's ``Entity.LegalName`` — the
registered legal name, which is the one name an issuer cannot have two of. GLEIF
publishes it in registry casing (``TOYOTA MOTOR CORPORATION``), so
:func:`display_name` renders it for the page the same way the filing-supplied
names are rendered: title case, with legal-form tokens and short acronyms left
upper. Case is presentation; the identity is the LEI.

**Licence and provenance.** GLEIF publishes the golden copy (Level 1 + Level 2,
``LEI-CDF`` 3.1) and the ISIN-to-LEI relationship file as open data under CC0 1.0.
Both are cached under ``data/cache/gleif/`` (git-ignored) by
``python -m pipeline.gleif --refresh``. The release manifest records the cache
date and every count below, so a reader can see which entities a release knew.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import io
import json
import re
import sys
import threading
import time
import urllib.request
import zipfile
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Iterator

#: Prefix of the foreign-issuer namespace. ``c_`` is SEC; this is GLEIF.
ID_PREFIX = "l_"
#: Hex digits of sha256(LEI) kept in the id. 16 hex = 64 bits.
ID_HEX_DIGITS = 16
#: ISO 17442: 18 alphanumeric + 2 check digits.
LEI_RE = re.compile(r"^[A-Z0-9]{18}[0-9]{2}$")

CACHE_DIRNAME = "gleif"
ENTITIES_FILE = "entities.json"
ISIN_FILE = "isin-lei.json"

#: Golden copy and ISIN mapping endpoints. The golden copy is addressed by its
#: content date; the ISIN mapping by a per-day uuid, so the uuid is passed in and
#: recorded next to the cache instead of being guessed.
GOLDEN_COPY_URL = "https://leidata.gleif.org/api/v1/concatenated-files/lei2/{date}/zip"
USER_AGENT = "UnpackFund research data@unpackfund.com"

#: Words that stay upper-case in a display name: legal forms, and acronyms that
#: are not words. Everything else title-cases.
_KEEP_UPPER = frozenset(
    {
        "AB", "AD", "AG", "AO", "ASA", "AS", "BHD", "BV", "BVI", "CDI", "CO",
        "CV", "DE", "DG", "DOO", "EAD", "EE", "EURL", "GMBH", "INC", "JSC",
        "KG", "KGAA", "KFT", "KK", "LLC", "LLP", "LP", "LTD", "MBH", "NA",
        "NV", "OAO", "OOO", "OU", "PAO", "PC", "PJSC", "PLC", "PT", "PTE",
        "PVT", "REIT", "SA", "SAB", "SAS", "SCA", "SDN", "SE", "SGPS", "SL",
        "SPA", "SPC", "SPL", "TBK", "Tbk", "UAB", "ULC", "VAG", "ZAO",
    }
)
_VOWELS = frozenset("AEIOUY")
#: Suffixes that are legal form, not name, and are dropped from the *display*
#: label only — never from the data (the id is the LEI).
_DISPLAY_LEGAL = re.compile(
    r"\s*,?\s*\b(incorporated|inc|corporation|corp|company|co|ltd|limited|plc|"
    r"llc|lp|llp|nv|bv|ag|se|sa|sas|spa|gmbh|mbh|kg|kgaa|ab|asa|oyj|pte|pvt|"
    r"tbk|bhd|sdn|pt|kk|doo|dd|ad|as|sl|srl|holding|holdings)\b\.?\s*$",
    re.IGNORECASE,
)


# ---------------------------------------------------------------------------
# Ids
# ---------------------------------------------------------------------------


def valid_lei(value: str | None) -> bool:
    """True for a well-formed ISO 17442 identifier."""
    return bool(value) and LEI_RE.match(value.strip().upper()) is not None


def issuer_id(lei: str) -> str:
    """The published id for a GLEIF entity: ``l_`` + 16 hex of sha256(LEI)."""
    digest = hashlib.sha256(lei.strip().upper().encode("ascii")).hexdigest()
    return f"{ID_PREFIX}{digest[:ID_HEX_DIGITS]}"


def is_issuer_id(value: str | None) -> bool:
    """True when ``value`` is in the foreign-issuer namespace (shape only)."""
    if not value or not value.startswith(ID_PREFIX):
        return False
    tail = value[len(ID_PREFIX) :]
    return len(tail) == ID_HEX_DIGITS and all(c in "0123456789abcdef" for c in tail)


def is_sec_company_id(value: str | None) -> bool:
    """True when ``value`` is in the SEC namespace (``c_`` + 10 digits)."""
    if not value or not value.startswith("c_"):
        return False
    tail = value[2:]
    return len(tail) == 10 and tail.isdigit()


# ---------------------------------------------------------------------------
# Display
# ---------------------------------------------------------------------------


def display_name(legal_name: str) -> str:
    """Render a GLEIF legal name the way the rest of the site renders names.

    ``TOYOTA MOTOR CORPORATION`` → ``Toyota Motor Corporation``;
    ``ROYAL BANK OF CANADA`` → ``Royal Bank of Canada``; ``HSBC HOLDINGS PLC`` →
    ``HSBC Holdings PLC``. A name that already carries lower case is left alone —
    GLEIF stores the registry's own casing, and some registries are mixed-case.
    """
    name = re.sub(r"\s+", " ", html.unescape(legal_name or "")).strip()
    if not name:
        return ""
    letters = [c for c in name if c.isalpha()]
    if letters and sum(1 for c in letters if c.isupper()) / len(letters) < 0.9:
        return name
    out: list[str] = []
    for token in name.split(" "):
        core = token.strip(".,()")
        if core in _KEEP_UPPER:
            out.append(token)
            continue
        if any(ch.isdigit() for ch in core) or not core.isalpha():
            out.append(token)
            continue
        # An all-caps token is an acronym rather than a shouted word when it is very
        # short (SAP, ABB, BMW) or has no vowels at all (HSBC, BHP, RWE). Everything
        # else is a word the registry shouted: MOTOR, TOYOTA, SAMSUNG, NESTLÉ.
        if len(core) <= 3 or not (set(core) & _VOWELS):
            out.append(token)
            continue
        lowered = core.lower()
        out.append(token.replace(core, lowered[:1].upper() + lowered[1:]))
    return " ".join(out)


# ---------------------------------------------------------------------------
# The index
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Entity:
    """One GLEIF Level-1 record, reduced to what a page shows."""

    lei: str
    name: str
    status: str
    jurisdiction: str | None
    category: str = ""

    @property
    def company_id(self) -> str:
        return issuer_id(self.lei)


@dataclass(frozen=True)
class Resolution:
    """What a holding row resolved to, and which rung did it."""

    company_id: str
    name: str
    rung: str


RUNG_LEI = "lei_issuer"
RUNG_ISIN_LEI = "isin_lei_issuer"


class IssuerIndex:
    """LEI → entity, plus ISIN → LEI for rows whose filing carries no LEI."""

    def __init__(
        self,
        entities: dict[str, Entity],
        isin_to_lei: dict[str, str],
        *,
        cache_date: str,
        source: str,
    ) -> None:
        self.entities = entities
        self.isin_to_lei = isin_to_lei
        self.cache_date = cache_date
        self.source = source
        self.refusals: Counter[str] = Counter()
        self.bridges: Counter[str] = Counter()
        self._lock = threading.Lock()
        self._statuses: dict[str, int] = {}
        for entity in entities.values():
            self._statuses[entity.status] = self._statuses.get(entity.status, 0) + 1

    # -- construction ------------------------------------------------------

    @classmethod
    def cache_dir(cls) -> Path:
        from . import paths

        return paths.REPO_ROOT / "data" / "cache" / CACHE_DIRNAME

    @classmethod
    def load(cls, cache_dir: Path | None = None) -> "IssuerIndex | None":
        """Load the caches, or ``None`` when they have not been refreshed."""
        directory = cache_dir or cls.cache_dir()
        entities_path = directory / ENTITIES_FILE
        if not entities_path.exists():
            return None
        raw = json.loads(entities_path.read_text())
        entities = {
            lei: Entity(
                lei=lei,
                name=record["name"],
                status=record["status"],
                jurisdiction=record.get("jurisdiction"),
                category=record.get("category", ""),
            )
            for lei, record in raw["entities"].items()
        }
        isin_path = directory / ISIN_FILE
        isin_to_lei = json.loads(isin_path.read_text())["isin_to_lei"] if isin_path.exists() else {}
        return cls(
            entities,
            isin_to_lei,
            cache_date=raw.get("content_date", "unknown"),
            source=raw.get("source", "GLEIF"),
        )

    def write(self, directory: Path | None = None) -> None:
        target = directory or self.cache_dir()
        target.mkdir(parents=True, exist_ok=True)
        (target / ENTITIES_FILE).write_text(
            json.dumps(
                {
                    "source": self.source,
                    "content_date": self.cache_date,
                    "entity_count": len(self.entities),
                    "entities": {
                        lei: {
                            "name": entity.name,
                            "status": entity.status,
                            "jurisdiction": entity.jurisdiction,
                        }
                        for lei, entity in sorted(self.entities.items())
                    },
                },
                indent=0,
                sort_keys=True,
            ).replace("\n", "")
            + "\n"
        )
        (target / ISIN_FILE).write_text(
            json.dumps(
                {
                    "source": self.source,
                    "content_date": self.cache_date,
                    "count": len(self.isin_to_lei),
                    "isin_to_lei": dict(sorted(self.isin_to_lei.items())),
                },
                indent=0,
                sort_keys=True,
            ).replace("\n", "")
            + "\n"
        )

    # -- lookup ------------------------------------------------------------

    def resolve(self, lei: str | None, isin: str | None) -> Resolution | None:
        """The entity a holding row is, by its own LEI, else by its ISIN's LEI.

        The filing's LEI is direct evidence about the *row*; the ISIN's LEI is
        evidence about the *security*, so the two are different rungs and the
        manifest keeps them apart. An ISIN that GLEIF maps to more than one LEI was
        dropped when the cache was built.

        Two refusals matter more than they look:

        * A GLEIF entity whose category is ``FUND`` is a collective investment
          vehicle. A row holding its shares is a fund-of-funds position, and this
          product's rule is that a fund share never becomes an issuer identity —
          the same reason a fund holding is not counted as a company exposure.
        * A row that carries a well-formed LEI GLEIF has no record for is a filing
          error, not a mapping opportunity; it stays unmapped and is counted.

        Every refusal increments a counter, and the manifest publishes them: a row
        that is unmapped *after* the namespace ran has a different meaning from one
        that was never offered.
        """
        if lei and valid_lei(lei):
            entity = self.entities.get(lei.strip().upper())
            if entity is not None:
                if entity.category == "FUND":
                    self._refuse("fund_entity")
                    return None
                return Resolution(entity.company_id, entity.name, RUNG_LEI)
            self._refuse("no_gleif_record")
            return None
        if isin:
            mapped = self.isin_to_lei.get(isin.strip().upper())
            if mapped is None:
                self._refuse("isin_unmapped")
                return None
            entity = self.entities.get(mapped)
            if entity is None:
                self._refuse("isin_lei_no_record")
                return None
            if entity.category == "FUND":
                self._refuse("fund_entity")
                return None
            return Resolution(entity.company_id, entity.name, RUNG_ISIN_LEI)
        self._refuse("no_identifier")
        return None

    def note_bridge(self, rung: str) -> None:
        """A resolved entity that is also an SEC registrant, so the row is a ``c_``."""
        with self._lock:
            self.bridges[rung] += 1

    def _refuse(self, reason: str) -> None:
        with self._lock:
            self.refusals[reason] += 1

    def stats(self) -> dict[str, object]:
        return {
            "entities": len(self.entities),
            "isin_map": len(self.isin_to_lei),
            "cache_date": self.cache_date,
            "statuses": dict(sorted(self._statuses.items())),
            "refusals": dict(sorted(self.refusals.items())),
            "bridges": dict(sorted(self.bridges.items())),
        }


# ---------------------------------------------------------------------------
# Refresh — the only part that touches the network
# ---------------------------------------------------------------------------


def _download(url: str, target: Path, *, expect_zip: bool = True) -> Path:
    if target.exists() and target.stat().st_size > 0:
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    partial = target.with_suffix(target.suffix + ".part")
    with urllib.request.urlopen(request, timeout=120) as response, partial.open("wb") as handle:
        while chunk := response.read(1 << 20):
            handle.write(chunk)
    partial.replace(target)
    return target


def _iter_xml_records(stream: io.TextIOBase) -> Iterator[dict[str, str]]:
    """Stream ``LEIRecord`` elements out of the 8.5 GB concatenated file.

    Line-oriented rather than ``iterparse``: the file is one element per line and an
    ElementTree over 3.5 M records costs minutes and gigabytes. Only the fields this
    pipeline publishes are read: LEI, legal name, jurisdiction, entity category,
    entity status. They are matched in *document* order, which is the order LEI-CDF
    writes them; a field read out of that order is a field that never matches.

    The record's open tag carries its namespace declaration
    (``<lei:LEIRecord xmlns:lei="…">``), so the start test is a prefix match, not an
    equality: matching ``"<lei:LEIRecord>"`` exactly never fires, which leaves the
    per-record state from the previous record in place and silently drops every name
    after the first — the bug this comment exists to prevent recurring.
    """
    record: dict[str, str] = {}
    for line in stream:
        if not record:
            if line.lstrip().startswith("<lei:LEIRecord"):
                record = {"lei": "", "name": "", "status": "", "jurisdiction": "", "category": ""}
            continue
        stripped = line.lstrip()
        if stripped.startswith("</lei:LEIRecord>"):
            if record["lei"]:
                yield record
            record = {}
            continue
        if not record["lei"]:
            if stripped.startswith("<lei:LEI>"):
                record["lei"] = _text(line)
        elif not record["name"]:
            if "<lei:LegalName" in line:
                record["name"] = _text(line)
        elif not record["jurisdiction"]:
            if "<lei:LegalJurisdiction>" in line:
                record["jurisdiction"] = _text(line)
        elif not record["category"]:
            if "<lei:EntityCategory>" in line:
                record["category"] = _text(line)
        elif not record["status"]:
            if "<lei:EntityStatus>" in line:
                record["status"] = _text(line)


def _text(line: str) -> str:
    start = line.find(">")
    end = line.rfind("<")
    return html.unescape(line[start + 1 : end]).strip() if 0 <= start < end else ""


def _iter_zip_xml(path: Path) -> Iterator[dict[str, str]]:
    with zipfile.ZipFile(path) as archive:
        name = next(n for n in archive.namelist() if n.endswith(".xml"))
        with archive.open(name) as raw:
            yield from _iter_xml_records(io.TextIOWrapper(raw, encoding="utf-8", errors="replace"))


def _iter_isin_pairs(path: Path) -> Iterator[tuple[str, str]]:
    with zipfile.ZipFile(path) as archive:
        name = next(n for n in archive.namelist() if n.endswith(".csv"))
        with archive.open(name) as raw:
            first = True
            for line in io.TextIOWrapper(raw, encoding="utf-8", errors="replace"):
                if first:
                    first = False
                    continue
                lei, _, isin = line.strip().partition(",")
                if lei and isin:
                    yield lei.upper(), isin.upper()


def refresh(
    *,
    date: str,
    wanted_leis: Iterable[str] | None = None,
    wanted_isins: Iterable[str] | None = None,
    isin_uuid: str | None = None,
    cache_dir: Path | None = None,
    log: callable = print,
) -> IssuerIndex:
    """Build the caches from the GLEIF golden copy and ISIN mapping.

    ``wanted_leis`` / ``wanted_isins`` narrow the cache to the corpus in hand: the
    golden copy holds 3.48 M entities and a release needs the ~20 k it can meet.
    Passing ``None`` keeps everything (only sensible for a small test).
    """
    directory = cache_dir or IssuerIndex.cache_dir()
    directory.mkdir(parents=True, exist_ok=True)
    # GLEIF addresses both files by a compact date (``20261030``); the cache keeps
    # the file names GLEIF published so a reviewer can match them to the site.
    stamp = date.replace("-", "")
    golden = _download(GOLDEN_COPY_URL.format(date=stamp), directory / f"lei2-{stamp}.zip")
    wanted = {lei.strip().upper() for lei in wanted_leis or []} or None

    started = time.monotonic()
    entities: dict[str, Entity] = {}
    content_date = date
    for record in _iter_zip_xml(golden):
        lei = record["lei"].strip().upper()
        if wanted is not None and lei not in wanted:
            continue
        legal = record.get("name", "")
        if not legal:
            continue
        entities[lei] = Entity(
            lei=lei,
            name=display_name(legal),
            status=record.get("status", "UNKNOWN"),
            jurisdiction=record.get("jurisdiction"),
            category=record.get("category", ""),
        )
    log(f"gleif: {len(entities):,} entities from {golden.name} in {time.monotonic() - started:.0f}s")

    isin_to_lei: dict[str, str] = {}
    isin_zip = directory / f"isin-lei-{stamp}.zip"
    if isin_uuid:
        _download(
            f"https://mapping.gleif.org/api/v2/isin-lei/{isin_uuid}/download", isin_zip
        )
    if isin_zip.exists():
        wanted_isin = {value.strip().upper() for value in wanted_isins or []} or None
        started = time.monotonic()
        ambiguous: set[str] = set()
        for lei, isin in _iter_isin_pairs(isin_zip):
            if wanted_isin is not None and isin not in wanted_isin:
                continue
            if isin in isin_to_lei and isin_to_lei[isin] != lei:
                ambiguous.add(isin)
                continue
            isin_to_lei[isin] = lei
        for isin in ambiguous:
            isin_to_lei.pop(isin, None)
        log(
            f"gleif: {len(isin_to_lei):,} ISIN→LEI pairs from {isin_zip.name} "
            f"({len(ambiguous):,} ambiguous ISINs refused) in {time.monotonic() - started:.0f}s"
        )

    index = IssuerIndex(
        entities, isin_to_lei, cache_date=content_date, source="GLEIF golden copy (CC0)"
    )
    index.write(directory)
    return index


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m pipeline.gleif", description=__doc__)
    parser.add_argument("--refresh", action="store_true", help="rebuild the caches from GLEIF")
    parser.add_argument("--date", default=time.strftime("%Y-%m-%d", time.gmtime()))
    parser.add_argument("--wanted-leis", type=Path, default=None)
    parser.add_argument("--wanted-isins", type=Path, default=None)
    parser.add_argument("--isin-uuid", default=None, help="per-day uuid of the ISIN mapping file")
    args = parser.parse_args(argv)
    if not args.refresh:
        index = IssuerIndex.load()
        if index is None:
            print("no cache — run with --refresh", file=sys.stderr)
            return 2
        print(json.dumps(index.stats(), indent=2, sort_keys=True))
        return 0

    def load_list(path: Path | None) -> list[str] | None:
        if path is None:
            return None
        payload = json.loads(path.read_text())
        if isinstance(payload, dict):
            for key in ("leis", "isins", "values"):
                if key in payload:
                    return list(payload[key])
            return list(payload)
        return list(payload)

    index = refresh(
        date=args.date,
        wanted_leis=load_list(args.wanted_leis),
        wanted_isins=load_list(args.wanted_isins),
        isin_uuid=args.isin_uuid,
    )
    print(json.dumps(index.stats(), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
