"""Did anything arrive? — the cheap poll that decides whether to build.

A scheduled release needs one cheap question answered before it spends 40 minutes
and 19,000 EDGAR requests: *has a filing landed since the last release?* EDGAR
answers it in one request per filing day.

``daily-index/form.YYYYMMDD.idx`` is written after the filing day closes (observed
22:01 ET), is about 1.1 MB, and names every accepted filing: form type, company,
CIK, filing date, accession. Intersecting it with this product's registrants is
the whole trigger. The obvious alternative — one ``submissions/CIK…json`` per
registrant — costs 1,159 requests at ~184 kB each to answer the same question, and
is what :mod:`pipeline.filings` does *when it has to read the filings anyway*.

Facts this module is built around (measured 2026-10-29, see
``docs/08-operations/2026-10-30-edgar-refresh-architecture.md``):

* filing counts are extremely skewed — median 25 N-PORT filings a day in 2026 Q3,
  maximum 1,417, with 43% of a quarter's filings inside five days;
* therefore a fixed day count (``--days 1``) is the normal case and a gap catch-up
  (``--days 7``) costs 7 MB, not 7×1,159 requests;
* only the third month of each fiscal quarter is public, so a fund files once per
  quarter and a "nothing new" answer is the expected answer on most days.

This module reports; it does not build. :mod:`pipeline.build` stays the only
writer of a release.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

from . import sec, universe

#: One index file per filing day; the path carries the year and the fiscal quarter.
DAILY_INDEX = "https://www.sec.gov/Archives/edgar/daily-index/{year}/QTR{quarter}/form.{stamp}.idx"

#: What a holdings release can be built from. An amendment restates the whole
#: filing (Form N-PORT General Instructions), so it is a source like any other.
NPORT_FORMS = ("NPORT-P", "NPORT-P/A")

#: ``…/edgar/data/1605941/0002071691-26-023104.txt`` → the accession, with dashes.
_ACCESSION = re.compile(r"edgar/data/\d+/([0-9]{10}-[0-9]{2}-[0-9]{6})\.txt$")


@dataclass(frozen=True)
class Filing:
    """One row of a filing-day index, normalised."""

    form: str
    cik: str
    filed: str
    accession: str
    name: str


def index_url(day: date) -> str:
    """The daily index for ``day``: quarter of the *calendar year*, not the fiscal one."""
    quarter = (day.month - 1) // 3 + 1
    return DAILY_INDEX.format(year=day.year, quarter=quarter, stamp=day.strftime("%Y%m%d"))


def parse_index(text: str) -> list[Filing]:
    """Rows of a ``form.idx`` file, skipping its prose header and separator.

    The daily and quarterly ``form.idx`` files are space-aligned (``master.idx`` is
    the pipe-delimited one), so rows split on two or more spaces; a company name
    with a single space stays intact. Anything that does not carry a real
    ``YYYY-MM-DD`` filing date in column four is header text.
    """
    rows: list[Filing] = []
    for line in text.splitlines():
        parts = [part.strip() for part in re.split(r"\s{2,}", line.strip()) if part.strip()]
        if len(parts) != 5 or not parts[3][:4].isdigit():
            continue
        form, name, cik, filed, filename = parts
        match = _ACCESSION.search(filename)
        if not match:
            continue
        rows.append(
            Filing(
                form=form,
                cik=f"{int(cik):010d}",
                filed=filed,
                accession=match.group(1),
                name=name,
            )
        )
    return rows


def nport_filings(filings: list[Filing]) -> list[Filing]:
    return [filing for filing in filings if filing.form in NPORT_FORMS]


def days_back(today: date, days: int) -> list[date]:
    """The last ``days`` complete filing days, oldest first.

    A filing day is complete once EDGAR closes (22:00 ET) and the index is written
    (22:01 ET), so "yesterday" in UTC is the newest day that is always complete.
    """
    newest = today - timedelta(days=1)
    return [newest - timedelta(days=offset) for offset in range(days - 1, -1, -1)]


def _previous_series(release: Path) -> dict[str, str]:
    """series id → accession (``-`` stripped) from a built release's fund files.

    The release is the state. A fund's own document names the accession its numbers
    came from, so "which accession is the newest one we have" needs no side channel
    and cannot disagree with what the site serves.
    """
    series: dict[str, str] = {}
    funds = release / "funds"
    if not funds.is_dir():
        raise SystemExit(f"refresh: {release} has no funds/ directory")
    for path in funds.glob("*.json"):
        try:
            document = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        fund_id = document.get("fund_id")
        accession = _ACCESSION_FROM_URL.search(document.get("source_url") or "")
        if fund_id and accession:
            series[fund_id] = accession.group(1).replace("-", "")
    return series


#: ``source_url`` is built by ``sec.primary_doc_url``, which strips the dashes:
#: ``…/data/36405/000003640526000473/primary_doc.xml``. Both spellings are accepted
#: so a hand-written or older document cannot silently drop out of the comparison.
_ACCESSION_FROM_URL = re.compile(r"/([0-9]{10}-?[0-9]{2}-?[0-9]{6})/")


def detect(
    days: list[date],
    *,
    universe_ciks: set[str] | None = None,
    previous_release: Path | None = None,
    peek: bool = False,
    progress_every: int = 0,
) -> dict:
    """One summary of "what arrived", from index files plus optional document reads.

    ``universe_ciks`` narrows the answer to registrants this product publishes; the
    daily index names CIKs, not series, so the fund-level answer needs the filings
    themselves (``peek``) — which is the work a build would do anyway.
    """
    started = time.monotonic()
    filings: list[Filing] = []
    index_files = 0
    index_bytes = 0
    missing: list[str] = []

    for day in days:
        url = index_url(day)
        try:
            body = sec.fetch(url)
        except sec.SecError as error:  # a day whose index does not exist yet is data
            missing.append(f"{day.isoformat()}: {error}")
            continue
        index_files += 1
        index_bytes += len(body)
        filings.extend(parse_index(body.decode("latin-1")))

    nport = nport_filings(filings)
    summary: dict = {
        "generated_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "days": [day.isoformat() for day in days],
        "index": {"files": index_files, "bytes": index_bytes, "missing": missing},
        "filings": len(filings),
        "nport_filings": len(nport),
        "nport_forms": {form: sum(1 for f in nport if f.form == form) for form in NPORT_FORMS},
    }

    in_universe = nport
    if universe_ciks is not None:
        in_universe = [f for f in nport if f.cik in universe_ciks]
    summary["universe"] = {
        "registrants": len(universe_ciks) if universe_ciks is not None else None,
        "filings": len(in_universe),
        "registrants_with_filings": len({f.cik for f in in_universe}),
    }
    summary["accessions"] = [
        {"cik": f.cik, "accession": f.accession, "form": f.form, "filed": f.filed}
        for f in sorted(in_universe, key=lambda f: (f.filed, f.cik, f.accession))
    ]

    if peek and in_universe:
        known = _previous_series(previous_release) if previous_release else {}
        superseded: set[str] = set()
        current: set[str] = set()
        unpublished: set[str] = set()
        docs = 0
        for position, filing in enumerate(in_universe, start=1):
            try:
                xml = sec.fetch(sec.primary_doc_url(filing.cik, filing.accession))
            except sec.SecError:
                continue
            docs += 1
            series = _peek_series(xml)
            if not series:
                continue
            if series not in known:
                unpublished.add(series)
            elif known[series] == filing.accession.replace("-", ""):
                current.add(series)
            else:
                superseded.add(series)
            if progress_every and position % progress_every == 0:
                print(f"refresh: peeked {position}/{len(in_universe)}", flush=True)
        summary["peek"] = {
            "documents": docs,
            "series": len(superseded) + len(current) + len(unpublished),
            "published_funds_affected": len(superseded),
            "already_current": len(current),
            "series_not_in_release": len(unpublished),
            "release_series": len(known),
        }

    summary["change"] = {
        # The trigger a builder should use: filings for a registrant we publish.
        "new_filings": len(in_universe) if universe_ciks is not None else len(nport),
        "build": bool(in_universe if universe_ciks is not None else nport),
    }
    summary["elapsed_seconds"] = round(time.monotonic() - started, 1)
    return summary


def _peek_series(xml: bytes) -> str | None:
    from .nport import peek_series_id

    return peek_series_id(xml)


def _print_summary(summary: dict) -> None:
    index = summary["index"]
    universe_counts = summary["universe"]
    print(
        f"refresh: {summary['nport_filings']:,} N-PORT filing(s) across "
        f"{index['files']} index file(s), {index['bytes'] / 1e6:.2f} MB, "
        f"in {summary['elapsed_seconds']}s",
        flush=True,
    )
    if universe_counts["registrants"] is not None:
        print(
            f"refresh: {universe_counts['filings']:,} filing(s) from "
            f"{universe_counts['registrants_with_filings']:,} registrant(s) in the "
            f"published universe ({universe_counts['registrants']:,} registrants)",
            flush=True,
        )
    peeked = summary.get("peek")
    if peeked:
        print(
            f"refresh: {peeked['published_funds_affected']:,} published fund(s) are "
            f"superseded; {peeked['already_current']:,} already match the release; "
            f"{peeked['series_not_in_release']:,} filing(s) are for series the release "
            f"does not publish",
            flush=True,
        )
    for line in index["missing"]:
        print(f"refresh: skipped day {line}", flush=True)
    print(f"refresh: new_filings={summary['change']['new_filings']}", flush=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m pipeline.refresh", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    detect_parser = sub.add_parser(
        "detect", help="report N-PORT filings for the last complete filing day(s)"
    )
    detect_parser.add_argument(
        "--days", type=int, default=1, help="how many complete filing days back (default 1)"
    )
    detect_parser.add_argument(
        "--since", default=None, help="first filing day (YYYY-MM-DD); overrides --days"
    )
    detect_parser.add_argument(
        "--until", default=None, help="last filing day (YYYY-MM-DD); default yesterday UTC"
    )
    detect_parser.add_argument(
        "--universe",
        default="all",
        choices=("all", "none"),
        help="'all' narrows to registrants this product publishes (default), 'none' counts everything",
    )
    detect_parser.add_argument(
        "--peek",
        action="store_true",
        help="read each filing's seriesId and say which published funds it affects",
    )
    detect_parser.add_argument(
        "--release",
        type=Path,
        default=None,
        help="built release whose fund documents are the 'what we already have' state (for --peek)",
    )
    detect_parser.add_argument("--json", type=Path, default=None, help="write the summary here")
    detect_parser.add_argument("--progress-every", type=int, default=0)

    args = parser.parse_args(argv)

    # UTC, not local time: a runner in any other zone would otherwise pick the
    # wrong filing day for the first hours of the UTC day (and a Mac in PT is
    # always one day behind at 22:00 PT, the exact hour this job runs).
    today_utc = datetime.now(UTC).date()
    until = date.fromisoformat(args.until) if args.until else today_utc - timedelta(days=1)
    if args.since:
        first = date.fromisoformat(args.since)
        if first > until:
            print(f"refresh: --since {first} is after --until {until}", file=sys.stderr)
            return 2
        days = [first + timedelta(days=offset) for offset in range((until - first).days + 1)]
    else:
        if args.days < 1:
            print("refresh: --days must be at least 1", file=sys.stderr)
            return 2
        days = days_back(today_utc, args.days)

    ciks: set[str] | None = None
    if args.universe == "all":
        ciks = {ref.cik for ref in universe.all_series()}

    summary = detect(
        days,
        universe_ciks=ciks,
        peek=args.peek,
        previous_release=args.release,
        progress_every=args.progress_every,
    )
    _print_summary(summary)
    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
        print(f"refresh: wrote {args.json}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
