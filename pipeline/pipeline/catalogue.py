"""The objects a browser reads, as opposed to the ones a build writes.

Day 4 published 8,531 funds and a manifest that listed every one of them with its
hash: 1.29 MB raw, 0.42 MB gzipped, and the app downloaded all of it before it
could verify a single fund. The inventory is not the catalogue — the app needs a
ticker list, one hash per fund it actually loads, names for a search box, and the
funds that hold one company. So a release now publishes five small objects and one
large one:

    release.json            the pointer's body: header + where the rest lives (~1 KB)
    tickers.json            every published ticker, sorted (~25 KB gzipped)
    aliases.json            share-class ticker -> the published ticker for its series
    index/{L}.json          bytes + sha256 per fund, sharded by first character
    catalogue.json          ticker -> name, issuer, ETF flag, coverage
    companies/index.json    company_id -> name, ticker, holder count (search)
    companies/{id}.json     company_id -> [[ticker, weight_bp], …] (reverse X-Ray)
    manifest.json           the full file inventory, for audits and `release verify`

Two rules keep the shards honest:

- every shard carries the release's ``as_of``, so a cached object from an older
  release is detectable rather than plausible;
- the objects are derived from the fund documents in the same build, never from a
  side channel, so a company shard cannot name a fund the release does not publish.

``weight_bp`` in a company shard is the fund's *own* weight for that company, the
same integer basis points as the fund document — not a portfolio weight. The
look-through sum stays in the browser (math skill §1).
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any, Iterable

from .artifact import canonical_bytes, sha256_hex

#: Tickers that do not start with a letter share one shard.
SHARD_OTHER = "_"

#: A release larger than this many company shards is a bug, not a big universe.
MAX_COMPANIES = 200_000


def shard_for(ticker: str) -> str:
    """The index shard a ticker belongs to: its first character, or ``_``."""
    first = ticker[:1].upper()
    return first if "A" <= first <= "Z" else SHARD_OTHER


def tickers_object(as_of: str, tickers: Iterable[str]) -> dict[str, Any]:
    """Every published ticker, sorted — the builder's whole catalogue need."""
    return {"as_of": as_of, "tickers": sorted(tickers)}


