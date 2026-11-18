"""The free tier is a cliff, so the gate is arithmetic with a test, not a sentence in a doc.

Measured on 2026-11-10 (docs/08-operations/2026-11-10-cloudflare-free-tier-usage.md): the
bucket held 16.33 GB against a 10 GB-month allowance while the prune printed a refusal into
a green job. These tests pin the two properties that make the upload gate different from that
step: a release over the line is *refused* (not warned about), and the ceilings have exactly
one definition — `retention` imports them, it does not restate them.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from pipeline import cost_ceilings as cc
from pipeline import retention


GB = 1_000_000_000

#: A real wide release: 22,357 objects / 0.7 GB (2026-11-10 measurement).
WIDE_OBJECTS = 22_357
WIDE_BYTES = 700 * 1_000_000


def test_wide_release_passes_with_the_documented_headroom():
    ceilings = cc.guard_release(objects=WIDE_OBJECTS, bytes=WIDE_BYTES, release_id="2026-11-10.1")
    verdicts = {ceiling.resource: ceiling.verdict for ceiling in ceilings}
    assert verdicts["R2 Class A ops for one release"] == "ok"  # 22,357 of 33,333 = 67 %
    assert all(ceiling.verdict != "OVER" for ceiling in ceilings)


def test_a_release_over_the_class_a_budget_is_refused_not_warned():
    over = cc.MAX_RELEASE_OBJECTS + 1
    with pytest.raises(cc.CostCeilingError) as error:
        cc.guard_release(objects=over, bytes=WIDE_BYTES)
    assert "REFUSED" in str(error.value)
    assert f"{over:,}" in str(error.value)


def test_a_release_that_would_not_fit_the_steady_state_is_refused():
    # Just over one third of 75 % of 10 GB cannot coexist with two more releases.
    with pytest.raises(cc.CostCeilingError):
        cc.guard_release(objects=WIDE_OBJECTS, bytes=cc.MAX_RELEASE_BYTES + 1)


def test_steady_state_fits_the_headroom_budget_by_construction():
    # Against the *budget*, not the raw allowance: this test failed the independent review
    # because `3 x MAX_RELEASE_BYTES <= R2_FREE_BYTES` still held with HEADROOM = 1.0, so the
    # 75 % policy could have been deleted and the suite stayed green.
    assert cc.R2_STORAGE_BUDGET == int(cc.R2_FREE_BYTES * cc.HEADROOM)
    assert cc.MAX_RESIDENT_RELEASES * cc.MAX_RELEASE_BYTES + cc.STUB_ALLOWANCE <= cc.R2_STORAGE_BUDGET
    assert cc.HEADROOM == 0.75  # the ADR's value, not just "some headroom"
    assert cc.R2_STORAGE_BUDGET == 7_500_000_000
    # The policy's own steady state (live + staged full, four stubs) is ~1.0 GB, well inside.
    assert cc.MAX_RELEASE_BYTES >= GB


def test_retention_shares_the_definition_rather_than_restating_it():
    # `is`, not `==`: an imported name is the same object, while a local
    # `FREE_TIER_BYTES = 10 * GB` recomputes equal but distinct — the previous `==` test
    # passed on the restating code the commit claimed to have removed.
    assert retention.FREE_TIER_BYTES is cc.R2_FREE_BYTES
    assert retention.GB is cc.GB
    source = Path(retention.__file__).read_text()
    assert "FREE_TIER_BYTES = 10 * GB" not in source


def test_measured_site_is_inside_the_workers_asset_cap():
    # 9,444 files on 2026-11-10: 47 % of the 20,000-file cap, so about 2× headroom.
    (ceiling,) = cc.assess_site(files=9_444)
    assert ceiling.verdict == "ok"
    (over,) = cc.assess_site(files=cc.WORKERS_FREE_ASSET_FILES + 1)
    assert over.over


def test_near_the_ceiling_warns_before_it_refuses():
    (ceiling,) = cc.assess_site(files=int(cc.WORKERS_FREE_ASSET_FILES * cc.HEADROOM))
    assert ceiling.verdict == "near"
    assert not ceiling.over


def test_cli_refuses_an_oversized_release_directory(tmp_path, monkeypatch):
    release_dir = tmp_path / "2026-11-10.1"
    release_dir.mkdir()
    (release_dir / "manifest.json").write_bytes(b"x" * 4096)
    assert cc.main(["--release", str(release_dir)]) == 0

    # A directory over the object budget is refused. The budget is scaled down here so the
    # test does not write 33,334 files to prove a comparison that is already pure arithmetic.
    monkeypatch.setattr(cc, "MAX_RELEASE_OBJECTS", 2)
    three = tmp_path / "three"
    three.mkdir()
    for index in range(3):
        (three / f"{index}.json").write_bytes(b"")
    assert cc.main(["--release", str(three)]) == 1
    monkeypatch.setattr(cc, "MAX_RELEASE_OBJECTS", 3)
    assert cc.main(["--release", str(three)]) == 0


def test_cli_site_check_counts_files_and_refuses_an_empty_directory(tmp_path):
    site = tmp_path / "out"
    site.mkdir()
    assert cc.main(["--site", str(site)]) == 1  # cannot measure is a failure, not a pass
    for index in range(10):
        (site / f"page{index}.html").write_text("x")
    assert cc.main(["--site", str(site)]) == 0


def test_the_encoding_is_printable_without_a_measurement(capsys):
    assert cc.main([]) == 0
    out = capsys.readouterr().out
    assert "10.000 GB" in out
    assert "1,000,000" in out


def test_upload_refuses_before_a_single_put(tmp_path, monkeypatch):
    """The gate is in the spending path, and it fires before the first PutObject.

    `upload_release` is the only code that turns a release into Class A operations, so a
    refusal it makes cannot be routed around by a workflow, a wrapper script or a manual
    `pnpm release:upload`. The fake client records nothing because nothing is called.
    """
    from pipeline import release
    from tests.conftest import fund_document, write_release

    release_dir = write_release(tmp_path, [fund_document()], release_id="2026-11-18.1")
    monkeypatch.setattr(cc, "MAX_RELEASE_OBJECTS", 0)
    _assert_upload_refused(release_dir)


def test_upload_refuses_on_the_byte_line_too(tmp_path, monkeypatch):
    """The byte ceiling has to be wired into the spending path as well as the object count.

    The independent review of PR #128 found the upload test drove only the object line, so a
    release could have been refused for its count and silently accepted for its size.
    """
    from tests.conftest import fund_document, write_release

    release_dir = write_release(tmp_path, [fund_document()], release_id="2026-11-18.4")
    published = sum(path.stat().st_size for path in release_dir.rglob("*") if path.is_file())
    monkeypatch.setattr(cc, "R2_STORAGE_BUDGET", published * cc.MAX_RESIDENT_RELEASES - 1)
    _assert_upload_refused(release_dir)


def _assert_upload_refused(release_dir):
    """An upload through the real `upload_release` that must refuse before touching a client."""
    from pipeline import release

    calls: list[str] = []

    class Unreachable:
        def __getattr__(self, name):  # pragma: no cover - reaching this is the failure
            calls.append(name)
            raise AssertionError(f"the guard let the upload reach client.{name}")

    with pytest.raises(cc.CostCeilingError):
        release.upload_release(
            release_dir,
            client=Unreachable(),
            public=Unreachable(),
            prefix=f"releases/{release_dir.name}",
            pointer_prefix="staging/latest",
        )
    assert calls == []


def test_cli_refuses_a_release_over_the_byte_line(tmp_path, monkeypatch):
    """The byte path through `main` was untested; only the object line was driven."""
    release_dir = tmp_path / "2026-11-18.2"
    release_dir.mkdir()
    (release_dir / "manifest.json").write_bytes(b"x" * 3)
    # 3 bytes x 3 resident releases = 9: exactly on the line passes, one byte under refuses.
    # Stub allowance zeroed so the arithmetic under test is the release bytes alone.
    monkeypatch.setattr(cc, "STUB_ALLOWANCE", 0)
    monkeypatch.setattr(cc, "R2_STORAGE_BUDGET", 9)
    assert cc.main(["--release", str(release_dir)]) == 0
    monkeypatch.setattr(cc, "R2_STORAGE_BUDGET", 8)
    assert cc.main(["--release", str(release_dir)]) == 1
