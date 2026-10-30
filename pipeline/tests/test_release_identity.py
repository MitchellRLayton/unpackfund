"""A release id is published bytes with a name on them.

Run 3 on 2026-10-30 reused `2026-10-30.1` (a fresh checkout always starts at `.1`), rewrote
14,275 objects, and then verified them through the public host — which answered 1,267 of them
with the *previous* upload's cached bytes, so the staging pointer was (correctly) never written.
Three behaviours keep that from recurring.
"""

from __future__ import annotations

import hashlib

import pytest

from pipeline import release, r2


class FakeClient:
    """Just enough of R2Client: a key set and a head/get over it."""

    def __init__(self, keys: dict[str, bytes] | None = None):
        self.objects = dict(keys or {})

    def list_keys(self, prefix: str = "") -> list[str]:
        return sorted(k for k in self.objects if k.startswith(prefix))

    def head(self, key: str):
        if key not in self.objects:
            return None
        return r2.ObjectHead(
            key=key,
            size=len(self.objects[key]),
            etag="",
            content_type="application/json",
            cache_control="",
        )

    def get(self, key: str) -> bytes:
        return self.objects[key]


def test_first_free_id_starts_at_one():
    assert release.next_release_id(FakeClient(), "releases", "2026-10-30") == "2026-10-30.1"


def test_it_skips_ids_that_are_already_published():
    client = FakeClient(
        {
            "releases/2026-10-30.1/index/A.json": b"{}",
            "releases/2026-10-30.2/index/A.json": b"{}",
            "releases/2026-10-29.1/index/A.json": b"{}",
        }
    )
    assert release.next_release_id(client, "releases", "2026-10-30") == "2026-10-30.3"


def test_a_different_date_is_not_a_collision():
    client = FakeClient({"releases/2026-10-29.1/index/A.json": b"{}"})
    assert release.next_release_id(client, "releases", "2026-10-30") == "2026-10-30.1"


def test_a_bare_date_prefix_counts_as_taken():
    client = FakeClient({"releases/2026-10-30/smoke.json": b"{}"})
    assert release.next_release_id(client, "releases", "2026-10-30") == "2026-10-30.1"


def test_it_refuses_to_rewrite_a_published_release_with_other_bytes():
    body = b'{"as_of": "2026-10-30"}'
    client = FakeClient({"releases/2026-10-30.1/manifest.json": body})
    published = hashlib.sha256(body).hexdigest()
    with pytest.raises(release.ReleaseError, match="immutable"):
        release._refuse_rewrite(
            client, "releases/2026-10-30.1", {"self": {"sha256": "0" * 64}}
        )
    assert published != "0" * 64


def test_resuming_the_same_release_stays_allowed():
    body = b'{"as_of": "2026-10-30"}'
    client = FakeClient({"releases/2026-10-30.1/manifest.json": body})
    release._refuse_rewrite(
        client, "releases/2026-10-30.1", {"self": {"sha256": hashlib.sha256(body).hexdigest()}}
    )


def test_an_unpublished_prefix_is_not_a_conflict():
    release._refuse_rewrite(FakeClient(), "releases/2026-10-31.1", {"self": {"sha256": "0" * 64}})


def test_the_public_read_can_steer_around_a_cached_copy():
    seen: list[str] = []

    class Opener:
        def __call__(self, request, timeout=0):
            seen.append(request.full_url)

            class Response:
                status = 200
                headers: dict[str, str] = {}

                def read(self):
                    return b""

                def __enter__(self):
                    return self

                def __exit__(self, *exc):
                    return False

            return Response()

    reader = r2.PublicReader("https://data.example", opener=Opener())
    reader.fetch("releases/2026-10-30.1/index/A.json", cache_bust="abc123")
    assert seen == ["https://data.example/releases/2026-10-30.1/index/A.json?v=abc123"]
