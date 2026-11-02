"""Two JSON Lines ledgers that answer "how have the nightly runs been going?".

Why this exists: CI logs expire, the `gate-reports` artifact expires after fourteen days,
and a release pointer only says what is live *now*. On 2026-11-02 the operator asked for
the history of the nightly chain and it had to be reconstructed by hand from eight workflow
runs and two artifacts. Nothing wrote a durable record, so "how have the nights gone?" had
no file to read.

One line per run, appended to an object in the artifacts bucket (outside every release
prefix, so publishing a release never touches it):

  monitoring/nightly.jsonl      every `refresh`: built, idle (no new filings), or failed
  monitoring/verify-live.jsonl  every `verify-live`: the five checks, the live release, the verdict

Append semantics are read-modify-write: read the object, add a line, write it back, keep the
last `MAX_RECORDS` lines. Both workflows run under a `concurrency` group, so two appends never
interleave; the worst case is one lost line, never a corrupt ledger. A line is a few hundred
bytes, so a year of nights is tens of kilobytes.

No secrets: the payload is release ids, counts, byte totals, failure keys and check verdicts —
the same numbers the run summary already prints in public.

Usage:

  # in CI (needs R2_ENDPOINT + R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY, as every publisher does)
  python -m pipeline.telemetry append --ledger nightly --artifacts artifacts \
      --kind build --status success --run-id 41481542701 --run-url https://…

  python -m pipeline.telemetry append --ledger verify-live --report verify-live.txt \
      --run-id 41523584117 --run-url https://…

  # on a laptop, to read them
  python -m pipeline.telemetry show --ledger nightly --limit 14
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
from pathlib import Path

from .r2 import NO_CACHE, R2Client, R2Error

#: Ledger name -> object key. Both live beside each other so one listing finds both.
LEDGERS = {
    "nightly": "monitoring/nightly.jsonl",
    "verify-live": "monitoring/verify-live.jsonl",
}
#: Lines kept per ledger. Two runs a day for `verify-live`, one for `nightly`: 500 is a year
#: of nights and still a ~200 KB object, so the object stays small enough to rewrite cheaply.
MAX_RECORDS = 500
LEDGER_CONTENT_TYPE = "application/x-ndjson"

_STATUSES = {"ok", "fail", "warn"}


# ---------------------------------------------------------------- time and JSON Lines
def now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso(moment: dt.datetime) -> str:
    return moment.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def loads(text: str) -> list[dict]:
    """Parse a ledger, skipping torn or hand-edited lines rather than losing the file."""
    records: list[dict] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(record, dict):
            records.append(record)
    return records


def dumps(records: list[dict], max_records: int = MAX_RECORDS) -> str:
    kept = records[-max_records:] if max_records > 0 else records
    return "".join(json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n" for record in kept)


# ---------------------------------------------------------------- read / append
def load(client, ledger: str) -> list[dict]:
    """Read a ledger; a missing object is an empty ledger, not an error."""
    try:
        return loads(client.get(LEDGERS[ledger]).decode("utf-8"))
    except R2Error as error:
        if error.status == 404:
            return []
        raise


def append(client, ledger: str, record: dict, *, max_records: int = MAX_RECORDS) -> list[dict]:
    """Add one line and write the ledger back; returns the ledger as stored."""
    records = load(client, ledger) + [record]
    client.put(LEDGERS[ledger], dumps(records, max_records).encode("utf-8"), content_type=LEDGER_CONTENT_TYPE, cache_control=NO_CACHE)
    return records


def client_from_env() -> R2Client:
    """The publisher's own client: same credentials and bucket as the release upload."""
    from .release import DEFAULT_BUCKET, credentials_from_env

    credentials, endpoint, bucket = credentials_from_env()
    return R2Client(endpoint, bucket or DEFAULT_BUCKET, credentials)


# ---------------------------------------------------------------- the two records
def _int(text: str) -> int | None:
    cleaned = text.replace(",", "").replace("_", "")
    return int(cleaned) if cleaned.isdigit() else None


