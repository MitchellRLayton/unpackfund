#!/usr/bin/env python3
"""Verify production from the outside: pages agree with the live data, and the
`promote` -> `deploy-site` hand-off actually fired.

Why this exists: the hand-off (`deploy-site.yml` re-running after a successful
promotion) is what keeps app code from going stale behind a data promotion, and every
run of it so far was triggered by a push, so the hand-off path itself had never fired.
The check has to run somewhere that does not depend on the operator's laptop being
open, which is why it is a scheduled workflow and not a session reminder.

Checks, in order:
  1. pointer      the live data version reads, and reports its fund count
  2. catalogue    the served catalogue hashes to the pointer's recorded sha256
  3. pages        sampled fund pages print the same coverage the catalogue holds
  4. handoff      the newest promotion after `deploy-site` existed has a matching
                  `workflow_run` run of `deploy-site`, and it succeeded
  5. routes       the five public routes answer 200

Exit code 0 when every check passes or is explicitly skipped; 1 otherwise, with a
plain-language line for each failure.

Usage:
  python3 scripts/verify-live.py
  python3 scripts/verify-live.py --sample VTI,SPY,QQQ --site https://unpackfund.com
  python3 scripts/verify-live.py --skip-handoff          # no gh, no Actions API

Needs `gh` on PATH (authenticated) for check 4; `--skip-handoff` skips it. No secrets
are read or printed.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

UA = "UnpackFund-verify-live/1.0 (+https://unpackfund.com)"
# The edge refuses Python's default user agent with 403 (cloudflare-workers-r2-deploy §6).
HEADERS = {"User-Agent": UA, "Accept": "*/*"}
TIMEOUT = 30
HANDOFF_MAX_AGE = dt.timedelta(hours=30)
# The page says "99.3% of the fund's weight mapped"; the possessive was added to the
# copy after this check was written, and a pattern that misses it reports a healthy
# page as a failure — which is worse than no check, because it trains the reader to
# ignore the one line that would catch a stale page.
COVERAGE_RE = re.compile(
    r"([0-9]+(?:\.[0-9]+)?)% of (?:the fund(?:&#x27;|&rsquo;|')s )?weight mapped"
)


class Problems(list):
    def add(self, msg: str) -> None:
        self.append(msg)


def fetch(url: str) -> bytes:
    last: Exception | None = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                return resp.read()
        except urllib.error.HTTPError as exc:
            raise RuntimeError(f"{url} -> HTTP {exc.code}") from exc
        except Exception as exc:  # noqa: BLE001 - retried below, then reported
            last = exc
            time.sleep(2 + 2 * attempt)
    raise RuntimeError(f"{url} -> {last}")


def fetch_json(url: str) -> dict:
    raw = fetch(url)
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"{url} is not JSON ({exc})") from exc


def iso(value: str) -> dt.datetime:
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))


def gh_api(endpoint: str) -> dict:
    proc = subprocess.run(
        ["gh", "api", endpoint], capture_output=True, text=True, timeout=90, check=False
    )
    if proc.returncode != 0:
        raise RuntimeError(f"gh api {endpoint} failed: {proc.stderr.strip()[:300]}")
    return json.loads(proc.stdout)


def check_pointer(data_base: str, problems: Problems) -> dict | None:
    url = f"{data_base}/latest/release.json?probe={int(time.time())}"
    try:
        pointer = fetch_json(url)
    except RuntimeError as exc:
        problems.add(f"pointer: {exc}")
        return None
    print(
        f"ok   pointer        live release {pointer['as_of']} "
        f"(generated {pointer['generated_at']}), {pointer['fund_count']:,} funds, "
        f"{pointer.get('company_count', 0):,} companies"
    )
    return pointer


def check_catalogue(data_base: str, pointer: dict, problems: Problems) -> dict | None:
    rel = pointer["as_of"]
    want = pointer.get("objects", {}).get("catalogue", {}).get("sha256")
    url = f"{data_base}/releases/{rel}/catalogue.json?probe={int(time.time())}"
    try:
        raw = fetch(url)
    except RuntimeError as exc:
        problems.add(f"catalogue: {exc}")
        return None
    got = hashlib.sha256(raw).hexdigest()
    if not want:
        problems.add(f"catalogue: the pointer for {rel} records no catalogue sha256")
        return None
    if got != want:
        problems.add(
            f"catalogue: sha256 mismatch for {rel} — served {got[:16]}… vs pointer {want[:16]}…"
        )
        return None
    try:
        catalogue = json.loads(raw)
    except json.JSONDecodeError as exc:
        problems.add(f"catalogue: not JSON ({exc})")
        return None
    if catalogue.get("as_of") != rel:
        problems.add(f"catalogue: says as_of {catalogue.get('as_of')} but lives under {rel}")
        return None
    print(f"ok   catalogue      sha256 {got[:16]}… matches the pointer; as_of {rel}")
    return catalogue


def check_pages(site: str, catalogue: dict, sample: list[str], problems: Problems) -> None:
    funds = catalogue.get("funds", {})
    for ticker in sample:
        entry = funds.get(ticker)
        if entry is None:
            problems.add(f"pages: {ticker} is not in the live catalogue at all")
            continue
        want = entry[3]
        try:
            html = fetch(f"{site}/f/{ticker}/").decode("utf-8", "replace")
        except RuntimeError as exc:
            problems.add(f"pages: {ticker}: {exc}")
            continue
        match = COVERAGE_RE.search(html)
        if not match:
            problems.add(f"pages: /f/{ticker}/ has no 'N% of weight mapped' line")
            continue
        got = float(match.group(1))
        if abs(got - float(want)) > 0.05:
            problems.add(
                f"pages: /f/{ticker}/ prints {got}% mapped, the live catalogue says {want}% "
                f"— the page predates the live data version"
            )
            continue
        print(f"ok   pages          /f/{ticker}/ {got}% mapped = catalogue {want}%")


def pick_handoff(runs: list[dict]) -> dict:
    """Which `deploy-site` run proves the hand-off, tolerating a superseded lane.

    `deploy-site` runs in one concurrency group and rebuilds every page from the live pointer,
    so a hand-off that fires while a newer push is deploying is *cancelled* by design — the
    newer run rebuilds the same pages and the promotion still reached the site. Judging the
    newest run alone turned that into a red `verify-live` on 2026-11-02 (two merges four
    minutes apart), which is worse than a missing check: it cries wolf on the busiest days.

    Preference order, strongest evidence first:

    1. a `workflow_run` deploy-site run that succeeded — the hand-off itself;
    2. the same, still running — inconclusive, not red;
    3. any other deploy-site run that succeeded after the promotion — the site was rebuilt
       anyway, but by a push rather than by the promotion, so the caller says so;
    4. nothing — the hand-off did not reach the site.

    Returns `{"proof": run | None, "kind": "handoff" | "rebuild" | None, "newest": run,
    "in_flight": run | None}`.
    """
    newest = max(runs, key=lambda r: r["created_at"])
    handoffs = [r for r in runs if r.get("event") == "workflow_run"]
    succeeded = [r for r in handoffs if r.get("conclusion") == "success"]
    if succeeded:
        return {
            "proof": max(succeeded, key=lambda r: r["created_at"]),
            "kind": "handoff",
            "newest": newest,
            "in_flight": None,
        }
    flying = [r for r in handoffs if r.get("status") in ("queued", "in_progress", "waiting", "pending")]
    if flying:
        return {
            "proof": None,
            "kind": None,
            "newest": newest,
            "in_flight": max(flying, key=lambda r: r["created_at"]),
        }
    rebuilt = [r for r in runs if r.get("conclusion") == "success"]
    if rebuilt:
        return {
            "proof": max(rebuilt, key=lambda r: r["created_at"]),
            "kind": "rebuild",
            "newest": newest,
            "in_flight": None,
        }
    return {"proof": None, "kind": None, "newest": newest, "in_flight": None}


def check_handoff(repo: str, problems: Problems) -> None:
    try:
        workflow = gh_api(f"/repos/{repo}/actions/workflows/deploy-site.yml")
        deploy_site_created = iso(workflow["created_at"])
    except (RuntimeError, KeyError) as exc:
        problems.add(f"handoff: cannot read the deploy-site workflow ({exc})")
        return

    try:
        runs = gh_api(
            f"/repos/{repo}/actions/workflows/promote.yml/runs?per_page=20"
        )["workflow_runs"]
    except (RuntimeError, KeyError) as exc:
        problems.add(f"handoff: cannot list promote runs ({exc})")
        return

    promotes = [r for r in runs if r.get("conclusion") == "success"]
    if not promotes:
        print("skip handoff        no successful promote run found in the last 20 runs")
        return
    promote = max(promotes, key=lambda r: r["created_at"])
    promoted_at = iso(promote["created_at"])

    if dt.datetime.now(dt.timezone.utc) - promoted_at > HANDOFF_MAX_AGE:
        print(
            f"skip handoff        newest successful promotion is "
            f"{promote['created_at']} ({promote['id']}); older than "
            f"{HANDOFF_MAX_AGE.total_seconds() / 3600:.0f}h, so nothing to hand off"
        )
        return
    if promoted_at < deploy_site_created:
        print(
            f"skip handoff        promotion {promote['id']} ({promote['created_at']}) "
            f"predates deploy-site ({workflow['created_at']}); the hand-off could not exist"
        )
        return

    try:
        # Both events: `workflow_run` is the hand-off itself, `push` is the deploy that may
        # have superseded it — and both rebuild every page from the live pointer.
        deploy_runs = gh_api(
            f"/repos/{repo}/actions/workflows/deploy-site.yml/runs?per_page=30"
        )["workflow_runs"]
    except (RuntimeError, KeyError) as exc:
        problems.add(f"handoff: cannot list deploy-site runs ({exc})")
        return

    after = [r for r in deploy_runs if iso(r["created_at"]) >= promoted_at]
    if not after:
        problems.add(
            f"handoff: promotion {promote['id']} succeeded at {promote['created_at']} but no "
            f"`deploy-site` run exists after it — the hand-off did not fire (site pages are "
            f"complete; app code may be a day stale)"
        )
        return
    picked = pick_handoff(after)
    proof, newest, in_flight = picked["proof"], picked["newest"], picked["in_flight"]
    if proof is None and in_flight is not None:
        print(
            f"skip handoff        deploy-site run {in_flight['id']} from promotion "
            f"{promote['id']} is still `{in_flight.get('status')}`; nothing to judge yet"
        )
        return
    if proof is None:
        problems.add(
            f"handoff: the newest deploy-site run after promotion {promote['id']} is "
            f"{newest['id']}, concluded `{newest.get('conclusion')}` — {newest['html_url']}"
        )
        return
    if picked["kind"] == "rebuild":
        print(
            f"ok   handoff        promotion {promote['id']} ({promote['created_at']}) -> no "
            f"hand-off run survived, but deploy-site run {proof['id']} "
            f"({proof['created_at']}, event `{proof.get('event')}`) rebuilt the site after it"
        )
        return
    superseded = (
        ""
        if proof["id"] == newest["id"]
        else f" (run {newest['id']} was `{newest.get('conclusion')}` — a superseded lane, not a failure)"
    )
    print(
        f"ok   handoff        promotion {promote['id']} ({promote['created_at']}) -> "
        f"deploy-site run {proof['id']} ({proof['created_at']}), success{superseded}"
    )


def check_routes(site: str, sample: list[str], problems: Problems) -> None:
    routes = ["/", "/x/", "/funds/", f"/f/{sample[0]}/", "/fund-page.css"]
    codes: list[str] = []
    for route in routes:
        try:
            fetch(f"{site}{route}")
            codes.append(f"{route} 200")
        except RuntimeError as exc:
            problems.add(f"routes: {route}: {exc}")
            codes.append(f"{route} FAIL")
    if not problems or all("200" in c for c in codes):
        print("ok   routes         " + ", ".join(codes))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--site", default=os.environ.get("SITE_HOST", "https://unpackfund.com"))
    parser.add_argument(
        "--data-base", default=os.environ.get("DATA_BASE", "https://data.unpackfund.com")
    )
    parser.add_argument(
        "--repo", default=os.environ.get("GITHUB_REPOSITORY", "MitchellRLayton/unpackfund")
    )
    parser.add_argument("--sample", default="VTI,SPY,QQQ")
    parser.add_argument("--skip-handoff", action="store_true")
    args = parser.parse_args(argv)

    sample = [t.strip().upper() for t in args.sample.split(",") if t.strip()]
    if not sample:
        parser.error("--sample needs at least one ticker")

    problems = Problems()
    print(f"verify-live  site={args.site}  data={args.data_base}  repo={args.repo}")

    pointer = check_pointer(args.data_base, problems)
    catalogue = check_catalogue(args.data_base, pointer, problems) if pointer else None
    if catalogue:
        check_pages(args.site, catalogue, sample, problems)
    if args.skip_handoff:
        print("skip handoff        --skip-handoff")
    else:
        check_handoff(args.repo, problems)
    check_routes(args.site, sample, problems)

    if problems:
        print()
        for problem in problems:
            print(f"FAIL {problem}")
        print(f"\n{len(problems)} check(s) failed")
        return 1
    print("\nall checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
