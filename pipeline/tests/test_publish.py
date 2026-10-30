"""The publish sequence, tested against fakes: order, guards, and verification.

What matters here is not that bytes reach a bucket — the live run proves that —
but that the command refuses the cases that make a release wrong: a local file
that disagrees with its hash, a pointer written before its objects exist, and a
prefix under `latest/` without an explicit production flag.
"""

from __future__ import annotations

import json
from unittest import mock

import pytest

from pipeline import release
from pipeline.r2 import NO_CACHE, IMMUTABLE, PublicResponse, R2Error
from tests.conftest import fund_document, write_release


class FakeR2:
    """Records what a real client would have uploaded."""

    def __init__(self):
        self.objects: dict[str, tuple[bytes, str]] = {}
        self.puts: list[str] = []

    def put(self, key: str, body: bytes, *, content_type: str = "", cache_control: str = IMMUTABLE) -> str:
        self.objects[key] = (body, cache_control)
        self.puts.append(key)
        return "etag"


class FakePublic:
    """Serves whatever FakeR2 holds, the way the data host would."""

    base_url = "https://data.example"

    def __init__(self, storage: FakeR2, *, corrupt: str | None = None):
        self.storage = storage
        self.corrupt = corrupt
        self.fetched: list[str] = []

    def fetch(self, key: str, *, origin: str | None = None) -> PublicResponse:
        self.fetched.append(key)
        stored = self.storage.objects.get(key)
        if stored is None:
            return PublicResponse(f"{self.base_url}/{key}", 404, {}, b"")
        body, cache_control = stored
        if self.corrupt and key.endswith(self.corrupt):
            body = body[:-1] + b" "
        headers = {"cache-control": cache_control}
        if origin:
            headers["access-control-allow-origin"] = origin
        return PublicResponse(f"{self.base_url}/{key}", 200, headers, body)

    def fetch_json(self, key: str, *, origin: str | None = None) -> dict:
        response = self.fetch(key, origin=origin)
        if response.status != 200:
            raise AssertionError(f"unexpected {response.status} for {key}")
        return json.loads(response.body)


@pytest.fixture
def release_dir(tmp_path):
    return write_release(tmp_path, [fund_document()], release_id="2026-10-28.9")


def publish(release_dir, storage=None, *, prefix="releases/2026-10-28.9", pointer_prefix="staging/latest", **kwargs):
    storage = storage or FakeR2()
    public = kwargs.pop("public", None) or FakePublic(storage)
    report = release.upload_release(
        release_dir,
        client=storage,
        public=public,
        prefix=prefix,
        pointer_prefix=pointer_prefix,
        **kwargs,
    )
    return storage, public, report


def test_uploads_every_object_then_the_pointer(release_dir):
    storage, public, report = publish(release_dir)

    assert report.failures == []
    assert report.prefix == "releases/2026-10-28.9"
    assert report.pointer_key == "staging/latest/release.json"
    # The pointer is written last, and every object in the release directory is
    # published — not just the funds the manifest happens to enumerate.
    assert storage.puts[-1] == "staging/latest/release.json"
    published = {key.removeprefix("releases/2026-10-28.9/") for key in storage.puts[:-1]}
    on_disk = {
        path.relative_to(release_dir).as_posix()
        for path in release_dir.rglob("*")
        if path.is_file() and path.name not in release.NOT_PUBLISHED
    }
    assert published == on_disk
    assert {"release.json", "tickers.json", "catalogue.json", "index/T.json"} <= published
    assert any(key.startswith("companies/c_") for key in published)
    for item in report.objects:
        assert item.verified and item.allow_origin == release.DEFAULT_ORIGIN
        assert storage.objects[item.key][1] == IMMUTABLE
    assert report.pointer is not None and report.pointer.verified
    assert storage.objects[report.pointer.key][1] == NO_CACHE


