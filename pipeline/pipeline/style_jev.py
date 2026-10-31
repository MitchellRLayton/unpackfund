"""Ask Jev to read a fund's filed name, offline, and record what it says.

The rule engine in :mod:`pipeline.style` reads 8,104 of 9,016 filed names into 256
buckets and returns ``None`` for the rest. That ``None`` is honest — "Teberg Fund"
names no asset class — but it is not complete: some names *do* state a category the
rules miss, and nothing has ever checked the buckets the rules do produce.

This module is the offline reader. Three things it is not:

* **Not part of the build.** A release must hash identically twice (I5), so a model
  call inside ``build`` or ``fund_pages`` would break reproducibility. Jev runs as a
  separate job; its answer becomes a row in ``overrides/style_jev.csv``, which is
  committed and reviewed exactly like a hand correction.
* **Not a rule replacement.** ``resolve()`` in :mod:`pipeline.style_overrides` always
  tries the rules first. A Jev row can only fill a gap the rules left, never overwrite
  a rule hit, so deleting this file restores the previous site exactly.
* **Not a source of outside knowledge.** The question tells the model to use only the
  words in the filed name. "Columbia Acorn Fund" is not small-cap value because a model
  remembers it being one; it is unclassifiable because the name says nothing, and
  ``unknown`` is the correct answer for it.

Cost is the point of batching: one request carries ``--batch-items`` names, and the
option set is argued once per question rather than once per fund.

    python -m pipeline.style_jev fill --release ../artifacts/universe-c/releases/2026-10-30.8
    python -m pipeline.style_jev fill --release ... --apply --out overrides/style_jev.csv
    python -m pipeline.style_jev audit --release ... --sample 300
    python -m pipeline.style_jev check --gold overrides/style_jev_gold.csv --predictions ...

``fill`` writes overrides for names the rules could not read. ``audit`` spends the same
money to answer a different question — how often are the rules wrong? — and writes a
report, no overrides. Both are dry runs unless ``--apply`` is passed.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import random
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, Mapping, Sequence

from .r2 import PublicReader, R2Error
from .style import Style, classify, normalise

#: Environment variable names, in the order they are tried. The operator's `.env` uses
#: the second spelling; the first is the canonical one, and a run must not fail on a
#: typo in the name of a key that is right there.
API_KEY_ENV = ("OPENROUTER_API_KEY", "OPEN_ROUTER_API_KEY")

#: Where OpenRouter answers "is this token a live account?". It costs nothing and it is the
#: difference between "the model is down" and "the key in your .env was revoked".
KEY_INFO_URL = "https://openrouter.ai/api/v1/key"

#: The Decisions endpoint. Alpha, and the only one that serves Jev.
ENDPOINT = "https://openrouter.ai/api/alpha/decisions"

#: Pin the version. ``~typesafe/jev-latest`` moves under an evaluated threshold.
DEFAULT_MODEL = "typesafe/jev-1.14"

#: The answer that means "the name does not say". A first-class option, not a failure.
UNKNOWN = "unknown"

#: A row is only written when the model is this sure. The gold set is what earns the
#: number: 0.85 was chosen before the first run and is re-checked by ``check``.
DEFAULT_MIN_CONFIDENCE = 0.85

#: The write gate is a *band*, not the whole key. Three runs of the same 100 gold rows scored
#: 81.9%, 86.1% and 87.5% on the whole key — about ±4 rows of model sampling noise on 72
#: certain rows, one standard deviation wide — while the band at or above the write threshold
#: held 93.2%, 93.2% and 93.3%. Gating on the noisy number turns a green job red at random;
#: gating on the band that actually governs writes is the signal that was meant.
DEFAULT_MIN_BAND_ACCURACY = 0.90

#: A regression floor for the whole key, set below every sample observed so far. It catches a
#: model that has genuinely degraded, and it never fires on sampling noise alone.
DEFAULT_MIN_ACCURACY = 0.75

#: Names per request. Big enough to amortise the option argument, small enough that the
#: request stays well below the size at which OpenRouter switches the provider into
#: TypeSafe's long-context mode (documented as slower and less accurate). Measured, not
#: assumed: 6 names with 64 options is 23.6 KB, 8 is 31.4 KB (over the guard below), so the
#: defaults are 6 and 64.
DEFAULT_BATCH_ITEMS = 6

#: How many of the rule engine's own labels to offer: every allocation label plus the most
#: common others. A name outside the set gets ``unknown``, which is a defensible answer for
#: a name the rules already could not read.
DEFAULT_OPTION_LIMIT = 64

#: Refuse a request that would be served by the long-context path. The independent
#: evaluation of Jev on OpenRouter found the provider flips above roughly 32 KB of text,
#: and the vendor documents that path as slower and less accurate. A gate here means a
#: change to the option text cannot silently buy worse answers.
MAX_REQUEST_BYTES = 30_000

#: The columns of ``overrides/style_jev.csv``. Every column is a ``Style`` field plus
#: the evidence needed to review the row without re-running the model.
#: Columns of the refusal file. Not ``FIELDS``: a refusal has no bucket to record, and
#: forcing it through the override writer produced rows whose every bucket column was
#: blank — which then read back as "no rows".
REFUSAL_FIELDS = (
    "ticker",
    "name",
    "choice",
    "reason",
    "confidence",
    "jev_model",
    "run_id",
)

FIELDS = (
    "ticker",
    "name",
    "key",
    "label",
    "group",
    "region",
    "size",
    "style",
    "theme",
    "confidence",
    "jev_model",
    "run_id",
)


Get = Callable[[str, Mapping[str, str], float], tuple[int, dict]]


def _urlopen_get(url: str, headers: Mapping[str, str], timeout: float) -> tuple[int, dict]:
    request = urllib.request.Request(url, headers=dict(headers))
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, json.loads(response.read().decode())
    except urllib.error.HTTPError as error:
        return error.code, {"body": error.read().decode(errors="replace")[:300]}
    except urllib.error.URLError as error:
        return 0, {"body": str(error)[:300]}


def key_status(api_key: str, *, get: Get | None = None, timeout: float = 45.0) -> tuple[int, dict]:
    """Ask OpenRouter whether a token is a live account. No tokens spent, ever."""
    return (get or _urlopen_get)(
        KEY_INFO_URL, {"Authorization": f"Bearer {api_key}"}, timeout
    )


class JevError(RuntimeError):
    """A request failed in a way worth stopping for."""


def calibration_band(scored: Mapping, *, min_confidence: float) -> tuple[str, Mapping]:
    """The band whose rows are eligible to become overrides: the one at or above the threshold.

    Band names are ``"low-high"``. If the threshold falls inside a band, that band is used;
    if it falls above every band, the top band is used. An empty answer means the report had
    no bands at all, which the gate treats as uncalibrated.
    """
    parsed: list[tuple[float, str, Mapping]] = []
    for name, values in (scored.get("bands") or {}).items():
        try:
            low = float(str(name).split("-")[0])
        except (ValueError, IndexError):
            continue
        parsed.append((low, name, values))
    if not parsed:
        return "", {"rows": 0, "correct": 0, "accuracy": None}
    eligible = [entry for entry in parsed if entry[0] >= min_confidence - 1e-9]
    low, name, values = min(eligible, key=lambda entry: entry[0]) if eligible else max(
        parsed, key=lambda entry: entry[0]
    )
    return name, values


def gate(
    scored: Mapping,
    *,
    min_accuracy: float,
    min_band_accuracy: float,
    min_confidence: float,
) -> tuple[bool, str]:
    """Whether this run's calibration is good enough to write a row. Fails closed.

    Two numbers, for two different jobs. The **band** at or above ``min_confidence`` is the
    population the overrides come from, so it decides. The **whole key** is a floor: it exists
    to catch a model that has genuinely degraded, not to fail a run on sampling noise.
    """
    if not scored.get("rows"):
        return False, "no gold rows were scored, so calibration is unknown"
    if float(scored.get("accuracy") or 0.0) < min_accuracy:
        return (
            False,
            f"gold accuracy {scored['accuracy']:.1%} is below the {min_accuracy:.0%} floor",
        )
    name, band = calibration_band(scored, min_confidence=min_confidence)
    if band.get("rows", 0) >= 10:
        accuracy = band.get("accuracy")
        if accuracy is None or accuracy < min_band_accuracy:
            shown = "none" if accuracy is None else format(accuracy, ".1%")
            return (
                False,
                f"accuracy above {min_confidence:.0%} confidence is {shown} "
                f"(band {name}), below {min_band_accuracy:.0%}",
            )
    return True, "calibration ok"


def api_key_from_env(environ: Mapping[str, str] | None = None) -> str:
    """The first present key name wins; an empty string means there is nothing to spend."""
    source = os.environ if environ is None else environ
    for name in API_KEY_ENV:
        value = source.get(name, "").strip()
        if value:
            return value
    return ""


# --- what we send -------------------------------------------------------------


@dataclass(frozen=True)
class Option:
    """One answer the model may pick, and the ``Style`` that answer means."""

    key: str
    label: str
    style: Style


@dataclass(frozen=True)
class Item:
    """One fund, as the model sees it."""

    ticker: str
    name: str
    issuer: str


def option_set(
    catalogue: Mapping[str, Sequence[object]],
    *,
    limit: int = DEFAULT_OPTION_LIMIT,
) -> list[Option]:
    """The labels to offer, taken from the rule engine's own vocabulary.

    Nothing here is a second taxonomy: each option's ``Style`` is the one ``classify``
    produced for a real fund, so a Jev row can never name a bucket the site does not
    already have a page convention for. Ordered by fund count, ties broken by label,
    so two runs on the same release produce the same options.
    """
    seen: dict[str, Style] = {}
    counts: dict[str, int] = {}
    for ticker in sorted(catalogue):
        row = catalogue[ticker]
        name = str(row[0])
        issuer = str(row[1]) if len(row) > 1 else ""
        style = classify(name, issuer)
        if style is None:
            continue
        counts[style.label] = counts.get(style.label, 0) + 1
        seen.setdefault(style.label, style)

    # Every allocation label is offered, whatever its count. Measured on 2026-10-30.8: at a
    # 48-label cut, five of the seven were missing — conservative, moderate, growth, income
    # and aggressive — and a live probe answered "balanced allocation" for an *aggressive*
    # allocation fund at 0.97 confidence. The model was not wrong; it was never offered the
    # right option. Rare labels are exactly the ones an unreadable name tends to state.
    structural = sorted(label for label in counts if seen[label].group == "allocation")
    ordered = structural[:limit]
    for label in sorted(counts, key=lambda label: (-counts[label], label)):
        if len(ordered) >= limit:
            break
        if label not in ordered:
            ordered.append(label)
    return [
        Option(key=_slug(label), label=label, style=seen[label]) for label in ordered
    ]


def _slug(label: str) -> str:
    return "_".join(normalise(label).split()).lower() or "unknown"


def _instructions(index: int, options: Sequence[Option]) -> str:
    return (
        f"Read `items[{index}].name`, the name a US fund filed with the SEC, and pick "
        "the one bucket that name states.\n"
        "Use only the words in the name. An issuer, a brand, a person's name, or a "
        "ticker is not evidence; a fund whose name does not state an asset class, a "
        "region, a size, a style, or a theme is `unknown`.\n"
        "Share-class words (Admiral, Institutional, Class A, Investor) say nothing "
        "about the holdings. A name that promises two things at once — 'balanced', "
        "'allocation', 'target date' — belongs in the allocation buckets, not in an "
        "equity or bond bucket.\n"
        "Pick `unknown` rather than the closest-sounding bucket. A wrong bucket shows "
        "a visitor a peer group the fund does not belong to, which is worse than no "
        f"peer group at all. `items[{index}].issuer` is recorded but is never evidence."
    )


def _criteria(options: Sequence[Option]) -> dict[str, str]:
    criteria = {option.key: option.label for option in options}
    criteria[UNKNOWN] = (
        "The name does not state an asset class, region, size, style, or theme. "
        "Correct for a brand name, a person's name, a ticker, or a vague name such as "
        "'Select Fund' or 'Growth Fund' with no region and no asset class."
    )
    return criteria


def build_request(
    items: Sequence[Item],
    options: Sequence[Option],
    *,
    model: str = DEFAULT_MODEL,
    session_id: str | None = None,
) -> dict:
    """One Decisions request: the batch as ``state``, one ``choice`` per item."""
    questions: dict[str, dict] = {}
    for index, item in enumerate(items):
        questions[f"item_{index}"] = {
            "type": "choice",
            "instructions": _instructions(index, options),
            "criteria": _criteria(options),
        }
    request: dict = {
        "model": model,
        "state": {
            "items": [
                {"ticker": item.ticker, "name": item.name, "issuer": item.issuer}
                for item in items
            ]
        },
        "questions": questions,
    }
    if session_id:
        request["session_id"] = session_id
    return request


def estimate_cost(request: Mapping) -> tuple[int, float]:
    """Rough input tokens and dollars, from characters. Never used for a decision."""
    text = json.dumps(request, ensure_ascii=False)
    tokens = int(len(text) / 3.8) + 1
    return tokens, tokens * 0.000000042


# --- transport ----------------------------------------------------------------


Transport = Callable[[str, Mapping[str, str], bytes, float], tuple[int, dict]]


def http_transport(
    url: str, headers: Mapping[str, str], body: bytes, timeout: float
) -> tuple[int, dict]:
    """POST JSON, return ``(status, decoded)``. One retry on 429 and 5xx."""
    request = urllib.request.Request(url, data=body, headers=dict(headers), method="POST")
    for attempt in (1, 2):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.status, json.loads(response.read().decode())
        except urllib.error.HTTPError as error:
            payload = error.read().decode(errors="replace")
            status = error.code
            if status in (429, 500, 502, 503, 524, 529) and attempt == 1:
                time.sleep(2.0)
                continue
            raise JevError(f"decisions request failed: {status} {payload[:400]}") from error
        except urllib.error.URLError as error:
            if attempt == 1:
                time.sleep(2.0)
                continue
            raise JevError(f"decisions request failed: {error}") from error
    raise JevError("decisions request failed: exhausted retries")


# --- what comes back ----------------------------------------------------------


@dataclass(frozen=True)
class Reading:
    """One fund's answer, before any policy is applied."""

    item: Item
    choice: str
    label: str | None
    confidence: float
    style: Style | None
    probabilities: Mapping[str, float]


