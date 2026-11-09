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
# No silent skips.
#
# Twelve tests in this suite can only run against data a developer machine has and
# CI does not: the mirrored live release (`pnpm pages:mirror`, ~2.3 MB, deliberately
# not committed) and one built release under `artifacts/`. Those may skip, and only
# those, and only with a reason string registered below. Any other skip — a later
# `skipif`, `importorskip` or `pytest.skip` — stops the run instead of quietly
# shrinking what the gate proves.
#
# Why this exists: the required `checks` job reported "1369 passed, 11 skipped"
# while a local run reported "1379 passed, 1 skipped", and nothing recorded which
# eleven they were or why (task T-0003).
# ---------------------------------------------------------------------------

SKIP_ALLOWLIST = (
    "mirrored release not present at",
    "no built release on this machine",
)

#: Skips actually taken this session, as (nodeid, reason), for the summary below.
_OBSERVED_SKIPS: list[tuple[str, str]] = []


def _allowed(reason: str) -> bool:
    return any(allowed in reason for allowed in SKIP_ALLOWLIST)


def _skip_condition(mark) -> tuple[bool, str] | None:
    """The mark's condition as a bool, plus its reason; None when it is not decidable here."""
    if not mark.args:
        return None
    condition = mark.args[0]
    if isinstance(condition, str):
        return None  # pytest evaluates string conditions itself
    reason = mark.kwargs.get("reason") or (mark.args[1] if len(mark.args) > 1 else "")
    return bool(condition), str(reason)


def pytest_collection_modifyitems(config, items):
    """Refuse a skip whose reason is not registered: a silent skip is a hole in the gate."""
    for item in items:
        for mark in item.iter_markers(name="skipif"):
            decided = _skip_condition(mark)
            if decided is None:
                continue
            condition, reason = decided
            if condition and not _allowed(reason):
                raise pytest.UsageError(
                    f"{item.nodeid} would skip for an unregistered reason: {reason!r}. "
                    "Register it in tests/conftest.py SKIP_ALLOWLIST deliberately, with a "
                    "comment saying what data it needs and why the gate cannot have it."
                )


def pytest_runtest_logreport(report):
    """Remember every skip taken, so the terminal summary can name them."""
    if report.skipped and report.when in {"setup", "call"}:
        reason = report.longrepr
        if isinstance(reason, tuple) and len(reason) == 3:
            reason = reason[2]
        _OBSERVED_SKIPS.append((report.nodeid, str(reason).strip().splitlines()[0]))


def pytest_terminal_summary(terminalreporter):
    """Print the skips by name: eleven anonymous `s` characters prove nothing."""
    _OBSERVED_SKIPS.clear()
    skipped = terminalreporter.stats.get("skipped") or []
    if not skipped:
        return
    terminalreporter.section("registered skips (data this gate cannot have)")
    for report in skipped:
        reason = report.longrepr
        if isinstance(reason, tuple) and len(reason) == 3:
            reason = reason[2]
        terminalreporter.write_line(f"  {report.nodeid}\n    {str(reason).strip().splitlines()[0]}")
