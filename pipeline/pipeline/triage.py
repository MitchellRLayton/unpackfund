"""Log every submission that could not be published, in one append-only place.

The build already records what it refused: a release directory carries
``build-summary.json``, whose ``failed`` list is one ``{ticker, cik, error}`` row
per submission the build would not publish — 3,282 of them in the 2026-10-30.5
release, from 1,818 money-market funds that never file an N-PORT to a single
malformed XML document. That file is fine for one build and useless as a record:
the next build overwrites it, the console line scrolls away, and a failure that
has repeated for a week looks exactly like one that appeared once.

This module turns that list into a log an operator can triage later:

* one JSON Lines file per UTC day, ``<out>/triage/YYYY-MM-DD.jsonl``, one line
  per failed submission, classified into a stable ``kind``;
* ``index.json`` beside it, so "how many, of what kind, since when" is one small
  download instead of every day file;
* ``--upload`` copies those same two objects to R2 under ``triage/``.

Why JSON Lines in the filestore and not a database: the log is append-mostly,
read by a human once in a while, and written from a batch job with no server
around it. A day file is one object a person can ``curl`` and read, a re-run
merges into it without a transaction, and there is no schema owner, no
migration, and no second store to keep in step with the bucket that already
holds every release. A row store would buy indexed queries this log does not
need yet; it would cost a service that must stay up for a diagnostic to exist.

Why append-only: a line is never deleted or rewritten into silence. If a
submission fails again the existing line's ``seen``/``last_seen`` move and its
``first_seen`` does not, so "still failing" and "failed once, then published"
are different things you can see. A log that removes lines as they stop
appearing is a mutable view of the present, not a record of what happened.

Why a ``kind`` and not the raw message: the message is the only signal a build
leaves behind, it varies by fund (names, dollar amounts, line numbers), and the
useful question — "is today's 3,282 the same population as yesterday's?" — needs
a value that is stable across those variations. The rules are data, ordered,
first match wins, ``other`` last (:data:`RULES`), so a new failure mode shows up
as ``other`` with its message intact and one line of code classifies it.

Exit status is not a gate here. A release with 3,282 failures still exits 0 when
the log is written: the log exists so a human can decide, and failing the refresh
because some funds cannot be published would turn every money-market fund in the
universe into an outage.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Mapping, Sequence

from . import paths
from .r2 import NO_CACHE, Credentials, R2Client, R2Error
from .release import ReleaseError, credentials_from_env, load_env

#: The build writes this next to the funds it published; it is never published.
SUMMARY_NAME = "build-summary.json"
#: `<out>/triage/` — one directory for all days, `index.json` among them.
LOG_DIR = "triage"
INDEX_NAME = "index.json"
DAY_FILE_SUFFIX = ".jsonl"
#: `--out` defaults to the repo's `artifacts/`, not to the current directory:
#: every pipeline script runs with `pipeline/` as the working directory, and a
#: bare `artifacts` there would scatter a second log the workflow never uploads.
DEFAULT_OUT = paths.ARTIFACTS
#: Objects land under the same prefix in the bucket, never in a release path.
LOG_PREFIX = "triage"

#: The record contract, in the order a line writes it. It is also the order a
#: merge keeps, so a hand-read diff of two days is a diff of values, not of keys.
RECORD_KEYS = (
    "logged_utc",
    "release",
    "ticker",
    "cik",
    "kind",
    "error",
    "state",
    "first_seen",
    "last_seen",
    "seen",
)

#: Ordered classification rules: `(kind, pattern)`, first match wins, `other` last.
#:
#: The order is load-bearing, not alphabetical. A "no N-PORT filing" message names
#: the series (`series 'S000104986' has no N-PORT filing`), so `no_filing` must be
#: tried before `series` or every money-market fund would be filed as a series
#: bug. `leverage` must come before `nav_mismatch`: both are ``GateError``s about
#: a schedule that does not add up, and the leverage message is the specific
#: diagnosis of the case the 5% band would otherwise report as a truncation.
#: `other` is a catch-all so the table itself is total — the fallback is a rule
#: like any other, which is what makes "first match wins" true for every message.
RULES: list[tuple[str, re.Pattern[str]]] = [
    ("no_filing", re.compile(r"has no N-PORT filing")),
    ("leverage", re.compile(r"this is leverage")),
    ("nav_mismatch", re.compile(r"over the \d+(?:\.\d+)?% band")),
    ("size", re.compile(r"over the [\d,]+-byte budget")),
    (
        "parse",
        re.compile(
            r"NportParseError:|malformed XML|not an N-PORT document"
            r"|missing genInfo|has no netAssets"
        ),
    ),
    ("no_holdings", re.compile(r"reports no holdings")),
    (
        "series",
        re.compile(r"company_tickers_mf|no override row|override registrant|series"),
    ),
    ("other", re.compile(r".*", re.DOTALL)),
]
#: Every kind a record can carry, in rule order. `by_kind` writes all of them,
#: zeros included, so a kind that stops occurring reads as 0 rather than as a
#: missing key and a chart keeps its columns.
KINDS: tuple[str, ...] = tuple(kind for kind, _ in RULES)


class TriageError(RuntimeError):
    """The log could not be written or published; nothing was recorded."""


@dataclass(frozen=True)
class Failure:
    """One row of `build-summary.json`'s `failed` list, as the build wrote it."""

    ticker: str
    cik: str
    error: str