def index_shards(as_of: str, files: Iterable[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """``funds/{TICKER}.json`` entries → ``index/{L}.json`` documents.

    The shard is what the app checks a fund against, so it carries exactly the two
    facts that check needs. Sharding by first character keeps a portfolio's cold
    load to one or two small requests instead of the whole inventory.
    """
    shards: dict[str, dict[str, Any]] = {}
    for entry in files:
        ticker = _ticker_from_path(entry["path"])
        if ticker is None:
            continue
        shard = shards.setdefault(
            shard_for(ticker), {"as_of": as_of, "funds": {}}
        )
        shard["funds"][ticker] = {"bytes": entry["bytes"], "sha256": entry["sha256"]}
    for document in shards.values():
        document["funds"] = dict(sorted(document["funds"].items()))
    return dict(sorted(shards.items()))


def catalogue_object(
    as_of: str, funds: Iterable[dict[str, Any]], *, etf_classifier: str
) -> dict[str, Any]:
    """Ticker → what a search result needs to show, in as few bytes as possible.

    Entries are arrays rather than objects because 8,531 of them is 470 KB instead
    of 940 KB, and the order is fixed: ``[name, issuer, etf, coverage_pct]``. The
    app's ``loadCatalogue`` is the only reader, so a positional format with one
    documented order is cheaper than a self-describing one nobody reads.

    ``etf_classifier`` rides at the top because the flag is a *test*, not a fact:
    ``name_rule_v1`` misses exchange-traded funds whose name reads like a mutual
    fund (VOO files as ``VANGUARD 500 INDEX FUND``), so a consumer that shows the
    label has to know which test it came from and that ADR-0007 C3 will replace it.
    """
    entries: dict[str, list[Any]] = {}
    for fund in funds:
        entries[fund["ticker"]] = [
            fund["name"],
            fund["issuer"],
            1 if fund.get("etf") else 0,
            fund["coverage_pct"],
        ]
    return {
        "as_of": as_of,
        "etf_classifier": etf_classifier,
        "funds": dict(sorted(entries.items())),
    }


def alias_object(as_of: str, aliases: dict[str, str]) -> dict[str, Any]:
    """Share-class ticker → the published ticker of the same portfolio.

    The SEC fund ticker file lists 28,613 tickers across 12,265 series: a fund is a
    portfolio with many classes (VOO the ETF, VFIAX Admiral, VFINX Investor), and a
    release publishes one file per series. Without this map a visitor who types the
    class they actually own gets "not found", which is the one dead end the plan
    forbids. ``targets`` is alias → published, so a lookup is one dictionary read in
    the browser; the published ticker is never a key (it is its own page) and a
    target that is not published is a validator failure, not a redirect to nowhere.
    """
    return {"as_of": as_of, "targets": dict(sorted(aliases.items()))}


def company_objects(
    as_of: str, documents: Iterable[dict[str, Any]]
) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    """Reverse X-Ray: one shard per company, plus a search index.

    ``company_id`` is the only identity that survives share classes (math §3), so
    the reverse lookup is keyed by it. A fund that reports the same company twice
    (two asset categories, say) is summed into one row, because "this fund holds
    2.1% of NVIDIA" is one fact.
    """
    companies: dict[str, dict[str, Any]] = {}
    for document in documents:
        ticker = document["ticker"]
        for row in document["holdings"]:
            company_id = row.get("company_id")
            if not company_id:
                continue
            weight_bp = int(row["weight_bp"])
            if weight_bp == 0:
                continue
            entry = companies.setdefault(
                company_id,
                {"name": row["name"], "ticker": row.get("ticker"), "name_weight": weight_bp, "funds": {}},
            )
            # The label comes from the row that carries the most weight, so the
            # name does not depend on which fund happened to be read first.
            if weight_bp > entry["name_weight"]:
                entry["name_weight"] = weight_bp
                entry["name"] = row["name"]
                entry["ticker"] = row.get("ticker")
            elif entry["ticker"] is None and row.get("ticker"):
                entry["ticker"] = row["ticker"]
            entry["funds"][ticker] = entry["funds"].get(ticker, 0) + weight_bp

    if len(companies) > MAX_COMPANIES:
        raise ValueError(f"{len(companies):,} companies exceeds the {MAX_COMPANIES:,} shard guard")

    index: list[list[Any]] = []
    shards: dict[str, dict[str, Any]] = {}
    for company_id in sorted(companies):
        entry = companies[company_id]
        holders = dict(sorted(entry["funds"].items(), key=lambda pair: (-pair[1], pair[0])))
        shards[company_id] = {
            "as_of": as_of,
            "company_id": company_id,
            "name": entry["name"],
            "ticker": entry["ticker"],
            "funds": [[ticker, weight] for ticker, weight in holders.items()],
        }
        index.append([company_id, entry["name"], entry["ticker"], len(holders)])

    return {"as_of": as_of, "companies": index}, shards


def release_object(
    *,
    header: dict[str, Any],
    objects: dict[str, Any],
) -> dict[str, Any]:
    """The document the pointer publishes: the header plus where everything is."""
    return {
        "schema_version": 2,
        "kind": "release",
        **header,
        "objects": objects,
    }


def object_entry(path: str, payload: bytes) -> dict[str, Any]:
    return {"path": path, "bytes": len(payload), "sha256": sha256_hex(payload)}


def encode(document: dict[str, Any]) -> bytes:
    return canonical_bytes(document)


def _ticker_from_path(path: str) -> str | None:
    if not path.startswith("funds/") or not path.endswith(".json"):
        return None
    return path[len("funds/") : -len(".json")]


def summarise(sizes: dict[str, int]) -> str:
    """One log line: how big the objects a browser reads turned out to be."""
    total = sum(sizes.values())
    biggest = max(sizes.items(), key=lambda pair: pair[1]) if sizes else ("none", 0)
    return (
        f"objects: {len(sizes)} file(s), {total / 1e3:.0f} kB "
        f"(largest {biggest[0]} {biggest[1] / 1e3:.0f} kB)"
    )


def gzip_ratio(payload: bytes) -> float:
    """Compressed size over raw, for the log line that says what a browser pays."""
    import gzip

    compressed = gzip.compress(payload, 6)
    return len(compressed) / max(len(payload), 1)


def write_release_objects(
    release_dir: Path | str,
    *,
    release: str,
    documents: list[dict],
    files: list[dict],
    header: dict,
    manifest_payload: bytes,
    aliases: dict[str, str] | None = None,
    etf_classifier: str = "",
) -> dict:
    """Write the objects a browser reads and describe them in ``release.json``.

    Sizes are logged because they are the reason this exists: the day-4 manifest was
    1.29 MB (0.42 MB gzipped) and the app downloaded it before verifying one fund.
    """
    release_dir = Path(release_dir)
    sizes: dict[str, int] = {}

    def write(relative: str, document: dict) -> dict:
        body = encode(document)
        target = release_dir / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body)
        sizes[relative] = len(body)
        return object_entry(relative, body)

    tickers = tickers_object(release, [document["ticker"] for document in documents])
    tickers_entry = write("tickers.json", tickers)

    shard_entries: dict[str, dict] = {}
    for shard, document in index_shards(release, files).items():
        shard_entries[shard] = write(f"index/{shard}.json", document)

    catalogue_entry = write(
        "catalogue.json",
        catalogue_object(
            release,
            [
                {
                    "ticker": document["ticker"],
                    "name": document["name"],
                    "issuer": document["issuer"],
                    "etf": document["etf"],
                    "coverage_pct": document["coverage_pct"],
                }
                for document in documents
            ],
            etf_classifier=etf_classifier,
        ),
    )

    alias_entries = aliases or {}
    alias_entry = write("aliases.json", alias_object(release, alias_entries))

    company_index, company_shards = company_objects(release, documents)
    company_index_entry = write("companies/index.json", company_index)
    for company_id, document in company_shards.items():
        write(f"companies/{company_id}.json", document)

    release_document = release_object(
        header={
            key: value
            for key, value in header.items()
            if key not in {"schema_version", "files"}
        },
        objects={
            "manifest": object_entry("manifest.json", manifest_payload),
            "tickers": tickers_entry,
            "catalogue": catalogue_entry,
            "fund_index": {
                "prefix": "index/",
                "shards": sorted(shard_entries),
                "funds": len(files),
            },
            "companies": {
                "index": company_index_entry,
                "prefix": "companies/",
                "count": len(company_shards),
            },
            "aliases": {
                "object": alias_entry,
                "count": len(alias_entries),
            },
        },
    )
    release_payload = encode(release_document)
    (release_dir / "release.json").write_bytes(release_payload)
    sizes["release.json"] = len(release_payload)

    total = sum(size for path, size in sizes.items() if path != "release.json")
    summary = (
        f"{len(sizes):,} object(s), {total / 1e6:.2f} MB — "
        f"tickers {sizes['tickers.json'] / 1e3:.0f} kB, catalogue {sizes['catalogue.json'] / 1e3:.0f} kB, "
        f"{len(shard_entries)} index shard(s), {len(company_shards):,} company shard(s) "
        f"({sum(size for path, size in sizes.items() if path.startswith('companies/')) / 1e6:.1f} MB), "
        f"{len(alias_entries):,} alias(es) ({sizes['aliases.json'] / 1e3:.0f} kB), "
        f"pointer {len(release_payload) / 1e3:.1f} kB"
    )
    return {
        "summary": summary,
        "sizes": dict(sorted(sizes.items())),
        "release_bytes": len(release_payload),
        "release_sha256": sha256_hex(release_payload),
    }


__all__ = [
    "MAX_COMPANIES",
    "SHARD_OTHER",
    "alias_object",
    "catalogue_object",
    "company_objects",
    "encode",
    "gzip_ratio",
    "index_shards",
    "object_entry",
    "release_object",
    "shard_for",
    "summarise",
    "tickers_object",
    "write_release_objects",
]

_ = math  # keep the import for future size maths without an unused-import warning
