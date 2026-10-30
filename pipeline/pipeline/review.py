"""Review a built release against its parent: fixed rules, not an opinion.

    python -m pipeline.review --release artifacts/universe-c/releases/2026-10-30.5 \\
        --parent artifacts/universe-c/releases/2026-10-30.4 \\
        --json artifacts/review/2026-10-30.5.json --fail-on blocker

This is the stage between "staged" and "promoted". The release is already built,
hashed and contract-checked (``pipeline.validate``); the only question left is
whether today's filings moved in a way that is more likely to be *our* defect than
the market's. That question has an answer a machine can give and a human can
check, which is why this module is a fixed rule list and not a model. A model
saying "looks fine" is not a gate: it has no threshold to tune, no way to fail the
same build twice, and no before/after a reviewer can open. Every rule below is a
number the operator can defend in one sentence, and every finding names two
documents to compare.

The rules, and why each threshold is the number it is:

1. ``coverage_drop`` (warn, 1,000 bp) — coverage is the share of weight we could
   attribute to a company. A fund does not lose ten points of it by trading; the
   mapping rung changed, or a rung's output changed under us.
2. ``nav_residual`` (warn, leaves ±200 bp, or worsens by 300 bp) — the weight
   vector reconciles to the fund's own NAV. A residual that leaves a two-point band
   it used to sit inside, or gets three points worse, is a parse or denominator
   error rather than a portfolio event.
3. ``holdings_jump`` (warn, more than 2× or below ½) — a schedule that doubles is a
   double count, and one that halves is a truncated filing. Real turnover does not
   move a row count by a factor of two between consecutive filings.
4. ``top10_jump`` (warn, 1,500 bp) — the ten largest holdings cannot move fifteen
   points of weight on one filing without a merge, a split, or a units bug.
5. ``as_of_regression`` (blocker) — the report date must not go backwards, and it
   must be a period end. An older ``as_of`` means the build picked a superseded
   filing; a mid-month one means it picked the wrong filing entirely.
6. ``filed_before_asof`` (blocker) — a filing cannot be filed before the period it
   reports. This is impossible data, never a judgement call.
7. ``fund_disappeared`` (warn) — a fund that was published and is now absent is a
   universe regression, and its page 404s for anyone holding the old link.
8. ``new_fund`` (info) — the release is wider than its parent. Informational by
   design: growing the universe is the expected direction, and a rule that warns
   about it would train the reader to ignore the report.

Units. Weights and coverage are compared in basis points, because that is the
unit the thresholds and the artifact's ``weight_bp`` are already in; the published
``coverage_pct`` and ``metrics.top10_pct`` are percentages and are converted once,
at load. ``before``/``after`` on a finding carry the value the rule compared, in
the threshold's own unit (bp for weight-like numbers, a count for holdings, an ISO
date for ``as_of``/``filed_at``), so a consumer can recompute the comparison; the
``detail`` line spells the same change in the unit a human reads on the fund page.

Two readings the published documents forced:

* **There is no residual field in a fund document.** The artifact deliberately
  keeps the as-filed vector (``weights`` module: never renormalised), so the
  residual this rule reads is ``Σ weight_bp − 10,000``: the same reconciliation
  ``build.py`` gates in dollars, recovered from the only numbers a reader of the
  release can see. It is signed — a fund holding derivatives can sit above NAV —
  and the rule compares magnitudes, because direction is not a defect.
* **"Last day of a month" is read as the last calendar day *or* the last business
  day.** 66 of the 8,983 documents in ``2026-10-30.5`` report a period that ends on
  a weekend (``2026-05-29`` for a 31 May month end, ``2024-11-29`` for 30 November).
  A literal reading would block a clean release on all of them, and a gate that
  fails every run protects nothing. The intent — ``as_of`` is a period end, not an
  arbitrary date the build happened to pick — survives the reading.

What this module deliberately does not do: it does not re-check the artifact
contract (``pipeline.validate`` owns that), it does not look at the direction of a
weight (a stock going up is not a defect), and it does not decide to publish. It
returns findings and an exit status; the workflow turns that into a gate.

Without ``--parent`` the release is checked against itself: rules 1–4 are skipped
(no second document to compare), rule 5 keeps only its period-end half, rule 6
still runs, rule 7 reads ``catalogue.json`` for the fund set the release claims to
publish, and rule 8 is skipped because every fund would be "new". The summary says
so on every run.

Exit status is the gate: ``2`` when an input cannot be read at all (missing
release, malformed document), ``1`` when ``--fail-on`` severity or worse is
present, ``0`` otherwise.
"""

