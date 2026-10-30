"""The review stage: fixed rules a release must pass before it is promoted.

Each test here is a rule's *contract*, not its implementation: a clean pair must
produce nothing, one changed number must produce exactly one named finding, and the
gate must fail on the severities it says it fails on. The negative cases carry the
weight — a rule that fires on an unchanged fund trains the operator to ignore the
report, and a gate that cannot pass a clean release protects nothing — so the
clean-pair and threshold-boundary tests are the ones that matter most.

Offline: every fixture is written by ``conftest.write_release`` from the synthetic
filing, so nothing here touches EDGAR or a clock (``generated_utc`` is injected
where determinism is asserted).
"""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import pytest

from pipeline import review

from .conftest import fund_document, write_release

PARENT_ID = "2026-10-30.4"
RELEASE_ID = "2026-10-30.5"


# -- fixtures ---------------------------------------------------------------


def _document(**overrides) -> dict:
    """The synthetic fund document with fields replaced, not mutated in place."""
    document = fund_document()
    document.update(overrides)
    return document


def _weights(total_bp: int, count: int = 4) -> list[dict]:
    """A weight vector that sums to exactly ``total_bp``, so a residual is a choice."""
    base, extra = divmod(total_bp, count)
    return [
        {
            "company_id": f"c_{index:010d}",
            "name": f"HOLDING {index}",
            "ticker": None,
            "asset_cat": "equity",
            "weight_bp": base + (1 if index < extra else 0),
        }
        for index in range(count)
    ]


def _metrics(top10_pct: float | None = 84.4) -> dict:
    return {"hhi": 0.24, "hhi_pct2": 2400.0, "effective_n": 4.16, "top10_pct": top10_pct}


def _pair(
    tmp_path: Path,
    parent: dict | None = None,
    release: dict | None = None,
) -> tuple[Path, Path]:
    """Two releases of one fund: the parent first, the release second."""
    parent_dir = write_release(
        tmp_path, [_document(**(parent or {}))], release_id=PARENT_ID
    )
    release_dir = write_release(
        tmp_path, [_document(**(release or {}))], release_id=RELEASE_ID
    )
    return release_dir, parent_dir


def _rules(release: Path, parent: Path | None = None) -> list[str]:
    return [finding["rule"] for finding in review.review(release, parent).findings]


# -- the important negative case -------------------------------------------


def test_unchanged_fund_produces_no_findings(tmp_path):
    """The whole report is worthless if an identical pair is noisy."""
    release_dir, parent_dir = _pair(tmp_path)
    report = review.review(release_dir, parent_dir)
    assert report.findings == []
    assert report.counts == {"blocker": 0, "warn": 0, "info": 0}
    assert report.rules == {rule: 0 for rule in review.RULE_SEVERITY}
    assert report.funds == 1 and report.parent_funds == 1


@pytest.mark.parametrize("rule", sorted(review.RULE_SEVERITY))
def test_every_rule_stays_quiet_on_a_clean_pair(tmp_path, rule):
    release_dir, parent_dir = _pair(tmp_path)
    assert rule not in _rules(release_dir, parent_dir)


def test_unchanged_fund_passes_the_strict_gate(tmp_path):
    release_dir, parent_dir = _pair(tmp_path)
    code = review.main(
        ["--release", str(release_dir), "--parent", str(parent_dir), "--fail-on", "warn"]
    )
    assert code == 0


# -- 1. coverage_drop -------------------------------------------------------


def test_coverage_drop_fires_past_the_threshold(tmp_path):
    release_dir, parent_dir = _pair(
        tmp_path, {"coverage_pct": 90.0}, {"coverage_pct": 75.0}
    )
    findings = review.review(release_dir, parent_dir).findings
    assert [finding["rule"] for finding in findings] == ["coverage_drop"]
    finding = findings[0]
    assert finding["severity"] == "warn"
    # before/after are the values the rule compared, in the threshold's unit (bp).
    assert (finding["before"], finding["after"]) == (9_000, 7_500)
    assert "1,500 bp" in finding["detail"]


