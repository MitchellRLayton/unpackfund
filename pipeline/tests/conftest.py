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