def parse_response(
    response: Mapping,
    items: Sequence[Item],
    options: Sequence[Option],
) -> tuple[list[Reading], float, str]:
    """Turn a Decisions response into readings, with cost and the served model id."""
    answers = response.get("answers")
    if not isinstance(answers, dict):
        raise JevError("decisions response has no answers object")
    by_key = {option.key: option for option in options}
    readings: list[Reading] = []
    for index, item in enumerate(items):
        answer = answers.get(f"item_{index}")
        if not isinstance(answer, dict):
            raise JevError(f"decisions response is missing item_{index}")
        choice = str(answer.get("choice") or "")
        confidence = float(answer.get("confidence") or 0.0)
        probabilities = {
            str(key): float(value)
            for key, value in (answer.get("probabilities") or {}).items()
        }
        option = by_key.get(choice)
        readings.append(
            Reading(
                item=item,
                choice=choice,
                label=option.label if option else None,
                confidence=confidence,
                style=option.style if option else None,
                probabilities=probabilities,
            )
        )
    usage = response.get("usage") or {}
    cost = float(usage.get("cost") or 0.0)
    served = str(response.get("model") or "")
    return readings, cost, served


# --- overrides file -----------------------------------------------------------


def read_overrides(path: Path) -> dict[str, dict[str, str]]:
    """Read the override CSV, keyed by filed name. Comment lines are skipped."""
    if not path.exists():
        return {}
    rows: dict[str, dict[str, str]] = {}
    with path.open(newline="", encoding="utf-8") as handle:
        lines = (line for line in handle if not line.startswith("#"))
        for row in csv.DictReader(lines):
            name = (row.get("name") or "").strip()
            if name and row.get("key"):
                rows[name] = {key: (row.get(key) or "") for key in FIELDS}
    return rows