from __future__ import annotations

import argparse
import calendar
import json
import sys
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from . import paths
from .artifact import utc_now_iso

#: One whole fund, in basis points. The denominator the artifact's weights are
#: filed against, so ``Σ weight_bp − BP_PER_UNIT`` is the residual to NAV.
BP_PER_UNIT = 10_000

#: Every threshold this stage compares against, in one dict, so tuning a rule is
#: a one-line review and not a hunt through the file. Names say the unit.
THRESHOLDS: dict[str, float] = {
    "coverage_drop_bp": 1_000.0,
    "residual_band_bp": 200.0,
    "residual_worsen_bp": 300.0,
    "holdings_double_factor": 2.0,
    "holdings_half_factor": 0.5,
    "top10_jump_bp": 1_500.0,
}

#: Rule → severity, declared once. This is the severity mapping: a finding cannot
#: carry a severity the rule did not name here, and a new rule must declare one.
RULE_SEVERITY: dict[str, str] = {
    "coverage_drop": "warn",
    "nav_residual": "warn",
    "holdings_jump": "warn",
    "top10_jump": "warn",
    "as_of_regression": "blocker",
    "filed_before_asof": "blocker",
    "fund_disappeared": "warn",
    "new_fund": "info",
}

#: Report order: blockers first, then the severity order the gate uses.
SEVERITY_ORDER: dict[str, int] = {"blocker": 0, "warn": 1, "info": 2}

#: The rules that need a parent document to compare against.
COMPARATIVE_RULES = ("coverage_drop", "nav_residual", "holdings_jump", "top10_jump")


class ReviewError(RuntimeError):
    """An input cannot be reviewed at all. Exit 2, never a finding."""


@dataclass(frozen=True)
class FundSnapshot:
    """The handful of numbers the rules read, taken from one fund document."""

    ticker: str
    fund_id: str
    as_of: str
    filed_at: str
    coverage_bp: int
    holdings: int
    top10_bp: int | None
    residual_bp: int

    @classmethod
    def from_document(cls, document: dict[str, Any], path: Path) -> "FundSnapshot":
        """Read a document, or refuse it: a field the rules need is not optional.

        A document missing ``coverage_pct`` is a broken release, and a review that
        silently skipped it would report "clean" about a file it never read. That
        is the failure this stage exists to prevent, so it exits 2 and names the
        file instead.
        """
        ticker = document.get("ticker")
        if not ticker:
            raise ReviewError(f"{path}: no ticker")
        coverage = document.get("coverage_pct")
        if not isinstance(coverage, (int, float)):
            raise ReviewError(f"{path}: coverage_pct {coverage!r} is not a number")
        rows = document.get("holdings")
        if not isinstance(rows, list):
            raise ReviewError(f"{path}: holdings {rows!r} is not a list")
        total_bp = 0
        for row in rows:
            weight = row.get("weight_bp") if isinstance(row, dict) else None
            if not isinstance(weight, int):
                raise ReviewError(f"{path}: weight_bp {weight!r} is not an integer")
            total_bp += weight
        metrics = document.get("metrics") or {}
        top10 = metrics.get("top10_pct") if isinstance(metrics, dict) else None
        return cls(
            ticker=str(ticker),
            # The join key is ``fund_id``: a ticker can be reassigned between funds,
            # a series id cannot. Falling back to the ticker keeps a malformed
            # document visible instead of merging it into another fund's history.
            fund_id=str(document.get("fund_id") or ticker),
            as_of=str(document.get("as_of") or ""),
            filed_at=str(document.get("filed_at") or ""),
            coverage_bp=round(coverage * 100),
            holdings=len(rows),
            top10_bp=round(top10 * 100) if isinstance(top10, (int, float)) else None,
            residual_bp=total_bp - BP_PER_UNIT,
        )