def test_pointer_is_the_release_descriptor_byte_for_byte(release_dir):
    storage, _, report = publish(release_dir)
    descriptor_bytes = (release_dir / "release.json").read_bytes()
    pointer_bytes = storage.objects[report.pointer.key][0]
    assert pointer_bytes == descriptor_bytes
    assert report.pointer.sha256 == release.sha256_hex(descriptor_bytes)
    # …and it is small: the day-4 pointer was the 1.29 MB inventory.
    assert len(pointer_bytes) < 4_096
    document = json.loads(pointer_bytes)
    assert document["kind"] == "release"
    assert document["objects"]["manifest"]["sha256"] == release.sha256_hex(
        (release_dir / "manifest.json").read_bytes()
    )


def test_pointer_is_not_written_when_an_object_fails(release_dir):
    storage = FakeR2()
    public = FakePublic(storage, corrupt="TEST.json")
    _, _, report = publish(release_dir, storage, public=public)

    assert report.failures
    assert "staging/latest/release.json" not in storage.objects
    assert "not written" in (report.pointer.problem or "")


def test_live_prefix_needs_allow_live():
    with pytest.raises(release.ReleaseError):
        release.guard_prefixes("releases/2026-10-28.9", "latest", allow_live=False)
    with pytest.raises(release.ReleaseError):
        release.guard_prefixes("latest/2026-10-28.9", "staging/latest", allow_live=False)
    release.guard_prefixes("releases/2026-10-28.9", "latest", allow_live=True)


def test_local_hash_mismatch_aborts_before_any_upload(release_dir):
    fund = next((release_dir / "funds").glob("*.json"))
    fund.write_bytes(fund.read_bytes().replace(b'"', b'" ', 1))

    storage = FakeR2()
    with pytest.raises(release.ReleaseError) as caught:
        publish(release_dir, storage)
    assert "does not match the manifest" in str(caught.value)
    assert storage.puts == []