def read_refusals(path: Path) -> dict[str, dict[str, str]]:
    """Read the refusal CSV, keyed by filed name.

    This file is the *memory* of what has been asked, so its rows deliberately carry no
    bucket. Reading it with ``read_overrides`` silently returned nothing — every row's
    ``key`` column is empty by construction — and the first CI run then re-paid for 300
    names it had already refused and rewrote the file from the run in hand, dropping 409
    rows. One reader per file is the fix: a refusal is a fact about a question asked, not a
    half-filled override.
    """
    if not path.exists():
        return {}
    rows: dict[str, dict[str, str]] = {}
    with path.open(newline="", encoding="utf-8") as handle:
        lines = (line for line in handle if not line.startswith("#"))
        for row in csv.DictReader(lines):
            name = (row.get("name") or "").strip()
            if name:
                rows[name] = {key: (row.get(key) or "") for key in REFUSAL_FIELDS}
    return rows


def write_refusals(path: Path, rows: Iterable[Mapping[str, str]], *, header: str) -> int:
    """Write the refusal CSV in a stable order. Returns the row count."""
    ordered = sorted(rows, key=lambda row: (row["name"], row.get("ticker", "")))
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        handle.write(header)
        writer = csv.DictWriter(handle, fieldnames=list(REFUSAL_FIELDS), lineterminator="\n")
        writer.writeheader()
        for row in ordered:
            writer.writerow({key: row.get(key, "") for key in REFUSAL_FIELDS})
    return len(ordered)