@dataclass
class Report:
    """One review run: the findings, the counts, and where they came from."""

    release: str
    parent: str | None
    generated_utc: str
    funds: int
    parent_funds: int | None
    findings: list[dict[str, Any]] = field(default_factory=list)
    counts: dict[str, int] = field(default_factory=dict)
    rules: dict[str, int] = field(default_factory=dict)

    def document(self) -> dict[str, Any]:
        """The ``--json`` payload. ``rules`` lists every rule, zeros included, so a
        consumer can read a count without checking for a key that only exists on
        days the rule fired."""
        return {
            "generated_utc": self.generated_utc,
            "release": self.release,
            "parent": self.parent,
            "counts": dict(self.counts),
            "rules": dict(self.rules),
            "findings": [dict(finding) for finding in self.findings],
        }


# -- reading a release ------------------------------------------------------


def _resolve(target: Path | str) -> Path:
    """A release directory, by path or by bare id (``paths.release_dir`` rule)."""
    resolved = paths.release_dir(target)
    if resolved is None or not resolved.is_dir():
        raise ReviewError(f"{resolved or target} is not a release directory")
    return resolved


def load_funds(release_dir: Path) -> dict[str, FundSnapshot]:
    """Every fund document in a release, keyed by ``fund_id``."""
    funds_dir = release_dir / "funds"
    if not funds_dir.is_dir():
        raise ReviewError(f"{funds_dir} does not exist")
    snapshots: dict[str, FundSnapshot] = {}
    for path in sorted(funds_dir.glob("*.json")):
        try:
            document = json.loads(path.read_text())
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ReviewError(f"{path}: {error}") from error
        if not isinstance(document, dict):
            raise ReviewError(f"{path}: not a JSON object")
        snapshot = FundSnapshot.from_document(document, path)
        if snapshot.fund_id in snapshots:
            raise ReviewError(
                f"{path}: fund_id {snapshot.fund_id} already published by "
                f"{snapshots[snapshot.fund_id].ticker}"
            )
        snapshots[snapshot.fund_id] = snapshot
    if not snapshots:
        raise ReviewError(f"{funds_dir} holds no fund documents")
    return snapshots


def load_catalogue(release_dir: Path) -> dict[str, Any] | None:
    """``catalogue.json``'s fund map, or ``None`` when the release has no catalogue.

    Only rule 7 reads it, and only when there is no parent to compare against: it
    is the release's own claim about which funds it publishes, so a fund it lists
    with no document is a fund whose page would 404.
    """
    path = release_dir / "catalogue.json"
    if not path.is_file():
        return None
    try:
        document = json.loads(path.read_text())
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ReviewError(f"{path}: {error}") from error
    funds = document.get("funds") if isinstance(document, dict) else None
    return funds if isinstance(funds, dict) else {}


# -- the rules --------------------------------------------------------------


def _finding(
    snapshot: FundSnapshot,
    rule: str,
    detail: str,
    before: Any,
    after: Any,
) -> dict[str, Any]:
    return {
        "fund": snapshot.fund_id,
        "ticker": snapshot.ticker,
        "rule": rule,
        "severity": RULE_SEVERITY[rule],
        "detail": detail,
        "before": before,
        "after": after,
    }


def _parse(value: str) -> date | None:
    try:
        return date.fromisoformat(value)
    except (TypeError, ValueError):
        return None