def test_coverage_drop_is_quiet_at_the_threshold(tmp_path):
    """``more than 1,000 bp`` means 1,000 exactly is a pass, not a rounding coin flip."""
    release_dir, parent_dir = _pair(
        tmp_path, {"coverage_pct": 90.0}, {"coverage_pct": 80.0}
    )
    assert _rules(release_dir, parent_dir) == []


# -- 2. nav_residual --------------------------------------------------------


def test_nav_residual_fires_when_it_leaves_the_band(tmp_path):
    release_dir, parent_dir = _pair(
        tmp_path,
        {"holdings": _weights(10_150)},  # +150 bp, inside the ±200 band
        {"holdings": _weights(10_400)},  # +400 bp, outside it
    )
    findings = review.review(release_dir, parent_dir).findings
    assert [finding["rule"] for finding in findings] == ["nav_residual"]
    assert (findings[0]["before"], findings[0]["after"]) == (150, 400)
    assert "left the ±200 bp band" in findings[0]["detail"]


def test_nav_residual_fires_when_it_worsens_outside_the_band(tmp_path):
    """A residual already outside the band still fires if it gets 300 bp worse."""
    release_dir, parent_dir = _pair(
        tmp_path,
        {"holdings": _weights(10_450)},  # +450 bp, already outside
        {"holdings": _weights(10_800)},  # +800 bp, 350 bp worse
    )
    findings = review.review(release_dir, parent_dir).findings
    assert [finding["rule"] for finding in findings] == ["nav_residual"]
    assert "worsened 350 bp" in findings[0]["detail"]


def test_nav_residual_is_quiet_when_it_stays_inside_the_band(tmp_path):
    release_dir, parent_dir = _pair(
        tmp_path, {"holdings": _weights(10_150)}, {"holdings": _weights(10_180)}
    )
    assert _rules(release_dir, parent_dir) == []


def test_nav_residual_is_quiet_when_it_improves_outside_the_band(tmp_path):
    """Sign is not a defect: coming back toward NAV must never warn."""
    release_dir, parent_dir = _pair(
        tmp_path, {"holdings": _weights(9_600)}, {"holdings": _weights(9_900)}
    )
    assert _rules(release_dir, parent_dir) == []


# -- 3. holdings_jump -------------------------------------------------------


def test_holdings_jump_fires_when_the_count_doubles(tmp_path):
    release_dir, parent_dir = _pair(
        tmp_path, {"holdings": _weights(10_000, 4)}, {"holdings": _weights(10_000, 10)}
    )
    findings = review.review(release_dir, parent_dir).findings
    assert [finding["rule"] for finding in findings] == ["holdings_jump"]
    assert (findings[0]["before"], findings[0]["after"]) == (4, 10)
    assert "more than doubled" in findings[0]["detail"]


def test_holdings_jump_fires_when_the_count_halves(tmp_path):
    release_dir, parent_dir = _pair(
        tmp_path, {"holdings": _weights(10_000, 10)}, {"holdings": _weights(10_000, 4)}
    )
    findings = review.review(release_dir, parent_dir).findings
    assert [finding["rule"] for finding in findings] == ["holdings_jump"]
    assert "fell below half" in findings[0]["detail"]


def test_holdings_jump_is_quiet_at_exactly_double(tmp_path):
    release_dir, parent_dir = _pair(
        tmp_path, {"holdings": _weights(10_000, 4)}, {"holdings": _weights(10_000, 8)}
    )
    assert _rules(release_dir, parent_dir) == []


# -- 4. top10_jump ----------------------------------------------------------


def test_top10_jump_fires_past_the_threshold(tmp_path):
    release_dir, parent_dir = _pair(
        tmp_path, {"metrics": _metrics(20.0)}, {"metrics": _metrics(38.0)}
    )
    findings = review.review(release_dir, parent_dir).findings
    assert [finding["rule"] for finding in findings] == ["top10_jump"]
    assert (findings[0]["before"], findings[0]["after"]) == (2_000, 3_800)


def test_top10_jump_is_quiet_at_the_threshold(tmp_path):
    release_dir, parent_dir = _pair(
        tmp_path, {"metrics": _metrics(20.0)}, {"metrics": _metrics(35.0)}
    )
    assert _rules(release_dir, parent_dir) == []