def write_overrides(path: Path, rows: Iterable[Mapping[str, str]], *, header: str) -> int:
    """Write the override CSV in a stable order. Returns the row count."""
    ordered = sorted(rows, key=lambda row: (row["name"], row["ticker"]))
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        handle.write(header)
        writer = csv.DictWriter(handle, fieldnames=list(FIELDS), lineterminator="\n")
        writer.writeheader()
        for row in ordered:
            writer.writerow({key: row.get(key, "") for key in FIELDS})
    return len(ordered)


def accepted(reading: Reading, *, min_confidence: float) -> bool:
    """The only rule that decides whether a reading becomes an override.

    ``unknown`` is never written: it means the rules were right to return nothing.
    """
    return (
        reading.style is not None
        and reading.choice != UNKNOWN
        and reading.confidence >= min_confidence
    )


def row_for(reading: Reading, *, model: str, run_id: str) -> dict[str, str]:
    style = reading.style
    assert style is not None  # guarded by accepted()
    return {
        "ticker": reading.item.ticker,
        "name": reading.item.name,
        "key": style.key,
        "label": style.label,
        "group": style.group,
        "region": style.region or "",
        "size": style.size or "",
        "style": style.style or "",
        "theme": style.theme or "",
        "confidence": f"{reading.confidence:.3f}",
        "jev_model": model,
        "run_id": run_id,
    }