def is_period_end(day: date) -> bool:
    """True when ``day`` ends its month: the last calendar day or last business day.

    Both spellings are real: a period ending 31 May is filed as ``2026-05-29``
    because the 31st is a Sunday, and 60 documents in ``2026-10-30.5`` say exactly
    that. Reading the rule literally would block every one of them, so the rule
    reads "no later business day exists in this month", which accepts a month-end
    that lands on a weekend and still rejects a mid-month date.
    """
    last_day = date(day.year, day.month, calendar.monthrange(day.year, day.month)[1])
    while last_day.weekday() > 4:  # Saturday/Sunday roll back to the last weekday
        last_day -= timedelta(days=1)
    return day == last_day or day.day == calendar.monthrange(day.year, day.month)[1]


def _check_coverage_drop(
    current: FundSnapshot, parent: FundSnapshot
) -> dict[str, Any] | None:
    drop = parent.coverage_bp - current.coverage_bp
    threshold = int(THRESHOLDS["coverage_drop_bp"])
    if drop <= threshold:
        return None
    return _finding(
        current,
        "coverage_drop",
        f"coverage fell {drop:,} bp ({parent.coverage_bp / 100:.1f}% → "
        f"{current.coverage_bp / 100:.1f}%), over the {threshold:,} bp threshold",
        parent.coverage_bp,
        current.coverage_bp,
    )


def _check_nav_residual(
    current: FundSnapshot, parent: FundSnapshot
) -> dict[str, Any] | None:
    band = THRESHOLDS["residual_band_bp"]
    worsen = THRESHOLDS["residual_worsen_bp"]
    before, after = parent.residual_bp, current.residual_bp
    left_band = abs(before) <= band < abs(after)
    worsened = abs(after) - abs(before) > worsen
    if not (left_band or worsened):
        return None
    reasons = []
    if left_band:
        reasons.append(f"left the ±{band:g} bp band it was inside")
    if worsened:
        reasons.append(f"worsened {abs(after) - abs(before):,} bp")
    return _finding(
        current,
        "nav_residual",
        f"residual to NAV {before:+,} bp → {after:+,} bp ({'; '.join(reasons)})",
        before,
        after,
    )


def _check_holdings_jump(
    current: FundSnapshot, parent: FundSnapshot
) -> dict[str, Any] | None:
    before, after = parent.holdings, current.holdings
    if before == 0:  # nothing to double or halve; an empty parent is its own defect
        return None
    doubled = after > before * THRESHOLDS["holdings_double_factor"]
    halved = after < before * THRESHOLDS["holdings_half_factor"]
    if not (doubled or halved):
        return None
    shape = "more than doubled" if doubled else "fell below half"
    return _finding(
        current,
        "holdings_jump",
        f"holdings {before:,} → {after:,} ({after / before:.2f}×, {shape}; "
        f"a double count or a truncated filing, not turnover)",
        before,
        after,
    )


def _check_top10_jump(
    current: FundSnapshot, parent: FundSnapshot
) -> dict[str, Any] | None:
    if parent.top10_bp is None or current.top10_bp is None:
        # No covered weight means no concentration metric. Comparing against a
        # missing number would read as 0 bp and invent a jump out of nothing.
        return None
    move = current.top10_bp - parent.top10_bp
    threshold = int(THRESHOLDS["top10_jump_bp"])
    if abs(move) <= threshold:
        return None
    return _finding(
        current,
        "top10_jump",
        f"top-10 concentration moved {move:+,} bp ({parent.top10_bp / 100:.1f}% → "
        f"{current.top10_bp / 100:.1f}%), over the {threshold:,} bp threshold",
        parent.top10_bp,
        current.top10_bp,
    )


def _check_as_of_regression(
    current: FundSnapshot, parent: FundSnapshot | None
) -> dict[str, Any] | None:
    problems = []
    day = _parse(current.as_of)
    if day is None:
        problems.append(f"as_of {current.as_of!r} is not an ISO date")
    if parent is not None:
        parent_day = _parse(parent.as_of)
        if day is not None and parent_day is not None and day < parent_day:
            problems.append(
                f"as_of {current.as_of} is older than the parent's {parent.as_of}"
            )
    if day is not None and not is_period_end(day):
        problems.append(
            f"as_of {current.as_of} is not a period end "
            "(last calendar day or last business day of a month)"
        )
    if not problems:
        return None
    return _finding(
        current,
        "as_of_regression",
        "; ".join(problems),
        parent.as_of if parent is not None else None,
        current.as_of,
    )


