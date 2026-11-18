"""Money-market fund aliases: the series that file N-MFP and never file N-PORT.

A money market fund reports on Form N-MFP monthly and publishes no N-PORT, so it cannot
appear in a holdings release however long the index is read. AU-2 (docs/platform/
automation-spec.yaml) publishes the list of those series so the product can accept their
tickers and leave them out of the stock math — `release_files_new.mmf_aliases`:

    Array<{ ticker; series_id; class_id?; name; latest_form: 'N-MFP2'|'N-MFP3' }>

Three facts decide the design, all measured on 2026-11-18:

* **The form carries the series, not the ticker.** `primary_doc.xml` has `<seriesId>` and
  `<nameOfSeries>`; it has no class or ticker tag at all. So the series comes from the
  filing and the tickers come from the SEC fund ticker file the pipeline already loads
  (`universe._mf_map` / `_series_symbols`).
* **A trust can hold both kinds of series.** Vanguard Money Market Reserves files one
  N-MFP for one series while its CIK owns several, so the inference must key on the
  filing's series id, never on the CIK.
* **A filing is permanent.** One read per accession is enough forever, which is what
  makes `pending.json` → `aliases.json` a queue rather than a nightly crawl.

Nothing here is written into a fund document; the list is one release object and the
validator keeps it disjoint from the published N-PORT universe.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import xml.etree.ElementTree as ElementTree
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

from . import sec, universe

#: The forms that make a series a money-market fund. N-MFP1 (retired) and bare N-MFP are
#: excluded: the contract names N-MFP2 and N-MFP3 only.
MMF_FORMS = ("N-MFP2", "N-MFP3")
MMF_AMENDMENTS = ("N-MFP2/A", "N-MFP3/A")
ALL_FORMS = MMF_FORMS + MMF_AMENDMENTS

#: `<seriesId>S000004462</seriesId>`
SERIES_RE = re.compile(r"^S\d{9}$")
TICKER_RE = re.compile(r"^[A-Z0-9][A-Z0-9.\-]{0,9}$")

PENDING = Path("mmf") / "pending.json"
ALIASES = Path("mmf") / "aliases.json"
SEED = Path(__file__).resolve().parent.parent / "data" / "mmf" / "aliases-seed.json"


def is_mmf_form(form: str) -> bool:
    return form in ALL_FORMS


def cache_dir() -> Path:
    """The root the relative cache paths above resolve against."""
    return sec.CACHE_DIR


def read_json(path: Path) -> dict[str, Any] | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def write_json(path: Path, document: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(document, indent=1, sort_keys=True) + "\n", encoding="utf-8")


def _localname(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _text(root: ElementTree.Element, name: str) -> str | None:
    for element in root.iter():
        if _localname(element.tag) == name and element.text:
            return element.text.strip()
    return None


def parse_filing(body: bytes) -> dict[str, str] | None:
    """`{series_id, name}` from an N-MFP `primary_doc.xml`, or None if it is not one.

    Namespace-agnostic on purpose: N-MFP2 and N-MFP3 use different default namespaces
    (`.../nmfp2`, `.../nmfp3`), and a parser keyed to one would silently skip the other.
    """
    try:
        root = ElementTree.fromstring(body)
    except ElementTree.ParseError:
        return None
    series = _text(root, "seriesId")
    name = _text(root, "nameOfSeries")
    if not series or not SERIES_RE.match(series):
        return None
    return {"series_id": series, "name": name or series}


def entries_for(
    series_id: str,
    name: str,
    form: str,
    symbols: Mapping[str, Sequence[str]],
    classes: Mapping[str, tuple[str, str, str]],
) -> list[dict[str, str]]:
    """One entry per ticker of ``series_id``, from the SEC fund ticker file.

    ``classes`` is ticker → (cik, seriesId, classId). A ticker the file lists under a
    different series is never borrowed: a wrong alias would put one fund's ticker on
    another fund's row.
    """
    entries: list[dict[str, str]] = []
    for ticker in symbols.get(series_id, ()):
        mapped = classes.get(ticker)
        if mapped is None or mapped[1] != series_id:
            continue
        if not TICKER_RE.match(ticker):
            continue
        entries.append(
            {
                "ticker": ticker,
                "series_id": series_id,
                "class_id": mapped[2],
                "name": name,
                "latest_form": form.split("/")[0],
            }
        )
    return entries


def merge(*lists: Iterable[Mapping[str, str]]) -> list[dict[str, str]]:
    """Union by ticker, newest filing winning, sorted by ticker.

    A class that changes series id (a reorganisation) keeps one row — the newest — so the
    validator's "one ticker, one row" rule holds by construction.
    """
    by_ticker: dict[str, dict[str, str]] = {}
    for entries in lists:
        for entry in entries:
            ticker = entry["ticker"]
            previous = by_ticker.get(ticker)
            if previous is None or _form_rank(entry) >= _form_rank(previous):
                by_ticker[ticker] = dict(entry)
    return [by_ticker[ticker] for ticker in sorted(by_ticker)]


def _form_rank(entry: Mapping[str, str]) -> tuple[int, str]:
    return (1 if entry.get("latest_form") == "N-MFP3" else 0, entry.get("series_id", ""))


def load_seed() -> list[dict[str, str]]:
    document = read_json(SEED)
    return list((document or {}).get("aliases") or [])


def load_cache() -> list[dict[str, str]]:
    document = read_json(cache_dir() / ALIASES)
    return list((document or {}).get("aliases") or [])


def save_cache(aliases: Sequence[Mapping[str, str]]) -> None:
    write_json(cache_dir() / ALIASES, {"aliases": merge(aliases)})


def queue_pending(rows: Iterable[Mapping[str, str]]) -> int:
    """Remember MMF filings the daily index already paid for; no extra request.

    Called by `refresh.detect` (which has the index in memory) and drained by the build.
    Keyed by accession, so re-reading an index day costs nothing.
    """
    path = cache_dir() / PENDING
    document = read_json(path) or {"seen": {}, "rows": []}
    seen: dict[str, str] = document.get("seen") or {}
    known = set(seen)
    added = 0
    for row in rows:
        accession = row["accession"]
        if accession in known:
            continue
        seen[accession] = row["form"]
        document["rows"].append(dict(row))
        known.add(accession)
        added += 1
    write_json(path, {"seen": seen, "rows": document["rows"]})
    return added


def drain_pending(fetch=sec.fetch) -> tuple[list[dict[str, str]], int]:
    """Read each queued filing once, turn it into alias entries, clear the queue.

    Returns (entries, requests). A filing that cannot be read stays out of the answer and
    is dropped: the next N-MFP for that series re-queues it, and a permanently unreadable
    document must not wedge the queue.
    """
    path = cache_dir() / PENDING
    document = read_json(path) or {"seen": {}, "rows": []}
    rows = document.get("rows") or []
    if not rows:
        return [], 0
    symbols = universe._series_symbols()
    classes = universe._mf_map()
    entries: list[dict[str, str]] = []
    requests = 0
    for row in rows:
        url = sec.primary_doc_url(row["cik"], row["accession"])
        try:
            body = fetch(url)
            requests += 1
        except sec.SecError:
            continue
        parsed = parse_filing(body)
        if parsed is None:
            continue
        entries.extend(
            entries_for(parsed["series_id"], parsed["name"], row["form"], symbols, classes)
        )
    write_json(path, {"seen": document.get("seen") or {}, "rows": []})
    return entries, requests


def for_release(published: Iterable[str] = ()) -> list[dict[str, str]]:
    """The aliases a release publishes: seed ∪ cache, minus any published N-PORT ticker.

    Never touches the network: the build calls this, and a build must be reproducible
    offline (invariant I5). New filings reach it through `drain_pending` on a night the
    index found some.
    """
    published_set = {ticker.upper() for ticker in published}
    merged = merge(load_seed(), load_cache())
    return [entry for entry in merged if entry["ticker"] not in published_set]


def resolve(network: bool = True) -> list[dict[str, str]]:
    """Drain the queue (network), merge it into the cache, return the published list."""
    if network:
        entries, requests = drain_pending()
        if entries:
            save_cache(merge(load_cache(), entries))
            print(f"mmf: {len(entries)} new alias rows from {requests} filing(s)", flush=True)
    return for_release()


def backfill(days: int = 70, *, fetch=sec.fetch, today=None) -> dict[str, Any]:
    """One-off: queue and resolve every N-MFP filing in the last ``days`` index files.

    Rate: the caller sets SEC_REQUESTS_PER_SECOND (H9). Cost is one request per index day
    plus one per *new* filing; the alias cache makes a second run free.
    """
    from datetime import UTC, date, datetime, timedelta

    from . import refresh

    end = today or datetime.now(UTC).date()
    start = end - timedelta(days=days)
    queued = 0
    index_files = 0
    day = start
    while day <= end:
        url = refresh.index_url(day)
        try:
            body = fetch(url)
        except sec.SecError:
            day += timedelta(days=1)
            continue
        index_files += 1
        rows = [
            {
                "cik": filing.cik,
                "accession": filing.accession,
                "form": filing.form,
                "filed": filing.filed,
            }
            for filing in refresh.parse_index(body.decode("latin-1"))
            if is_mmf_form(filing.form)
        ]
        queued += queue_pending(rows)
        day += timedelta(days=1)
    entries, requests = drain_pending(fetch=fetch)
    save_cache(merge(load_cache(), entries))
    summary = {
        "days": days,
        "index_files": index_files,
        "queued": queued,
        "new_alias_rows": len(entries),
        "filing_requests": requests,
        "cached_aliases": len(load_cache()),
    }
    print(json.dumps(summary, indent=1))
    return summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m pipeline.mmf", description=__doc__)
    parser.add_argument("command", choices=("backfill", "resolve", "show"))
    parser.add_argument("--days", type=int, default=70)
    parser.add_argument("--no-network", action="store_true")
    args = parser.parse_args(argv)

    if args.command == "backfill":
        backfill(args.days)
    elif args.command == "resolve":
        aliases = resolve(network=not args.no_network)
        print(f"mmf: {len(aliases)} aliases")
    else:
        for entry in for_release():
            print(json.dumps(entry, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