@dataclass(frozen=True)
class TriageResult:
    """What one run wrote, for the summary print and for `--upload`."""

    release: str
    day: date
    day_path: Path
    index_path: Path
    #: Rows read from `build-summary.json` (a ticker failing twice counts twice).
    entries: int
    #: Records written for this release (one per distinct ticker).
    total: int
    by_kind: dict[str, int]


# -- classification ----------------------------------------------------------
def classify(error: str) -> str:
    """The first rule whose pattern matches ``error``; ``other`` when none does."""
    for kind, pattern in RULES:
        if pattern.search(error or ""):
            return kind
    # Unreachable: the table ends with a catch-all. Kept so the function is total
    # for a type checker even if the table is edited.
    return "other"


# -- reading what the build already decided ----------------------------------
def read_failures(release_dir: Path) -> tuple[str, list[Failure]]:
    """Read the failures a build recorded; never re-derive one from a filing.

    Re-deriving would be a second opinion about a submission the build already
    refused, and the log's job is to record *that* decision, with the message the
    build gave, so the two can be compared later.
    """
    summary_path = release_dir / SUMMARY_NAME
    if not summary_path.is_file():
        raise TriageError(
            f"{release_dir} has no {SUMMARY_NAME} — pass the built release directory "
            "(the one the build wrote), not an artifact or an upload target"
        )
    try:
        summary = json.loads(summary_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise TriageError(f"{summary_path} is not readable JSON: {error}") from error
    if not isinstance(summary, dict):
        raise TriageError(f"{summary_path} is not a JSON object")
    failed = summary.get("failed") or []
    if not isinstance(failed, list):
        raise TriageError(
            f"{summary_path}: 'failed' is {type(failed).__name__}, expected a list"
        )
    failures: list[Failure] = []
    for index, row in enumerate(failed):
        if not isinstance(row, dict):
            raise TriageError(
                f"{summary_path}: failed[{index}] is {type(row).__name__}, expected an object"
            )
        failures.append(
            Failure(
                ticker=str(row.get("ticker") or ""),
                cik=str(row.get("cik") or ""),
                error=str(row.get("error") or ""),
            )
        )
    release = str(summary.get("release") or release_dir.name)
    return release, failures


# -- reading an existing log -------------------------------------------------
def read_day_file(path: Path) -> list[dict]:
    """Parse one JSON Lines day file. Raises `TriageError` on a line that is not JSON."""
    records: list[dict] = []
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as error:
        raise TriageError(f"{path} is not readable: {error}") from error
    for number, line in enumerate(text.splitlines(), start=1):
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError as error:
            raise TriageError(f"{path}:{number} is not JSON: {error}") from error
        if not isinstance(record, dict):
            raise TriageError(f"{path}:{number} is not a JSON object")
        records.append(record)
    return records


def load_log(day_dir: Path) -> tuple[dict[str, list[dict]], list[tuple[Path, str]]]:
    """Every day file on disk, by date, plus the ones that could not be read.

    A corrupted historical day file must not stop today's logging — the operator
    loses one day of history, not the run — so it is returned to be reported and
    skipped. The file for the day being written is different: merging against a
    file that cannot be parsed would silently drop every line in it, so the
    writer refuses instead (see `write_log`).
    """
    logs: dict[str, list[dict]] = {}
    unreadable: list[tuple[Path, str]] = []
    if not day_dir.is_dir():
        return logs, unreadable
    for path in sorted(day_dir.glob(f"*{DAY_FILE_SUFFIX}")):
        try:
            logs[path.stem] = read_day_file(path)
        except TriageError as error:
            unreadable.append((path, str(error)))
    return logs, unreadable


# -- merge -------------------------------------------------------------------
def _instant(moment: datetime | None) -> str:
    """Fixed-width ISO-8601 UTC, so string order is chronological order."""
    return (moment or datetime.now(UTC)).astimezone(UTC).isoformat(timespec="seconds")


def _earliest(*values: object) -> str:
    """The earliest non-empty timestamp; the values are fixed-width, so `min` is enough."""
    stamps = [str(value) for value in values if value]
    return min(stamps) if stamps else ""


def _as_int(value: object) -> int:
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0


def _key(record: Mapping[str, object]) -> tuple[str, str]:
    """The merge identity: one record per (ticker, release)."""
    return (str(record.get("ticker") or ""), str(record.get("release") or ""))


def _prior_counts(
    logs: Mapping[str, list[dict]],
) -> dict[tuple[str, str], dict[str, object]]:
    """Earliest `first_seen` and highest `seen` per key across every day file.

    Carrying these forward is what makes ``first_seen`` mean "when this submission
    started failing" rather than "when today's file was written", and ``seen``
    mean "how many runs have recorded it" rather than "how many times today".
    Both are read by a human deciding what to fix first, and the day file alone
    cannot answer either once a failure persists across days.
    """
    prior: dict[tuple[str, str], dict[str, object]] = {}
    for records in logs.values():
        for record in records:
            key = _key(record)
            kept = prior.get(key)
            if kept is None:
                prior[key] = {
                    "first_seen": str(record.get("first_seen") or ""),
                    "seen": _as_int(record.get("seen")),
                }
                continue
            kept["first_seen"] = _earliest(kept["first_seen"], record.get("first_seen"))
            kept["seen"] = max(_as_int(kept["seen"]), _as_int(record.get("seen")))
    return prior


def _ordered(record: Mapping[str, object]) -> dict:
    """Contract keys first, in contract order; anything else a human added after."""
    ordered = {key: record[key] for key in RECORD_KEYS if key in record}
    ordered.update((key, value) for key, value in record.items() if key not in RECORD_KEYS)
    return ordered


def _jsonl(records: Sequence[Mapping[str, object]]) -> bytes:
    return b"".join(
        (json.dumps(_ordered(record), ensure_ascii=False) + "\n").encode("utf-8")
        for record in records
    )


def merge_records(
    existing: Sequence[dict],
    failures: Sequence[Failure],
    *,
    release: str,
    logged_utc: str,
    prior: Mapping[tuple[str, str], Mapping[str, object]] | None = None,
) -> list[dict]:
    """Fold this run's failures into the day's existing lines.

    Merge identity is ``(ticker, release)``. An existing line keeps its position,
    its ``first_seen`` and any extra keys a human added; its ``cik``/``kind``/
    ``error`` move to what this run saw (the newest message is the one to act on),
    its ``last_seen`` becomes now and its ``seen`` counts up. New lines are
    appended in ticker order so two runs of the same data write the same file.

    A line is never removed. A submission that failed this morning and published
    this afternoon keeps its single line with ``seen: 1``: deleting it would make
    the log answer "what is failing now" instead of "what failed".
    """
    prior = prior or {}
    fresh: dict[str, dict] = {}
    for failure in failures:
        kind = classify(failure.error)
        record = fresh.get(failure.ticker)
        if record is None:
            fresh[failure.ticker] = {
                "logged_utc": logged_utc,
                "release": release,
                "ticker": failure.ticker,
                "cik": failure.cik,
                "kind": kind,
                "error": failure.error,
                "state": "open",
                "first_seen": logged_utc,
                "last_seen": logged_utc,
                "seen": 1,
            }
            continue
        # One submission failing twice in one build would be a build bug, but the
        # merge should still be a merge: count it, and keep the newest message.
        record["seen"] += 1
        record["cik"] = failure.cik or record["cik"]
        record["kind"] = kind
        record["error"] = failure.error

    merged: list[dict] = [dict(record) for record in existing]
    position = {_key(record): index for index, record in enumerate(merged)}

    for ticker in sorted(fresh):
        record = fresh[ticker]
        key = (ticker, release)
        history = prior.get(key) or {}
        record["first_seen"] = _earliest(history.get("first_seen"), record["first_seen"])
        record["seen"] = _as_int(history.get("seen")) + record["seen"]
        at = position.get(key)
        if at is None:
            position[key] = len(merged)
            merged.append(record)
            continue
        previous = merged[at]
        previous["logged_utc"] = logged_utc
        previous["cik"] = record["cik"] or str(previous.get("cik") or "")
        previous["kind"] = record["kind"]
        previous["error"] = record["error"]
        previous["state"] = "open"
        # Never later than it was: an ISO-8601 string that only moves forward is
        # how a rewritten line still keeps the original first sighting.
        previous["first_seen"] = _earliest(previous.get("first_seen"), record["first_seen"])
        previous["last_seen"] = logged_utc
        previous["seen"] = record["seen"]
    return merged


# -- the index ---------------------------------------------------------------
def _counts(records: Sequence[Mapping[str, object]]) -> dict[str, int]:
    """Counts per kind, all of :data:`KINDS` present (zeros included), in rule order."""
    counts = {kind: 0 for kind in KINDS}
    for record in records:
        kind = str(record.get("kind") or "other")
        counts[kind] = counts.get(kind, 0) + 1
    return counts


def build_index(
    logs: Mapping[str, list[dict]],
    *,
    day: str,
    release: str,
    generated_utc: str,
) -> dict:
    """The small document that answers "how many, of what kind, since when".

    ``total``/``by_kind`` describe `release` in the day being written, which is
    what the run just logged; ``days`` describes every day file that exists, so
    the same object is the log's table of contents and its history.
    """
    for_release = [record for record in logs.get(day, []) if record.get("release") == release]
    return {
        "generated_utc": generated_utc,
        "release": release,
        "total": len(for_release),
        "by_kind": _counts(for_release),
        "days": [
            {"date": name, "total": len(records), "by_kind": _counts(records)}
            for name, records in sorted(logs.items())
        ],
    }


# -- writing -----------------------------------------------------------------
def write_log(
    release: str,
    failures: Sequence[Failure],
    *,
    day: date,
    out_dir: Path = DEFAULT_OUT,
    index_path: Path | None = None,
    now: datetime | None = None,
) -> TriageResult:
    """Write (and merge into) the day file, then rewrite the index."""
    logged_utc = _instant(now)
    day_dir = out_dir / LOG_DIR
    day_path = day_dir / f"{day.isoformat()}{DAY_FILE_SUFFIX}"
    index_target = index_path or day_dir / INDEX_NAME
    day_dir.mkdir(parents=True, exist_ok=True)
    index_target.parent.mkdir(parents=True, exist_ok=True)

    logs, unreadable = load_log(day_dir)
    for path, problem in unreadable:
        if path == day_path:
            raise TriageError(
                f"{path} exists but cannot be parsed ({problem}); refusing to merge "
                "over it — move it aside or repair it first"
            )
        print(f"  WARN skipping unreadable day file {path.name}: {problem}")

    merged = merge_records(
        logs.get(day.isoformat(), []),
        failures,
        release=release,
        logged_utc=logged_utc,
        prior=_prior_counts(logs),
    )
    day_path.write_bytes(_jsonl(merged))

    logs[day.isoformat()] = merged
    index = build_index(
        logs, day=day.isoformat(), release=release, generated_utc=logged_utc
    )
    index_target.write_text(
        json.dumps(index, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    for_release = [record for record in merged if record.get("release") == release]
    return TriageResult(
        release=release,
        day=day,
        day_path=day_path,
        index_path=index_target,
        entries=len(failures),
        total=len(for_release),
        by_kind=_counts(for_release),
    )


def log_release(
    release_dir: Path,
    *,
    day: date,
    out_dir: Path = DEFAULT_OUT,
    index_path: Path | None = None,
    now: datetime | None = None,
) -> TriageResult:
    """Read one built release's failures and write them to the log."""
    release, failures = read_failures(release_dir)
    return write_log(
        release, failures, day=day, out_dir=out_dir, index_path=index_path, now=now
    )


def upload_log(result: TriageResult, *, client: R2Client) -> list[str]:
    """Publish the day file and the index under ``triage/``; returns the object keys.

    No pointer and no public read-back: this is a diagnostic, not the bundle the
    site reads. The day file is ``no-cache`` because today's is rewritten by every
    re-run and a stale triage view is worse than another request.
    """
    keys: list[str] = []
    for path, content_type in (
        (result.day_path, "application/x-ndjson"),
        (result.index_path, "application/json"),
    ):
        key = f"{LOG_PREFIX}/{path.name}"
        client.put(key, path.read_bytes(), content_type=content_type, cache_control=NO_CACHE)
        keys.append(key)
    return keys


# -- CLI ---------------------------------------------------------------------
def _day_argument(text: str) -> date:
    try:
        return date.fromisoformat(text)
    except ValueError as error:
        raise argparse.ArgumentTypeError(f"expected YYYY-MM-DD, got {text!r}") from error


def _credentials() -> tuple[Credentials, str, str]:
    """Credential resolution, with the missing-name message `TriageError` promises."""
    loaded = load_env()
    if loaded:
        print(f"  credentials from .env: {', '.join(loaded)}")
    try:
        return credentials_from_env()
    except ReleaseError as error:
        raise TriageError(str(error)) from error


def _print_summary(result: TriageResult) -> None:
    width = max(len(kind) for kind in result.by_kind)
    print(
        f"triage {result.release}: {result.entries:,} failure(s) → "
        f"{result.total:,} open record(s)"
    )
    for kind, count in result.by_kind.items():
        print(f"  {kind:<{width}}  {count:>7,}")
    print(f"  log:   {result.day_path}")
    print(f"  index: {result.index_path}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m pipeline.triage", description=__doc__)
    parser.add_argument(
        "--release",
        required=True,
        help="built release directory containing build-summary.json",
    )
    parser.add_argument(
        "--date",
        type=_day_argument,
        default=None,
        help="day file to write, YYYY-MM-DD (default: today, UTC)",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help=f"log root; the day file goes in <out>/{LOG_DIR}/ (default {DEFAULT_OUT})",
    )
    parser.add_argument(
        "--index",
        type=Path,
        default=None,
        help=f"index path (default <out>/{LOG_DIR}/{INDEX_NAME})",
    )
    parser.add_argument(
        "--upload",
        action="store_true",
        help=f"also publish both objects to R2 under {LOG_PREFIX}/",
    )
    args = parser.parse_args(argv)

    now = datetime.now(UTC)
    day = args.date or now.date()
    out = args.out.resolve() if args.out else DEFAULT_OUT
    index_path = args.index.resolve() if args.index else None
    try:
        release_dir = paths.release_dir(args.release)
        if release_dir is None or not release_dir.is_dir():
            raise TriageError(
                f"{args.release} is not a directory — pass the release directory the build wrote"
            )
        release, failures = read_failures(release_dir)
        # Credentials are resolved before the first write, so a `--upload` run that
        # cannot authenticate is a true no-op: exit 2, nothing written locally, no
        # half-published log to mistake for a complete one.
        credentials = _credentials() if args.upload else None
        result = write_log(
            release,
            failures,
            day=day,
            out_dir=out,
            index_path=index_path,
            now=now,
        )
        _print_summary(result)
        if credentials is not None:
            r2_credentials, endpoint, bucket = credentials
            client = R2Client(endpoint, bucket, r2_credentials)
            try:
                keys = upload_log(result, client=client)
            except R2Error as error:
                raise TriageError(f"upload failed: {error}") from error
            print(f"  r2:    {', '.join(keys)}")
        return 0
    except TriageError as error:
        print(f"FAIL: {error}")
        return 2


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