def test_manifest_as_of_must_match_the_directory(tmp_path):
    release_dir = write_release(tmp_path, [fund_document()], release_id="2026-10-28.9")
    manifest = json.loads((release_dir / "manifest.json").read_text())
    manifest["as_of"] = "2026-10-28.10"
    (release_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")

    with pytest.raises(release.ReleaseError) as caught:
        publish(release_dir, FakeR2())
    assert "the published path is derived from as_of" in str(caught.value)


def test_dry_run_writes_nothing(release_dir):
    storage, public, report = publish(release_dir, dry_run=True)
    assert storage.puts == []
    assert public.fetched == []
    assert report.dry_run
    assert report.live_pointer_status is None


def test_report_records_an_untouched_live_pointer(release_dir):
    storage, _, report = publish(release_dir)
    assert report.live_pointer_status == 404
    assert report.live_pointer_release is None


def test_report_is_written_next_to_the_release(release_dir):
    _, _, report = publish(release_dir, report_dir=release_dir)
    payload = json.loads((release_dir / "upload-report.json").read_text())
    assert payload["release"] == "2026-10-28.9"
    assert payload["pointer_key"] == "staging/latest/release.json"
    assert payload["failures"] == []
    assert payload["total_bytes"] == report.total_bytes


def test_missing_credentials_name_the_variable_not_the_value(monkeypatch):
    for name in ("R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"):
        monkeypatch.delenv(name, raising=False)
    with pytest.raises(release.ReleaseError) as caught:
        release.credentials_from_env()
    message = str(caught.value)
    assert "R2_ENDPOINT" in message and "R2_SECRET_ACCESS_KEY" in message
    assert "=" not in message  # names only, never a value


def test_an_empty_bucket_name_falls_back_to_the_default(monkeypatch):
    """GitHub Actions exports `R2_BUCKET` as "" when the secret is unset.

    `os.environ.get("R2_BUCKET", DEFAULT_BUCKET)` returns "" in that case — a present key —
    and an empty bucket name would make every object URL start with a stray slash. The
    default has to survive an empty string, not just a missing one.
    """
    monkeypatch.setenv("R2_ENDPOINT", "https://e")
    monkeypatch.setenv("R2_ACCESS_KEY_ID", "ak")
    monkeypatch.setenv("R2_SECRET_ACCESS_KEY", "sk")
    monkeypatch.setenv("R2_BUCKET", "")
    _, _, bucket = release.credentials_from_env()
    assert bucket == release.DEFAULT_BUCKET

    monkeypatch.setenv("R2_BUCKET", "other-bucket")
    _, _, bucket = release.credentials_from_env()
    assert bucket == "other-bucket"


def test_env_file_fills_only_missing_names(tmp_path, monkeypatch):
    env_file = tmp_path / ".env"
    env_file.write_text('R2_BUCKET=from-file\nR2_ENDPOINT="https://e"\n# comment\n\n')
    monkeypatch.setenv("R2_BUCKET", "from-env")
    monkeypatch.delenv("R2_ENDPOINT", raising=False)

    loaded = release.load_env(env_file)
    assert loaded == ["R2_ENDPOINT"]
    assert release.os.environ["R2_BUCKET"] == "from-env"
    assert release.os.environ["R2_ENDPOINT"] == "https://e"


class FlakyR2(FakeR2):
    """A client whose first `failures` puts per key raise a transport error, then works.

    The wide upload makes about 27,000 public reads at 32 in flight; a resolver that
    misses once aborts the whole publish unless a transient failure is retried. This is
    that failure, made deterministic — per key, so it does not depend on which worker
    got there first.
    """

    def __init__(self, *, failures: int = 1, status: int = 0):
        super().__init__()
        self.failures = failures
        self.status = status
        self.attempts: dict[str, int] = {}

    def put(self, key: str, body: bytes, *, content_type: str = "", cache_control: str = IMMUTABLE) -> str:
        self.attempts[key] = self.attempts.get(key, 0) + 1
        if self.attempts[key] <= self.failures:
            raise R2Error("PUT", self.status, "transport error: nodename nor servname provided", key)
        return super().put(key, body, content_type=content_type, cache_control=cache_control)


def test_a_transient_transport_error_is_retried_not_fatal(release_dir):
    storage = FlakyR2(failures=1)
    sleeps = []
    with mock.patch.object(release, "_retry_sleep", sleeps.append):
        _, _, report = publish(release_dir, storage)

    assert report.failures == []
    # Every key failed once and succeeded on the retry: one 0.5 s backoff per key.
    assert set(storage.attempts.values()) == {2}
    assert sleeps == [0.5] * len(storage.attempts)
    published = [key for key in storage.puts if key.startswith("releases/")]
    assert len(published) == len(set(published)), "a retried object is not uploaded twice"


def test_a_read_timeout_on_the_public_check_is_retried(release_dir):
    """A socket timeout is a transport failure, not an answer about the release."""

    class SlowPublic(FakePublic):
        def __init__(self, storage):
            super().__init__(storage)
            self.calls = 0

        def fetch(self, key, *, origin=None):
            self.calls += 1
            if self.calls == 1:
                raise TimeoutError("The read operation timed out")
            return super().fetch(key, origin=origin)

    storage = FakeR2()
    public = SlowPublic(storage)
    with mock.patch.object(release, "_retry_sleep", lambda _s: None):
        _, _, report = publish(release_dir, storage, public=public)

    assert report.failures == []
    assert public.calls > len(storage.puts), "the failed check was repeated, not skipped"


def test_a_permanent_error_still_fails_the_upload(release_dir):
    storage = FlakyR2(failures=99)
    with mock.patch.object(release, "_retry_sleep", lambda _s: None), pytest.raises(R2Error):
        publish(release_dir, storage)
    assert max(storage.attempts.values()) == 4, "three retries, then the error is the answer"