def parse_verify_live(text: str, *, run_id: str = "", run_url: str = "", at: dt.datetime | None = None) -> dict:
    """Turn `scripts/verify-live.py`'s printed report into a ledger line.

    The verifier prints one header line and one line per check:

        verify-live  site=…  data=…  repo=…
        ok   pointer        live release 2026-11-02.6 (generated …), 9,112 funds, 15,287 companies
        FAIL catalogue      sha256 deadbeef… does not match the pointer
    """
    lines = [line.rstrip() for line in text.splitlines() if line.strip()]
    header = lines[0] if lines and lines[0].startswith("verify-live") else ""
    site = re.search(r"site=(\S+)", header)
    checks: list[dict] = []
    for line in lines[1:] if header else lines:
        fields = line.split(None, 2)
        if len(fields) < 3:
            continue
        status, name, detail = fields
        if status.lower() not in _STATUSES:
            continue
        checks.append({"check": name, "status": status.lower(), "detail": detail.strip()})

    record: dict = {
        "ts": iso(at or now()),
        "kind": "verify-live",
        "run_id": run_id or None,
        "run_url": run_url or None,
        "site": site.group(1) if site else None,
        "ok": bool(checks) and all(check["status"] != "fail" for check in checks),
        "checks": checks,
        "release": None,
        "funds": None,
        "companies": None,
    }
    for check in checks:
        if check["check"] != "pointer":
            continue
        release = re.search(r"release (\S+)", check["detail"])
        funds = re.search(r"([\d,]+) funds", check["detail"])
        companies = re.search(r"([\d,]+) companies", check["detail"])
        record["release"] = release.group(1) if release else None
        record["funds"] = _int(funds.group(1)) if funds else None
        record["companies"] = _int(companies.group(1)) if companies else None
    return record


def _newest(directory: Path, pattern: str) -> dict:
    """The last release named in a directory of `<release>/<file>` artifacts, as JSON."""
    candidates = sorted(directory.glob(pattern))
    for path in reversed(candidates):
        try:
            payload = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(payload, dict):
            return payload
    return {}


def nightly_record(
    artifacts: Path | str,
    *,
    kind: str = "build",
    status: str | None = None,
    release: str = "",
    run_id: str = "",
    run_url: str = "",
    at: dt.datetime | None = None,
) -> dict:
    """Distil a `refresh` run's artifacts into one line: what it built, and what failed.

    Everything here is optional on purpose — the step that calls this runs under
    `if: always()`, so it must survive a run that died before writing any artifact.
    """
    root = Path(artifacts)
    upload = _newest(root / "releases", "*/upload-report.json")
    summary = _newest(root / "releases", "*/build-summary.json")
    triage = _newest(root / "triage", "index.json")

    failures = [str(failure) for failure in upload.get("failures") or []]
    record: dict = {
        "ts": iso(at or now()),
        "kind": kind,
        "status": status or ("failed" if failures else "ok"),
        "run_id": run_id or None,
        "run_url": run_url or None,
        # A promotion knows its release from the pointer, not from artifacts it never wrote.
        "release": release or upload.get("release") or summary.get("release"),
        "objects": len(upload.get("objects") or []) or None,
        "bytes": upload.get("total_bytes"),
        "failures": failures,
        "live_pointer_release": upload.get("live_pointer_release"),
        "funds": summary.get("fund_count"),
        "companies": summary.get("company_count"),
        "elapsed_seconds": summary.get("elapsed_seconds"),
        "triage": None,
    }
    if triage:
        record["triage"] = {
            "total": triage.get("total"),
            "by_kind": triage.get("by_kind") or {},
        }
    started, finished = upload.get("started_at"), upload.get("finished_at")
    if started and finished:
        try:
            record["publish_seconds"] = round(
                (dt.datetime.fromisoformat(finished) - dt.datetime.fromisoformat(started)).total_seconds(), 1
            )
        except ValueError:
            record["publish_seconds"] = None
    if failures and record["status"] == "ok":
        record["status"] = "failed"
    return record