def _check_filed_before_as_of(current: FundSnapshot) -> dict[str, Any] | None:
    as_of = _parse(current.as_of)
    filed_at = _parse(current.filed_at)
    if as_of is None:
        return None  # rule 5 reports an unparseable ``as_of``; one finding per cause
    if filed_at is None:
        # An unparseable ``filed_at`` has no other owner, and "cannot prove it was
        # filed after the period it reports" is exactly the blocker this rule is.
        return _finding(
            current,
            "filed_before_asof",
            f"filed_at {current.filed_at!r} is not an ISO date, so it cannot be "
            f"after as_of {current.as_of}",
            None,
            current.filed_at,
        )
    if filed_at > as_of:
        return None
    return _finding(
        current,
        "filed_before_asof",
        f"filed_at {current.filed_at} is not after as_of {current.as_of}",
        current.as_of,
        current.filed_at,
    )


# -- the run ----------------------------------------------------------------


def review(
    release: Path | str,
    parent: Path | str | None = None,
    *,
    generated_utc: str | None = None,
) -> Report:
    """Compare one release against its parent and return every finding.

    ``generated_utc`` is injectable so a test (or a ``SOURCE_DATE_EPOCH`` build)
    can produce the same report twice; the CLI leaves it to the clock.
    """
    release_dir = _resolve(release)
    release_funds = load_funds(release_dir)
    parent_dir = _resolve(parent) if parent is not None else None
    parent_funds = load_funds(parent_dir) if parent_dir is not None else None

    findings: list[dict[str, Any]] = []
    for fund_id, current in release_funds.items():
        previous = parent_funds.get(fund_id) if parent_funds is not None else None
        candidates = [
            _check_filed_before_as_of(current),
            _check_as_of_regression(current, previous),
        ]
        if previous is not None:
            candidates += [
                _check_coverage_drop(current, previous),
                _check_nav_residual(current, previous),
                _check_holdings_jump(current, previous),
                _check_top10_jump(current, previous),
            ]
        findings.extend(finding for finding in candidates if finding is not None)

    if parent_funds is not None:
        for fund_id, previous in parent_funds.items():
            if fund_id in release_funds:
                continue
            findings.append(
                {
                    "fund": fund_id,
                    "ticker": previous.ticker,
                    "rule": "fund_disappeared",
                    "severity": RULE_SEVERITY["fund_disappeared"],
                    "detail": f"published in {parent_dir.name}, absent from this release",
                    "before": previous.as_of,
                    "after": None,
                }
            )
        for fund_id, current in release_funds.items():
            if fund_id in parent_funds:
                continue
            findings.append(
                {
                    "fund": fund_id,
                    "ticker": current.ticker,
                    "rule": "new_fund",
                    "severity": RULE_SEVERITY["new_fund"],
                    "detail": f"not in {parent_dir.name} (as_of {current.as_of})",
                    "before": None,
                    "after": current.as_of,
                }
            )
    else:
        catalogue = load_catalogue(release_dir)
        if catalogue is not None:
            published = {snapshot.ticker for snapshot in release_funds.values()}
            for ticker in sorted(catalogue):
                if ticker in published:
                    continue
                row = catalogue[ticker]
                findings.append(
                    {
                        "fund": ticker,  # the catalogue knows a ticker, not a series id
                        "ticker": ticker,
                        "rule": "fund_disappeared",
                        "severity": RULE_SEVERITY["fund_disappeared"],
                        "detail": "listed in catalogue.json but the release ships no "
                        f"funds/{ticker}.json",
                        "before": row[3] if isinstance(row, list) and len(row) > 3 else None,
                        "after": None,
                    }
                )

    findings.sort(
        key=lambda finding: (
            SEVERITY_ORDER[finding["severity"]],
            finding["ticker"] or "",
            finding["rule"],
        )
    )
    counts = {severity: 0 for severity in SEVERITY_ORDER}
    rules = {rule: 0 for rule in RULE_SEVERITY}
    for finding in findings:
        counts[finding["severity"]] += 1
        rules[finding["rule"]] += 1

    return Report(
        release=release_dir.name,
        parent=parent_dir.name if parent_dir is not None else None,
        generated_utc=generated_utc or utc_now_iso(),
        funds=len(release_funds),
        parent_funds=len(parent_funds) if parent_funds is not None else None,
        findings=findings,
        counts=counts,
        rules=rules,
    )