def test_top10_jump_is_skipped_when_the_metric_is_absent(tmp_path):
    """No covered weight means no concentration number — not a jump from zero."""
    release_dir, parent_dir = _pair(
        tmp_path, {"metrics": _metrics(None)}, {"metrics": _metrics(None)}
    )
    assert _rules(release_dir, parent_dir) == []


# -- 5. as_of_regression ----------------------------------------------------


def test_as_of_regression_fires_when_the_report_date_goes_backwards(tmp_path):
    release_dir, parent_dir = _pair(
        tmp_path, {"as_of": "2026-06-30"}, {"as_of": "2026-05-31"}
    )
    findings = review.review(release_dir, parent_dir).findings
    assert [finding["rule"] for finding in findings] == ["as_of_regression"]
    assert findings[0]["severity"] == "blocker"
    assert "older than the parent's" in findings[0]["detail"]


def test_as_of_regression_fires_on_a_mid_month_report_date(tmp_path):
    release_dir, parent_dir = _pair(
        tmp_path, {"as_of": "2026-05-31"}, {"as_of": "2026-06-15"}
    )
    findings = review.review(release_dir, parent_dir).findings
    assert [finding["rule"] for finding in findings] == ["as_of_regression"]
    assert "not a period end" in findings[0]["detail"]


def test_as_of_regression_accepts_the_last_business_day_of_a_month(tmp_path):
    """60 real documents report a 31 May month end as 2026-05-29; that is a pass.

    A literal "last calendar day" reading would block a clean release on every
    weekend-ending period, which is why the rule accepts both spellings.
    """
    release_dir, parent_dir = _pair(
        tmp_path, {"as_of": "2026-05-29"}, {"as_of": "2026-06-30"}
    )
    assert _rules(release_dir, parent_dir) == []


@pytest.mark.parametrize(
    ("day", "period_end"),
    [
        (date(2026, 6, 30), True),  # last calendar day, a Tuesday
        (date(2026, 5, 31), True),  # last calendar day, a Sunday
        (date(2026, 5, 29), True),  # last business day of May 2026
        (date(2026, 2, 27), True),  # last business day of Feb 2026
        (date(2026, 2, 28), True),  # last calendar day, a Saturday
        (date(2026, 6, 15), False),  # mid-month
        (date(2026, 5, 28), False),  # a weekday, but not the month's last
        (date(2026, 2, 26), False),
    ],
)
def test_is_period_end(day, period_end):
    assert review.is_period_end(day) is period_end


# -- 6. filed_before_asof ---------------------------------------------------


def test_filed_before_asof_fires_when_filed_on_the_report_date(tmp_path):
    release_dir, parent_dir = _pair(tmp_path, {}, {"filed_at": "2026-06-30"})
    findings = review.review(release_dir, parent_dir).findings
    assert [finding["rule"] for finding in findings] == ["filed_before_asof"]
    assert findings[0]["severity"] == "blocker"


def test_filed_before_asof_fires_on_an_unparseable_filing_date(tmp_path):
    release_dir, parent_dir = _pair(tmp_path, {}, {"filed_at": "28 Aug 2026"})
    findings = review.review(release_dir, parent_dir).findings
    assert [finding["rule"] for finding in findings] == ["filed_before_asof"]
    assert "not an ISO date" in findings[0]["detail"]


# -- 7. fund_disappeared / 8. new_fund --------------------------------------


def test_disappeared_and_new_funds_are_reported_against_the_parent(tmp_path):
    parent_dir = write_release(
        tmp_path,
        [_document(ticker="GONE", fund_id="S000000002")],
        release_id=PARENT_ID,
    )
    release_dir = write_release(
        tmp_path,
        [_document(ticker="TEST", fund_id="S000000001")],
        release_id=RELEASE_ID,
    )
    findings = review.review(release_dir, parent_dir).findings
    assert {(finding["rule"], finding["ticker"]) for finding in findings} == {
        ("fund_disappeared", "GONE"),
        ("new_fund", "TEST"),
    }
    severities = {finding["rule"]: finding["severity"] for finding in findings}
    assert severities == {"fund_disappeared": "warn", "new_fund": "info"}
    # The warn sorts before the info: a reader sees the loss before the gain.
    assert [finding["rule"] for finding in findings] == ["fund_disappeared", "new_fund"]