# --- selection ----------------------------------------------------------------


def catalogue_items(catalogue: Mapping[str, Sequence[object]]) -> list[Item]:
    items = []
    for ticker in sorted(catalogue):
        row = catalogue[ticker]
        items.append(
            Item(
                ticker=ticker,
                name=str(row[0]),
                issuer=str(row[1]) if len(row) > 1 else "",
            )
        )
    return items


def fill_candidates(
    items: Sequence[Item],
    *,
    overrides: Mapping[str, Mapping[str, str]],
    refusals: Mapping[str, Mapping[str, str]],
    max_new: int | None = None,
) -> list[Item]:
    """Names the rules cannot read and no earlier run has already answered.

    The two files together are the run's memory, which is what makes the recurring job
    cheap: a name is paid for once. A name that has since become rule-readable is
    skipped here and reported as stale by ``fill``.
    """
    candidates = [
        item
        for item in items
        if classify(item.name, item.issuer) is None
        and item.name not in overrides
        and item.name not in refusals
    ]
    return candidates[:max_new] if max_new is not None else candidates


def audit_sample(
    items: Sequence[Item], *, size: int, seed: int = 20261030
) -> list[Item]:
    """A reproducible sample of names the rules *did* read, for measuring them."""
    classified = [item for item in items if classify(item.name, item.issuer) is not None]
    if size >= len(classified):
        return classified
    rng = random.Random(seed)
    return sorted(rng.sample(classified, size), key=lambda item: item.ticker)


# --- the run ------------------------------------------------------------------


@dataclass
class RunResult:
    readings: list[Reading]
    cost: float
    requests: int
    model: str


def run(
    items: Sequence[Item],
    options: Sequence[Option],
    *,
    transport: Transport,
    api_key: str,
    model: str = DEFAULT_MODEL,
    batch_items: int = DEFAULT_BATCH_ITEMS,
    session_id: str | None = None,
    timeout: float = 90.0,
    min_confidence: float = DEFAULT_MIN_CONFIDENCE,
    progress: Callable[[str], None] | None = None,
) -> RunResult:
    """Send the batches, in order, and collect every reading."""
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    readings: list[Reading] = []
    cost = 0.0
    served = model
    requests = 0
    for start in range(0, len(items), batch_items):
        batch = list(items[start : start + batch_items])
        request = build_request(batch, options, model=model, session_id=session_id)
        body = json.dumps(request, ensure_ascii=False).encode()
        if len(body) > MAX_REQUEST_BYTES:
            raise JevError(
                f"request is {len(body)} B, over the {MAX_REQUEST_BYTES} B long-context "
                "guard: lower --batch-items or --option-limit"
            )
        status, response = transport(ENDPOINT, headers, body, timeout)
        if status != 200:
            raise JevError(f"decisions request failed: {status}")
        batch_readings, batch_cost, served = parse_response(response, batch, options)
        readings.extend(batch_readings)
        cost += batch_cost
        requests += 1
        if progress is not None:
            progress(
                f"  {min(start + batch_items, len(items))}/{len(items)} names · "
                f"${cost:.4f}"
            )
    return RunResult(readings=readings, cost=cost, requests=requests, model=served)


def refusal_rows(
    readings: Sequence[Reading],
    *,
    model: str,
    run_id: str,
    min_confidence: float = DEFAULT_MIN_CONFIDENCE,
) -> list[dict]:
    """Everything that was sent and did not become an override, with the reason."""
    rows = []
    for reading in readings:
        if accepted(reading, min_confidence=min_confidence):
            continue
        rows.append(
            {
                "ticker": reading.item.ticker,
                "name": reading.item.name,
                "reason": "unknown name" if reading.label is None else "below threshold",
                "choice": reading.choice,
                "confidence": f"{reading.confidence:.3f}",
                "jev_model": model,
                "run_id": run_id,
            }
        )
    return rows


def refusal_header() -> str:
    return (
        "# Names sent to Jev that produced no override, and why. This file is the\n"
        "# run's memory: a name here is never paid for twice, so the recurring job\n"
        "# reads the new names only. Delete a row to re-ask about that fund.\n"
    )


def override_header() -> str:
    return (
        "# Fund-style buckets read from the filed name by Jev, for names the rule\n"
        "# engine in pipeline.style cannot read. A rule hit always wins (see\n"
        "# pipeline.style_overrides.resolve), so this file can only fill a gap, and\n"
        "# deleting it restores the previous site exactly. Generated by\n"
        "# `python -m pipeline.style_jev fill --apply`; review a row before trusting\n"
        "# its bucket. Columns are Style fields plus the evidence for the row.\n"
    )