# -- the output -------------------------------------------------------------


def summarise(report: Report) -> list[str]:
    """The human summary, one line per fact: counts, then the top blockers.

    Printed on every run, including a clean one — a gate whose quiet output is
    indistinguishable from a crash is not usable in CI.
    """
    heading = f"reviewing {report.release}"
    if report.parent is not None:
        heading += f" against {report.parent}"
    else:
        heading += " (no parent)"
    lines = [heading]

    funds = f"  funds    {report.funds:,} in release"
    if report.parent_funds is not None:
        funds += f" · {report.parent_funds:,} in parent"
        funds += f" · {report.rules['new_fund']:,} new"
        funds += f" · {report.rules['fund_disappeared']:,} disappeared"
    lines.append(funds)

    lines.append(
        f"  counts   {report.counts['blocker']:,} blocker · "
        f"{report.counts['warn']:,} warn · {report.counts['info']:,} info"
    )

    fired = sorted(
        ((rule, count) for rule, count in report.rules.items() if count),
        key=lambda item: (-item[1], item[0]),
    )
    lines.append(
        "  rules    " + (" · ".join(f"{rule} {count:,}" for rule, count in fired) or "none fired")
    )

    blockers = [f for f in report.findings if f["severity"] == "blocker"]
    if not blockers:
        lines.append("  ok       no blockers")
    else:
        for finding in blockers[:10]:
            lines.append(
                f"  BLOCKER  {finding['ticker']:<8} {finding['rule']}: {finding['detail']}"
            )
        if len(blockers) > 10:
            lines.append(f"  …        {len(blockers) - 10:,} more blocker(s) in the JSON report")

    if report.parent is None:
        lines.append(
            "  note     no --parent: "
            + ", ".join(COMPARATIVE_RULES)
            + ", new_fund skipped; fund_disappeared reads catalogue.json"
        )
    return lines


def _write_json(report: Report, path: Path) -> None:
    """Write the machine report, creating the directory the workflow points at."""
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(report.document(), indent=2, ensure_ascii=False) + "\n"
    path.write_bytes(payload.encode("utf-8"))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m pipeline.review", description=__doc__)
    parser.add_argument(
        "--release",
        required=True,
        type=Path,
        help="release directory to review, e.g. artifacts/universe-c/releases/2026-10-30.5",
    )
    parser.add_argument(
        "--parent",
        type=Path,
        help="previous release to compare against; without it the release is checked "
        "against its own catalogue and only the single-document rules run",
    )
    parser.add_argument(
        "--json",
        type=Path,
        dest="json_path",
        help="write the machine-readable report here (parent directories are created)",
    )
    parser.add_argument(
        "--fail-on",
        choices=("blocker", "warn"),
        help="exit 1 when a finding at this severity or worse exists; default exit 0",
    )
    args = parser.parse_args(argv)

    try:
        report = review(args.release, args.parent)
    except ReviewError as error:
        print(f"FAIL: {error}")
        return 2

    for line in summarise(report):
        print(line)

    if args.json_path is not None:
        try:
            _write_json(report, args.json_path)
        except OSError as error:
            print(f"FAIL: {args.json_path}: {error}")
            return 2

    if args.fail_on == "blocker" and report.counts["blocker"]:
        return 1
    if args.fail_on == "warn" and (report.counts["warn"] or report.counts["blocker"]):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
