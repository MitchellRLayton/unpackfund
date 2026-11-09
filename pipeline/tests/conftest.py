"""Shared fixtures: a real-shaped filing, an offline company index, a release writer.

Nothing here touches the network. The filing fixture is synthetic but shaped like
the documents EDGAR actually serves (see ``fixtures/nport_sample.xml``), so the
suite stays runnable in CI with no ``User-Agent`` and no cache.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from pipeline import fixtures
from pipeline.companies import CompanyIndex
from pipeline.nport import NportFiling

FIXTURES = Path(__file__).parent / "fixtures"

TICKER_DOCUMENT = fixtures.TICKER_DOCUMENT
write_release = fixtures.write_release
fund_document = fixtures.sample_document


@pytest.fixture
def filing() -> NportFiling:
    return fixtures.sample_filing()


@pytest.fixture
def index() -> CompanyIndex:
    return fixtures.sample_index()


@pytest.fixture
def vector(filing: NportFiling, index: CompanyIndex):
    from pipeline import weights

    return weights.build_vector(filing.holdings, index, filing.net_assets, lag_days=59)


@pytest.fixture
def document(vector) -> dict:
    return fund_document()


def corrupt_release(root: Path, document: dict, mutate) -> Path:
    """Write a release, then apply ``mutate`` and repair the manifest hash.

    Isolating one defect this way is the point: the validator's hash check would
    otherwise fire first and every tampering test would pass for the same wrong
    reason, proving nothing about the check each one names.
    """
    import hashlib

    release_dir = write_release(root, [document])
    fund_path = next((release_dir / "funds").glob("*.json"))
    mutate(document)
    payload = fixtures.artifact.canonical_bytes(document)
    fund_path.write_bytes(payload)
    manifest_path = release_dir / "manifest.json"
    manifest_document = json.loads(manifest_path.read_text())
    for entry in manifest_document["files"]:
        entry["bytes"] = len(payload)
        entry["sha256"] = hashlib.sha256(payload).hexdigest()
    manifest_path.write_text(json.dumps(manifest_document, indent=2) + "\n")
    return release_dir




# ---------------------------------------------------------------------------
# No unregistered skips.
#
# Eleven tests can only run against data a developer machine has and CI does not:
# the mirrored live release (`pnpm pages:mirror`, ~2.3 MB, deliberately not
# committed) and one built release under `artifacts/`. Those may skip, and only
# those, and only with a reason registered below. Any other skip stops the run —
# whatever mechanism produced it: a `skipif` mark (bool or string condition), an
# unconditional `skip` mark, `pytest.importorskip`, or a bare `pytest.skip` inside a
# test body.
#
# Why this exists: the required `checks` job reported "1369 passed, 11 skipped"
# while a local run reported "1379 passed, 1 skipped", and nothing recorded which
# eleven they were or why (task T-0003). The first version of this hook only
# inspected decidable `skipif` marks, so `importorskip` and `pytest.skip` still
# exited 0 — caught in review, fixed here by also failing the session on any
# observed skip whose reason is not registered.
# ---------------------------------------------------------------------------

SKIP_ALLOWLIST = (
    "mirrored release not present at ",
    "no built release on this machine",
)


def _allowed(reason: str) -> bool:
    """A reason must *begin* with a registered phrase — containing one is not enough."""
    return any(reason.startswith(prefix) for prefix in SKIP_ALLOWLIST)


def _registered() -> str:
    return " | ".join(repr(prefix) for prefix in SKIP_ALLOWLIST)


def _reason_text(report) -> str:
    """The skip reason as the marker wrote it, without pytest's own decoration."""
    reason = report.longrepr
    if isinstance(reason, tuple) and len(reason) == 3:
        reason = reason[2]
    text = " ".join(str(reason).split())
    for prefix in ("Skipped: ", "skipped: "):
        if text.startswith(prefix):
            text = text[len(prefix):]
    return text.strip()


def pytest_collection_modifyitems(config, items):
    """Stop before the run when a mark can never be satisfied for an unregistered reason."""
    for item in items:
        marks = list(item.iter_markers(name="skipif")) + list(item.iter_markers(name="skip"))
        for mark in marks:
            condition = True
            if mark.name == "skipif":
                if not mark.args:
                    continue
                condition = mark.args[0]
                if isinstance(condition, str):
                    continue  # pytest evaluates the expression; the session-end check covers it
                condition = bool(condition)
            reason = mark.kwargs.get("reason") or (mark.args[1] if len(mark.args) > 1 else "")
            if condition and not _allowed(str(reason)):
                raise pytest.UsageError(
                    f"{item.nodeid} would skip for an unregistered reason: {str(reason)!r}. "
                    f"Registered reasons begin with: {_registered()}. Add a new one to "
                    "SKIP_ALLOWLIST in tests/conftest.py deliberately, with a comment saying "
                    "what data it needs and why the gate cannot have it."
                )


def pytest_sessionfinish(session, exitstatus):
    """Fail the session when anything skipped for an unregistered reason at runtime.

    This is the half a collection-time hook cannot see: `pytest.skip()`,
    `pytest.importorskip()` and string `skipif` conditions only decide during the run.
    """
    offenders = [
        (report.nodeid, _reason_text(report))
        for report in (session.config.pluginmanager.get_plugin("terminalreporter").stats.get("skipped") or [])
        if not _allowed(_reason_text(report))
    ]
    if not offenders:
        return
    reporter = session.config.pluginmanager.get_plugin("terminalreporter")
    if reporter is not None:
        reporter.section("unregistered skips (the gate is smaller than it looks)")
        for nodeid, reason in offenders:
            reporter.write_line(f"  {nodeid}\n    {reason}")
        reporter.write_line(f"  registered reasons begin with: {_registered()}")
    session.exitstatus = 1


def pytest_terminal_summary(terminalreporter):
    """Print every skip taken, by name: anonymous `s` characters prove nothing."""
    skipped = terminalreporter.stats.get("skipped") or []
    if not skipped:
        return
    terminalreporter.section("registered skips (data this gate cannot have)")
    for report in skipped:
        terminalreporter.write_line(f"  {report.nodeid}\n    {_reason_text(report)}")