# --- gold set -----------------------------------------------------------------


def read_gold(path: Path) -> list[dict]:
    """The hand-labelled answer key: ``ticker,name,bucket`` with ``bucket`` a label."""
    if not path.exists():
        raise JevError(f"gold file not found: {path}")
    rows = []
    with path.open(newline="", encoding="utf-8") as handle:
        lines = (line for line in handle if not line.startswith("#"))
        for row in csv.DictReader(lines):
            ticker = (row.get("ticker") or "").strip()
            bucket = (row.get("bucket") or "").strip()
            if ticker and bucket:
                rows.append(
                    {
                        "ticker": ticker,
                        "name": (row.get("name") or "").strip(),
                        "bucket": bucket,
                        "certain": (row.get("certain") or "yes").strip().lower(),
                    }
                )
    return rows


def score(
    gold: Sequence[Mapping[str, str]],
    predicted: Mapping[str, tuple[str, float]],
) -> dict:
    """Accuracy overall and per confidence band — the number a threshold is chosen on.

    ``predicted`` maps ticker to ``(label_or_unknown, confidence)``. A bucket the model
    called ``unknown`` counts as wrong here: the gold row says the name does say
    something, and the model missed it.
    """
    scored = [row for row in gold if row["certain"] != "no"]
    bands = {"0.50-0.70": (0.50, 0.70), "0.70-0.85": (0.70, 0.85), "0.85-1.00": (0.85, 1.01)}
    result = {
        "rows": len(scored),
        "skipped_uncertain": len(gold) - len(scored),
        "correct": 0,
        "accuracy": 0.0,
        "bands": {name: {"rows": 0, "correct": 0} for name in bands},
        "misses": [],
    }
    for row in scored:
        label, confidence = predicted.get(row["ticker"], (UNKNOWN, 0.0))
        hit = label == row["bucket"]
        result["correct"] += int(hit)
        if not hit and len(result["misses"]) < 25:
            result["misses"].append(
                {"ticker": row["ticker"], "name": row["name"], "gold": row["bucket"],
                 "jev": label, "confidence": round(confidence, 3)}
            )
        for name, (low, high) in bands.items():
            if low <= confidence < high:
                result["bands"][name]["rows"] += 1
                result["bands"][name]["correct"] += int(hit)
                break
    if result["rows"]:
        result["accuracy"] = round(result["correct"] / result["rows"], 4)
    for band in result["bands"].values():
        band["accuracy"] = round(band["correct"] / band["rows"], 4) if band["rows"] else None
    return result


# --- release loading ----------------------------------------------------------


def load_catalogue(release: Path | None, url: str | None) -> tuple[dict, str]:
    """The catalogue and a release id, from a local release dir or the public pointer."""
    if release is not None:
        document = json.loads((release / "catalogue.json").read_text())
        return document["funds"], release.name
    if url:
        # Read the data host the way every other consumer does. Cloudflare answers 403 to
        # the default `Python-urllib/3.x` identity (see `r2.PUBLIC_USER_AGENT`), which is
        # exactly what a bare `urlopen` sends — so the scheduled job died on its first
        # network call while every curl and every browser got 200.
        reader = PublicReader(url, timeout=120.0)
        try:
            descriptor = reader.fetch_json("latest/release.json")
            release_id = str(descriptor.get("as_of") or "latest")
            # `objects[*].path` is relative to the release prefix, not to the origin — the
            # same idiom `live.py` uses to sample a published file.
            document = reader.fetch_json(
                f"releases/{release_id}/{descriptor['objects']['catalogue']['path']}"
            )
        except R2Error as error:
            raise JevError(f"the catalogue is unreachable at {url}: {error}") from error
        return document["funds"], release_id
    raise JevError("pass --release DIR or --from-url URL")