def test_a_growing_release_reports_only_new_funds(tmp_path):
    """Widening the universe is the expected direction: info, never a warn."""
    parent_dir = write_release(
        tmp_path, [_document(ticker="TEST", fund_id="S000000001")], release_id=PARENT_ID
    )
    release_dir = write_release(
        tmp_path,
        [
            _document(ticker="TEST", fund_id="S000000001"),
            _document(ticker="WIDER", fund_id="S000000002"),
        ],
        release_id=RELEASE_ID,
    )
    report = review.review(release_dir, parent_dir)
    assert report.counts == {"blocker": 0, "warn": 0, "info": 1}
    assert report.rules["new_fund"] == 1


# -- without --parent -------------------------------------------------------


def test_without_a_parent_a_catalogue_entry_with_no_document_is_a_loss(tmp_path):
    release_dir = write_release(
        tmp_path,
        [
            _document(ticker="TEST", fund_id="S000000001"),
            _document(ticker="GONE", fund_id="S000000002"),
        ],
        release_id=RELEASE_ID,
    )
    (release_dir / "funds" / "GONE.json").unlink()
    findings = review.review(release_dir).findings
    assert [finding["rule"] for finding in findings] == ["fund_disappeared"]
    assert findings[0]["ticker"] == "GONE"
    assert findings[0]["detail"] == (
        "listed in catalogue.json but the release ships no funds/GONE.json"
    )


def test_without_a_parent_only_the_single_document_rules_run(tmp_path):
    """Rules 1–4 and 8 need a second document; 5 keeps its period-end half, 6 runs."""
    release_dir = write_release(
        tmp_path,
        [_document(coverage_pct=12.0, holdings=_weights(10_000, 40))],
        release_id=RELEASE_ID,
    )
    report = review.review(release_dir)
    assert report.parent is None
    assert report.findings == []
    for skipped in (*review.COMPARATIVE_RULES, "new_fund"):
        assert report.rules[skipped] == 0


def test_without_a_parent_the_intrinsic_blockers_still_fire(tmp_path):
    release_dir = write_release(
        tmp_path, [_document(as_of="2026-06-15")], release_id=RELEASE_ID
    )
    report = review.review(release_dir)
    assert [finding["rule"] for finding in report.findings] == ["as_of_regression"]
    assert report.counts["blocker"] == 1


def test_without_a_parent_the_summary_says_what_was_skipped(tmp_path, capsys):
    release_dir = write_release(tmp_path, [_document()], release_id=RELEASE_ID)
    assert review.main(["--release", str(release_dir)]) == 0
    output = capsys.readouterr().out
    assert "no --parent" in output
    assert "new_fund skipped" in output


# -- severity mapping -------------------------------------------------------


def test_severity_is_declared_once_per_rule():
    assert review.RULE_SEVERITY == {
        "coverage_drop": "warn",
        "nav_residual": "warn",
        "holdings_jump": "warn",
        "top10_jump": "warn",
        "as_of_regression": "blocker",
        "filed_before_asof": "blocker",
        "fund_disappeared": "warn",
        "new_fund": "info",
    }
    assert set(review.SEVERITY_ORDER) == {"blocker", "warn", "info"}


def test_every_finding_carries_its_rules_severity(tmp_path):
    parent_dir = write_release(
        tmp_path,
        [_document(ticker="GONE", fund_id="S000000002", as_of="2026-06-15")],
        release_id=PARENT_ID,
    )
    release_dir = write_release(
        tmp_path,
        [_document(ticker="TEST", fund_id="S000000001", as_of="2026-06-15")],
        release_id=RELEASE_ID,
    )
    findings = review.review(release_dir, parent_dir).findings
    assert findings, "expected the seeded blockers to fire"
    for finding in findings:
        assert finding["severity"] == review.RULE_SEVERITY[finding["rule"]]
        assert finding["ticker"] and finding["fund"]


# -- thresholds are live ----------------------------------------------------


