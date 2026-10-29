"""Live checks that answer "is the outside world still the way we left it?".

Never a gate: a failing live check means a network, a provider, or a credential
changed — not that the code is wrong. `pnpm verify` stays offline; this is what a
release step runs first, and what a human runs when a page looks empty.

Two questions, in the order they fail:

1. Is EDGAR answering, and does our declared User-Agent still work? (SEC returns
   403 for a missing or generic UA, which reads like an outage in a log.)
2. Is the data host answering with CORS for the app origin, and are the cache
   headers the ones the contract promises?
"""

from __future__ import annotations

import argparse
import json
import sys
import time

from .r2 import PublicReader
from .release import DEFAULT_ORIGIN, DEFAULT_PUBLIC_BASE, LIVE_POINTER
from .sec import DEFAULT_USER_AGENT, SEC_UA_ENV

SEC_PROBE = "https://www.sec.gov/files/company_tickers_mf.json"
POINTER_CANDIDATES = ("staging/latest/manifest.json", LIVE_POINTER)


def check_sec(user_agent: str) -> tuple[bool, str]:
    import urllib.error
    import urllib.request

    if not user_agent or "example.com" in user_agent or "@" not in user_agent:
        return False, f"no usable User-Agent ({SEC_UA_ENV}); SEC will answer 403"
    request = urllib.request.Request(SEC_PROBE, headers={"User-Agent": user_agent})
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            body = response.read()
    except urllib.error.HTTPError as error:
        return False, f"EDGAR returned HTTP {error.code}"
    except urllib.error.URLError as error:
        return False, f"EDGAR unreachable: {error.reason}"
    elapsed = time.monotonic() - started
    try:
        series = len(json.loads(body).get("data") or [])
    except json.JSONDecodeError:
        return False, "EDGAR answered but the payload was not JSON"
    return True, f"EDGAR {response.status} in {elapsed:.2f}s, {series:,} fund series"


def check_data_host(public: PublicReader, origin: str) -> tuple[bool, str, str | None]:
    """Find a published manifest, then check its CORS and cache behaviour."""
    for key in POINTER_CANDIDATES:
        response = public.fetch(key, origin=origin)
        if response.status != 200:
            continue
        allowed = response.allow_origin
        cache = response.header("cache-control") or ""
        if not allowed:
            return False, f"{key}: no access-control-allow-origin for {origin}", key
        if "no-cache" not in cache:
            return False, f"{key}: cache-control {cache!r} is not no-cache", key
        try:
            manifest = json.loads(response.body)
        except json.JSONDecodeError:
            return False, f"{key}: manifest is not JSON", key
        release = manifest.get("as_of")
        funds = manifest.get("files") or []
        if funds:
            sample = public.fetch(f"releases/{release}/{funds[0]['path']}", origin=origin)
            immutable = sample.header("cache-control") or ""
            if sample.status != 200:
                return False, f"{funds[0]['path']}: HTTP {sample.status}", key
            if "immutable" not in immutable:
                return False, f"{funds[0]['path']}: cache-control {immutable!r} is not immutable", key
        return True, f"data host ok via {key} (release {release}, ACAO {allowed})", key
    return True, "no manifest published yet — CORS check skipped", None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m pipeline.live")
    parser.add_argument("--public-base", default=DEFAULT_PUBLIC_BASE)
    parser.add_argument("--origin", default=DEFAULT_ORIGIN)
    args = parser.parse_args(argv)

    import os

    failures = 0
    ok, detail = check_sec(os.environ.get(SEC_UA_ENV) or DEFAULT_USER_AGENT)
    print(f"  {'ok  ' if ok else 'FAIL'} sec:  {detail}")
    failures += 0 if ok else 1

    ok, detail, key = check_data_host(PublicReader(args.public_base), args.origin)
    print(f"  {'ok  ' if ok else 'FAIL'} r2:   {detail}")
    failures += 0 if ok else 1

    print(f"\nlive checks: {2 - failures}/2 ok")
    return 1 if failures else 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
