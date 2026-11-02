"""The hand-off check: a superseded deploy lane is not a broken hand-off.

`deploy-site` runs in one concurrency group and rebuilds every page from the live pointer, so
a hand-off that fires while a newer push is deploying is *cancelled* by design — the newer run
rebuilds the same pages and the promotion did reach the site. On 2026-11-02 two merges landed
four minutes apart and the newest-run-wins rule turned that into a red `verify-live`, which is
the failure mode this file pins: a check that cries wolf on busy days gets ignored on the day
it matters. Relaxing it must not make it toothless, so "no run succeeded at all" stays red.

`scripts/verify-live.py` is a standalone script (hyphenated name, no package), so it is
imported by path and only its pure selection rule is exercised — no network, no `gh`.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "verify-live.py"


def load_script():
    spec = importlib.util.spec_from_file_location("verify_live", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run(
    run_id: int,
    created_at: str,
    *,
    event: str = "workflow_run",
    status: str = "completed",
    conclusion: str | None = "success",
):
    return {
        "id": run_id,
        "created_at": created_at,
        "event": event,
        "status": status,
        "conclusion": conclusion,
        "html_url": f"https://github.com/o/r/actions/runs/{run_id}",
    }


def test_a_cancelled_lane_with_a_later_hand_off_is_not_a_failure():
    """The 2026-11-02 shape: the hand-off was cancelled by the next merge's deploy, which won."""
    script = load_script()
    cancelled = run(41535686144, "2026-11-02T22:16:12Z", conclusion="cancelled")
    success = run(41535705507, "2026-11-02T22:16:58Z")

    picked = script.pick_handoff([cancelled, success])

    assert picked["kind"] == "handoff"
    assert picked["proof"]["id"] == 41535705507
    assert picked["newest"]["id"] == picked["proof"]["id"]
    assert picked["in_flight"] is None


def test_a_cancelled_hand_off_rescued_by_a_push_deploy_is_proven_but_named():
    """No hand-off run survived, but the site was rebuilt after the promotion — say so."""
    script = load_script()
    cancelled = run(41535686144, "2026-11-02T22:16:12Z", conclusion="cancelled")
    push = run(41535705507, "2026-11-02T22:16:58Z", event="push")

    picked = script.pick_handoff([cancelled, push])

    assert picked["kind"] == "rebuild"
    assert picked["proof"]["id"] == 41535705507


def test_a_cancelled_hand_off_alone_is_still_a_failure():
    """No success after the promotion means the site never rebuilt — report it."""
    script = load_script()
    only = run(41535686144, "2026-11-02T22:16:12Z", conclusion="cancelled")

    picked = script.pick_handoff([only])

    assert picked["proof"] is None
    assert picked["kind"] is None
    assert picked["newest"]["id"] == 41535686144
    assert picked["in_flight"] is None


def test_a_failed_hand_off_alone_is_a_failure():
    script = load_script()

    picked = script.pick_handoff([run(1, "2026-11-02T22:16:12Z", conclusion="failure")])

    assert picked["proof"] is None


def test_an_unconcluded_deploy_is_inconclusive_not_red():
    """A verifier that runs mid-deploy must not call it broken."""
    script = load_script()
    flying = run(2, "2026-11-02T22:16:12Z", status="in_progress", conclusion=None)

    picked = script.pick_handoff([flying])

    assert picked["proof"] is None
    assert picked["newest"]["id"] == 2
    assert picked["in_flight"]["id"] == 2


def test_the_newest_success_among_several_is_the_proof():
    script = load_script()
    runs = [
        run(10, "2026-11-02T22:00:00Z"),
        run(11, "2026-11-02T22:10:00Z", conclusion="cancelled"),
        run(12, "2026-11-02T22:20:00Z"),
    ]

    picked = script.pick_handoff(runs)

    assert picked["kind"] == "handoff"
    assert picked["proof"]["id"] == 12
    assert picked["newest"]["id"] == 12