def test_thresholds_are_read_from_the_one_dict(tmp_path, monkeypatch):
    """A threshold in ``THRESHOLDS`` is the only place to tune it."""
    release_dir, parent_dir = _pair(
        tmp_path, {"coverage_pct": 90.0}, {"coverage_pct": 75.0}
    )
    assert _rules(release_dir, parent_dir) == ["coverage_drop"]
    monkeypatch.setitem(review.THRESHOLDS, "coverage_drop_bp", 5_000)
    assert _rules(release_dir, parent_dir) == []


def test_thresholds_name_their_units():
    assert set(review.THRESHOLDS) == {
        "coverage_drop_bp",
        "residual_band_bp",
        "residual_worsen_bp",
        "holdings_double_factor",
        "holdings_half_factor",
        "top10_jump_bp",
    }


# -- the gate ---------------------------------------------------------------


def _release_with(tmp_path: Path, **overrides) -> Path:
    return write_release(tmp_path, [_document(**overrides)], release_id=RELEASE_ID)


@pytest.mark.parametrize(
    ("overrides", "fail_on", "expected"),
    [
        ({}, None, 0),
        ({}, "blocker", 0),
        ({}, "warn", 0),
        ({"filed_at": "2026-06-30"}, None, 0),  # a blocker does not fail by default
        ({"filed_at": "2026-06-30"}, "blocker", 1),
        ({"filed_at": "2026-06-30"}, "warn", 1),
        ({"as_of": "2026-06-15"}, "blocker", 1),  # a period-end blocker alone
    ],
)
def test_fail_on_exit_codes(tmp_path, overrides, fail_on, expected):
    release_dir = _release_with(tmp_path, **overrides)
    argv = ["--release", str(release_dir)]
    if fail_on is not None:
        argv += ["--fail-on", fail_on]
    assert review.main(argv) == expected


def test_fail_on_warn_fails_a_catalogue_loss_without_a_parent(tmp_path):
    """The one warn that survives the no-parent degradation is still a warn."""
    release_dir = write_release(
        tmp_path,
        [
            _document(ticker="TEST", fund_id="S000000001"),
            _document(ticker="GONE", fund_id="S000000002"),
        ],
        release_id=RELEASE_ID,
    )
    (release_dir / "funds" / "GONE.json").unlink()
    assert review.main(["--release", str(release_dir)]) == 0
    assert review.main(["--release", str(release_dir), "--fail-on", "blocker"]) == 0
    assert review.main(["--release", str(release_dir), "--fail-on", "warn"]) == 1


def test_fail_on_warn_fails_a_warning(tmp_path):
    release_dir, parent_dir = _pair(
        tmp_path, {"coverage_pct": 90.0}, {"coverage_pct": 75.0}
    )
    assert review.main(
        ["--release", str(release_dir), "--parent", str(parent_dir), "--fail-on", "blocker"]
    ) == 0
    assert review.main(
        ["--release", str(release_dir), "--parent", str(parent_dir), "--fail-on", "warn"]
    ) == 1


def test_an_info_finding_does_not_fail_the_warn_gate(tmp_path):
    parent_dir = write_release(
        tmp_path, [_document(ticker="TEST", fund_id="S000000001")], release_id=PARENT_ID
    )
    release_dir = write_release(
        tmp_path,
        [
            _document(ticker="TEST", fund_id="S000000001"),
            _document(ticker="WIDER", fund_id="S000000002"),
        ],
        release_id=RELEASE_ID,
    )
    assert review.main(
        ["--release", str(release_dir), "--parent", str(parent_dir), "--fail-on", "warn"]
    ) == 0


def test_missing_release_is_exit_2(tmp_path):
    assert review.main(["--release", str(tmp_path / "nope")]) == 2


def test_missing_parent_is_exit_2(tmp_path):
    release_dir = _release_with(tmp_path)
    assert review.main(
        ["--release", str(release_dir), "--parent", str(tmp_path / "nope")]
    ) == 2


def test_malformed_document_is_exit_2_not_a_finding(tmp_path):
    """A document the rules cannot read must stop the run, not be skipped quietly."""
    release_dir = _release_with(tmp_path)
    (release_dir / "funds" / "TEST.json").write_text("{not json")
    assert review.main(["--release", str(release_dir)]) == 2