# --- CLI ----------------------------------------------------------------------


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m pipeline.style_jev", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    for name in ("fill", "audit"):
        command = sub.add_parser(name)
        command.add_argument("--release", type=Path, help="a local release directory")
        command.add_argument("--from-url", default=None, help="e.g. https://data.unpackfund.com")
        command.add_argument("--model", default=DEFAULT_MODEL)
        command.add_argument("--batch-items", type=int, default=DEFAULT_BATCH_ITEMS)
        command.add_argument("--option-limit", type=int, default=DEFAULT_OPTION_LIMIT)
        command.add_argument("--min-confidence", type=float, default=DEFAULT_MIN_CONFIDENCE)
        command.add_argument("--apply", action="store_true", help="make the paid calls")
        command.add_argument("--out", type=Path, default=Path("overrides/style_jev.csv"))
        command.add_argument(
            "--refused", type=Path, default=Path("overrides/style_jev_refused.csv")
        )
        command.add_argument("--report", type=Path, default=None)
        command.add_argument("--max-new", type=int, default=None)
        command.add_argument("--sample", type=int, default=300)
        command.add_argument("--seed", type=int, default=20261030)
        command.add_argument(
            "--gold",
            type=Path,
            default=Path("overrides/style_jev_gold.csv"),
            help="the answer key; every row is sent and scored, and fill refuses to "
            "write overrides when the score is below --min-accuracy",
        )
        command.add_argument(
            "--min-accuracy",
            type=float,
            default=DEFAULT_MIN_ACCURACY,
            help="floor on the whole gold key; catches a degraded model, not noise",
        )
        command.add_argument(
            "--min-band-accuracy",
            type=float,
            default=DEFAULT_MIN_BAND_ACCURACY,
            help="the real gate: accuracy of the rows at or above --min-confidence",
        )

    probe = sub.add_parser("probe")
    probe.add_argument("--release", type=Path, default=None)
    probe.add_argument("--from-url", default=None)
    probe.add_argument("--model", default=DEFAULT_MODEL)
    probe.add_argument(
        "--send",
        action="store_true",
        help="also send one two-fund Decisions request (~$0.0002) to prove the surface",
    )

    check = sub.add_parser("check")
    check.add_argument("--gold", type=Path, required=True)
    check.add_argument("--predictions", type=Path, required=True)
    check.add_argument("--min-accuracy", type=float, default=0.8)

    args = parser.parse_args(argv)

    # The workspace keeps the key in the `.env` one level above the repo, so a run from a
    # plain shell must not fail because nothing exported it. Existing environment wins, and
    # only names are ever printed (see pipeline.release.load_env).
    if args.command in ("fill", "audit", "probe"):
        from .release import load_env

        loaded = load_env()
        if loaded:
            print(f"  credentials from .env: {', '.join(loaded)}")

    if args.command == "probe":
        api_key = api_key_from_env()
        if not api_key:
            print(f"no key: none of {', '.join(API_KEY_ENV)} is set", file=sys.stderr)
            return 2
        status, payload = key_status(api_key)
        if status != 200:
            body = payload.get("body") if isinstance(payload, dict) else None
            message = ""
            if isinstance(payload, dict):
                message = str((payload.get("error") or {}).get("message") or body or "")
            print(f"key rejected by OpenRouter: HTTP {status} · {message}", file=sys.stderr)
            print("  the token in .env does not resolve to a live account: revoked, deleted, "
                  "or not an API key. Create a fresh one at openrouter.ai → Keys, on the "
                  "account that has typesafe/jev-1.14 allowed.", file=sys.stderr)
            return 3
        data = payload.get("data") or {}
        print(f"key ok · label {data.get('label')!r} · usage ${data.get('usage') or 0:.4f} "
              f"· limit {data.get('limit')} · remaining {data.get('limit_remaining')}")
        if not args.send:
            print("no request sent (add --send for one two-fund Decisions call)")
            return 0
        catalogue, release_id = load_catalogue(args.release, args.from_url)
        options = option_set(catalogue)
        items = catalogue_items(catalogue)[:2]
        result = run(
            items, options, transport=http_transport, api_key=api_key, model=args.model,
            batch_items=2, session_id=f"unpackfund-style-jev/probe/{release_id}",
        )
        for reading in result.readings:
            print(f"  {reading.item.name!r:38} -> {reading.label or 'unknown':32} "
                  f"conf {reading.confidence:.3f}")
        print(f"decisions ok · served {result.model} · spent ${result.cost:.6f}")
        return 0

    if args.command == "check":
        gold = read_gold(args.gold)
        predicted_doc = json.loads(args.predictions.read_text())
        predicted = {
            ticker: (row["label"], float(row["confidence"]))
            for ticker, row in predicted_doc.items()
        }
        result = score(gold, predicted)
        print(json.dumps(result, indent=2))
        ok = result["accuracy"] >= args.min_accuracy
        print(f"accuracy {result['accuracy']:.1%} on {result['rows']} rows "
              f"({'pass' if ok else 'FAIL'} at {args.min_accuracy:.0%})")
        return 0 if ok else 1

    catalogue, release_id = load_catalogue(args.release, args.from_url)
    items = catalogue_items(catalogue)
    options = option_set(catalogue, limit=args.option_limit)
    overrides = read_overrides(args.out)
    refusals = read_refusals(args.refused)
    gold = read_gold(args.gold) if args.gold.exists() else []
    by_ticker = {item.ticker: item for item in items}
    gold_items = [by_ticker[row["ticker"]] for row in gold if row["ticker"] in by_ticker]

    if args.command == "audit":
        chosen = audit_sample(items, size=args.sample, seed=args.seed)
        chosen = {item.ticker: item for item in chosen}
        chosen.update({item.ticker: item for item in gold_items})
        chosen = [chosen[ticker] for ticker in sorted(chosen)]
        fillable: set[str] = set()
    else:
        candidates = fill_candidates(
            items, overrides=overrides, refusals=refusals, max_new=args.max_new
        )
        fillable = {item.name for item in candidates}
        union = {item.ticker: item for item in candidates}
        union.update({item.ticker: item for item in gold_items})
        chosen = [union[ticker] for ticker in sorted(union)]

    if not chosen:
        print(f"nothing to do on {release_id}: every candidate name is already answered")
        return 0

    run_id = f"style-jev-{release_id}-{int(time.time())}"
    tokens, dollars = estimate_cost(
        build_request(chosen[: args.batch_items], options, model=args.model,
                      session_id=run_id)
    )
    batches = (len(chosen) + args.batch_items - 1) // args.batch_items
    print(f"{args.command}: {len(chosen)} names ({len(fillable)} fillable) · "
          f"{len(options) + 1} options · {batches} requests · ~${dollars * batches:.4f} "
          f"· {release_id}")

    if not args.apply:
        preview = args.report or Path("artifacts/style-jev") / f"{release_id}.requests.json"
        preview.parent.mkdir(parents=True, exist_ok=True)
        preview.write_text(
            json.dumps(build_request(chosen[: args.batch_items], options,
                                     model=args.model, session_id=run_id), indent=2)
        )
        print(f"dry run: one batch written to {preview}; add --apply to spend")
        return 0

    api_key = api_key_from_env()
    if not api_key:
        raise SystemExit(
            f"none of {', '.join(API_KEY_ENV)} is set; no request was sent"
        )

    result = run(
        chosen,
        options,
        transport=http_transport,
        api_key=api_key,
        model=args.model,
        batch_items=args.batch_items,
        session_id=run_id,
        min_confidence=args.min_confidence,
        progress=print,
    )
    kept = [
        reading
        for reading in result.readings
        if accepted(reading, min_confidence=args.min_confidence)
        and reading.item.name in fillable
    ]

    # Calibration first, and it can stop the write. A model whose certainty has stopped
    # predicting correctness must not be allowed to add rows just because it answered.
    if gold:
        predicted = {
            reading.item.ticker: (reading.label or UNKNOWN, reading.confidence)
            for reading in result.readings
        }
        scored = score(gold, predicted)
        target = Path(f"artifacts/style-jev/{release_id}.gold.json")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(scored, indent=2))
        print(f"gold: {scored['accuracy']:.1%} on {scored['rows']} certain rows "
              f"(skipped {scored['skipped_uncertain']} arguable) · report {target}")
        for band, values in scored["bands"].items():
            print(f"  {band}: {values['correct']}/{values['rows']} "
                  f"({values['accuracy'] if values['accuracy'] is None else format(values['accuracy'], '.1%')})")
        for miss in scored["misses"][:8]:
            print(f"  miss {miss['ticker']}: gold {miss['gold']!r} · jev {miss['jev']!r} "
                  f"@ {miss['confidence']}")
        may_write, reason = gate(
            scored,
            min_accuracy=args.min_accuracy,
            min_band_accuracy=args.min_band_accuracy,
            min_confidence=args.min_confidence,
        )
        if not may_write:
            print(f"refusing to write: {reason}")
            return 1
        print(f"write gate: {reason}")
        if args.command == "audit":
            rules = {
                reading.item.ticker: (
                    classify(reading.item.name, reading.item.issuer).label
                    if classify(reading.item.name, reading.item.issuer)
                    else UNKNOWN
                )
                for reading in result.readings
            }
            agreed = sum(
                1
                for reading in result.readings
                if rules[reading.item.ticker] == (reading.label or UNKNOWN)
            )
            print(f"audit: rules and Jev agreed on {agreed}/{len(result.readings)} "
                  f"({agreed / len(result.readings):.1%})")
            print(f"spent ${result.cost:.5f} over {result.requests} requests on {result.model}")
            return 0

    rows = read_overrides(args.out)
    for reading in kept:
        rows[reading.item.name] = row_for(reading, model=result.model, run_id=run_id)
    written = write_overrides(args.out, rows.values(), header=override_header())
    refused = read_refusals(args.refused)
    for row in refusal_rows(
        result.readings,
        model=result.model,
        run_id=run_id,
        min_confidence=args.min_confidence,
    ):
        refused.setdefault(row["name"], row)
    write_refusals(args.refused, refused.values(), header=refusal_header())
    stale = [row["ticker"] for name, row in rows.items() if classify(name, "") is not None]
    print(f"wrote {written} overrides (+{len(kept)} this run), {len(refused)} refusals, "
          f"{len(stale)} now read by the rules")
    if stale[:5]:
        print(f"  stale (a rule now matches): {', '.join(stale[:5])}")
    print(f"spent ${result.cost:.5f} over {result.requests} requests on {result.model}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