# ---------------------------------------------------------------- reading it back
def render(records: list[dict], *, ledger: str) -> str:
    """A table a human can scan: one row per run, failures called out underneath."""
    if not records:
        return f"no records in {LEDGERS[ledger]}"
    if ledger == "verify-live":
        rows = ["| when | live release | funds | verdict | failed checks |", "|---|---|---:|---|---|"]
        for record in records:
            failed = [check["check"] for check in record.get("checks") or [] if check.get("status") == "fail"]
            rows.append(
                "| {ts} | {release} | {funds} | {verdict} | {failed} |".format(
                    ts=record.get("ts", "?"),
                    release=record.get("release") or "?",
                    funds=record.get("funds") if record.get("funds") is not None else "?",
                    verdict="ok" if record.get("ok") else "FAIL",
                    failed=", ".join(failed) or "—",
                )
            )
        return "\n".join(rows)

    rows = ["| when | kind | release | objects | bytes | triage | failures |", "|---|---|---|---:|---:|---:|---|"]
    for record in records:
        triage = record.get("triage") or {}
        rows.append(
            "| {ts} | {kind} | {release} | {objects} | {bytes} | {triage} | {failures} |".format(
                ts=record.get("ts", "?"),
                kind=record.get("kind", "?"),
                release=record.get("release") or "—",
                objects=record.get("objects") if record.get("objects") is not None else "—",
                bytes=record.get("bytes") if record.get("bytes") is not None else "—",
                triage=triage.get("total", "—"),
                failures=len(record.get("failures") or []),
            )
        )
    details = [
        f"- {record.get('ts')} {record.get('release')}: {failure}"
        for record in records
        for failure in (record.get("failures") or [])
    ]
    if details:
        rows += ["", "**Failures**", ""] + details
    return "\n".join(rows)


# ---------------------------------------------------------------- command line
def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m pipeline.telemetry", description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)

    write = commands.add_parser("append", help="append one line to a ledger")
    write.add_argument("--ledger", choices=sorted(LEDGERS), required=True)
    write.add_argument("--report", type=Path, help="verify-live's printed report (verify-live ledger)")
    write.add_argument("--artifacts", type=Path, default=Path("artifacts"), help="the run's artifacts directory (nightly ledger)")
    write.add_argument("--kind", default="build", choices=("build", "idle", "failed", "promote", "dry-run"))
    write.add_argument("--release", default="", help="the release this run promoted (overrides the artifacts)")
    write.add_argument("--status", default="", help="ok | failed — defaults to the record's own verdict")
    write.add_argument("--run-id", default="")
    write.add_argument("--run-url", default="")
    write.add_argument("--dry-run", action="store_true", help="print the line, write nothing")

    shown = commands.add_parser("show", help="read a ledger back")
    shown.add_argument("--ledger", choices=sorted(LEDGERS), required=True)
    shown.add_argument("--limit", type=int, default=14)
    shown.add_argument("--json", action="store_true", help="print the records instead of the table")

    args = parser.parse_args(argv)
    client = client_from_env()

    if args.command == "show":
        records = load(client, args.ledger)[-args.limit :]
        print(json.dumps(records, indent=2) if args.json else render(records, ledger=args.ledger))
        return 0

    if args.ledger == "verify-live":
        if args.report is None or not args.report.exists():
            print(f"no report at {args.report}", file=sys.stderr)
            return 2
        record = parse_verify_live(args.report.read_text(), run_id=args.run_id, run_url=args.run_url)
    else:
        status = args.status or None
        record = nightly_record(
            args.artifacts,
            kind=args.kind,
            status=status,
            release=args.release,
            run_id=args.run_id,
            run_url=args.run_url,
        )
    line = json.dumps(record, sort_keys=True)
    if args.dry_run:
        print(line)
        return 0
    records = append(client, args.ledger, record)
    print(f"{LEDGERS[args.ledger]}: {len(records)} record(s); appended {line}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