def test_a_document_missing_a_reviewed_field_is_exit_2(tmp_path):
    release_dir = _release_with(tmp_path)
    path = release_dir / "funds" / "TEST.json"
    document = json.loads(path.read_text())
    del document["coverage_pct"]
    path.write_text(json.dumps(document))
    assert review.main(["--release", str(release_dir)]) == 2


# -- the report -------------------------------------------------------------


def test_json_report_shape(tmp_path):
    release_dir, parent_dir = _pair(
        tmp_path,
        {"coverage_pct": 90.0},
        {"coverage_pct": 75.0, "ticker": "TEST", "fund_id": "S000000001"},
    )
    out = tmp_path / "reports" / "2026-10-30.5.json"
    code = review.main(
        [
            "--release",
            str(release_dir),
            "--parent",
            str(parent_dir),
            "--json",
            str(out),
        ]
    )
    assert code == 0
    assert out.is_file()
    assert out.read_bytes().endswith(b"\n")
    document = json.loads(out.read_text())
    assert list(document) == [
        "generated_utc",
        "release",
        "parent",
        "counts",
        "rules",
        "findings",
    ]
    assert document["release"] == RELEASE_ID
    assert document["parent"] == PARENT_ID
    assert document["generated_utc"].endswith("Z")
    assert document["counts"] == {"blocker": 0, "warn": 1, "info": 0}
    assert document["rules"] == {**{rule: 0 for rule in review.RULE_SEVERITY}, "coverage_drop": 1}
    assert len(document["findings"]) == 1
    finding = document["findings"][0]
    assert list(finding) == [
        "fund",
        "ticker",
        "rule",
        "severity",
        "detail",
        "before",
        "after",
    ]
    assert finding["fund"] == "S000000001"
    assert finding["ticker"] == "TEST"


def test_findings_are_sorted_by_severity_then_ticker(tmp_path):
    parent_dir = write_release(
        tmp_path,
        [
            _document(ticker="GONE", fund_id="S000000002"),
            _document(ticker="AAA", fund_id="S000000003"),
        ],
        release_id=PARENT_ID,
    )
    release_dir = write_release(
        tmp_path,
        [
            _document(ticker="ZZZ", fund_id="S000000001", filed_at="2026-06-30"),
            _document(ticker="BBB", fund_id="S000000004", filed_at="2026-06-30"),
        ],
        release_id=RELEASE_ID,
    )
    findings = review.review(release_dir, parent_dir).findings
    assert [(finding["severity"], finding["ticker"]) for finding in findings] == [
        ("blocker", "BBB"),
        ("blocker", "ZZZ"),
        ("warn", "AAA"),
        ("warn", "GONE"),
        ("info", "BBB"),
        ("info", "ZZZ"),
    ]


def test_the_same_report_twice_is_byte_identical(tmp_path):
    release_dir, parent_dir = _pair(
        tmp_path, {"coverage_pct": 90.0}, {"coverage_pct": 75.0}
    )
    first = review.review(
        release_dir, parent_dir, generated_utc="2026-10-30T00:00:00Z"
    ).document()
    second = review.review(
        release_dir, parent_dir, generated_utc="2026-10-30T00:00:00Z"
    ).document()
    assert first == second


# -- the human summary ------------------------------------------------------


def test_summary_always_states_the_counts_and_the_blockers(tmp_path, capsys):
    release_dir, parent_dir = _pair(
        tmp_path, {"filed_at": "2026-08-28"}, {"filed_at": "2026-06-30"}
    )
    assert review.main(["--release", str(release_dir), "--parent", str(parent_dir)]) == 0
    output = capsys.readouterr().out
    assert f"reviewing {RELEASE_ID} against {PARENT_ID}" in output
    assert "0 blocker" not in output  # the seeded blocker is the one that fired
    assert "1 blocker" in output
    assert "filed_before_asof" in output
    assert "TEST" in output


def test_summary_of_a_clean_run_says_so(tmp_path, capsys):
    release_dir, parent_dir = _pair(tmp_path)
    assert review.main(["--release", str(release_dir), "--parent", str(parent_dir)]) == 0
    output = capsys.readouterr().out
    assert "no blockers" in output
    assert "rules    none fired" in output
