"""Promotion moves a pointer; it never re-uploads a release.

The daily refresh publishes under `staging/` and a second job promotes it the next
day. That second job has no copy of the release — it must decide from what the public
host serves. These tests pin the three answers that decision can give (promote,
refuse, already live) and the integrity check that makes a promote safe without the
14,239 objects in hand.
"""

from __future__ import annotations

import json

import pytest

from pipeline import release as release_mod
from pipeline.r2 import PublicResponse
from pipeline.release import ReleaseError, promote_release


def _descriptor(release_id: str, manifest_bytes: bytes) -> dict:
    return {
        "schema_version": 2,
        "kind": "release",
        "as_of": release_id,
        "objects": {
            "manifest": {
                "path": "manifest.json",
                "sha256": release_mod.sha256_hex(manifest_bytes),
                "bytes": len(manifest_bytes),
            }
        },
    }


class FakePublic:
    """Serves a fixed key → body map, with the 404-then-200 cache behaviour on demand."""

    base_url = "https://data.example"

    def __init__(self, objects: dict[str, bytes], *, pointer_404_first: bool = False):
        # Holds the caller's dict, not a copy: a write through FakeClient must be visible
        # on the next read, which is what the read-back verification is checking.
        self.objects = objects
        self.pointer_404_first = pointer_404_first
        self.fetched: list[str] = []
        self._served_404 = set()

    def fetch(
        self, key: str, *, origin: str | None = None, cache_bust: str | None = None
    ) -> PublicResponse:
        self.fetched.append(key)
        # A cache-busting query is not part of the object's name; the edge ignores it too.
        lookup = key.split("?")[0]
        if lookup not in self.objects:
            return PublicResponse(url=key, status=404, headers={}, body=b"")
        if self.pointer_404_first and lookup.startswith("latest/") and "?" not in key and lookup not in self._served_404:
            self._served_404.add(lookup)
            return PublicResponse(url=key, status=404, headers={}, body=b"")
        return PublicResponse(url=key, status=200, headers={}, body=self.objects[lookup])


class FakeClient:
    """Records writes and applies them to the same store the reader serves."""

    def __init__(self, store: dict[str, bytes] | None = None):
        self.puts: list[tuple[str, bytes, str]] = []
        self.store = store

    def put(self, key: str, body: bytes, *, content_type: str = "", cache_control: str = "") -> str:
        self.puts.append((key, body, cache_control))
        if self.store is not None:
            self.store[key] = body
        return "etag"


@pytest.fixture
def published():
    """A minimal but internally consistent published release at 2026-10-31.1.

    `manifest.files` is left empty: the descriptor→manifest claim is the one that
    matters, and the reverse claim is exercised by its own test below. A real
    manifest names every fund file, so leaving it empty here is the smallest thing
    that still proves the two-object check.
    """
    release_id = "2026-10-31.1"
    manifest_bytes = json.dumps({"as_of": release_id, "files": []}).encode()
    descriptor_bytes = json.dumps(_descriptor(release_id, manifest_bytes)).encode()
    objects = {
        f"releases/{release_id}/release.json": descriptor_bytes,
        f"releases/{release_id}/manifest.json": manifest_bytes,
        "latest/release.json": json.dumps({"kind": "release", "as_of": "2026-10-30.5"}).encode(),
    }
    return release_id, objects


def test_promote_writes_the_descriptor_and_verifies(published):
    release_id, objects = published
    public = FakePublic(objects)
    client = FakeClient(objects)

    result = promote_release(release_id, client=client, public=public, allow_live=True, origin=None)

    assert result["action"] == "promote"
    assert result["from"] == "2026-10-30.5"
    assert result["to"] == release_id
    assert result["wrote_pointer"] is True and result["verified"] is True
    # Exactly one write: the pointer. A promotion that re-uploads objects is a bug.
    assert [key for key, _body, _cache in client.puts] == ["latest/release.json"]
    key, body, cache_control = client.puts[0]
    assert json.loads(body)["as_of"] == release_id
    assert cache_control == release_mod.NO_CACHE


def test_promote_refuses_without_allow_live(published):
    release_id, objects = published
    with pytest.raises(ReleaseError, match="--allow-live"):
        promote_release(release_id, client=FakeClient(objects), public=FakePublic(objects), origin=None)


def test_promote_refuses_an_inconsistent_release(published):
    release_id, objects = published
    objects[f"releases/{release_id}/manifest.json"] += b" "
    with pytest.raises(ReleaseError, match="not internally consistent"):
        promote_release(
            release_id, client=FakeClient(objects), public=FakePublic(objects), allow_live=True, origin=None
        )


def test_promote_refuses_an_unpublished_release(published):
    release_id, objects = published
    with pytest.raises(ReleaseError, match="is not published"):
        promote_release(
            "2026-11-01.1", client=FakeClient(objects), public=FakePublic(objects), allow_live=True, origin=None
        )


def test_promote_refuses_a_downgrade_unless_told(published):
    release_id, objects = published
    public = FakePublic(objects)
    # A live pointer that names something newer than the candidate.
    objects["latest/release.json"] = json.dumps({"kind": "release", "as_of": "2026-11-05.1"}).encode()
    with pytest.raises(ReleaseError, match="sorts before it"):
        promote_release(release_id, client=FakeClient(objects), public=public, allow_live=True, origin=None)

    client = FakeClient(objects)
    result = promote_release(
        release_id, client=client, public=public, allow_live=True, allow_downgrade=True, origin=None
    )
    assert result["from"] == "2026-11-05.1"
    assert result["wrote_pointer"] is True


def test_promote_is_a_noop_when_already_live(published):
    release_id, objects = published
    objects["latest/release.json"] = objects[f"releases/{release_id}/release.json"]
    client = FakeClient(objects)
    result = promote_release(
        release_id, client=client, public=FakePublic(objects), allow_live=True, origin=None
    )
    assert result["action"] == "already-live"
    assert client.puts == []


def test_promote_dry_run_writes_nothing(published):
    release_id, objects = published
    client = FakeClient(objects)
    result = promote_release(
        release_id, client=None, public=FakePublic(objects), allow_live=True, dry_run=True, origin=None
    )
    assert result["wrote_pointer"] is False
    assert client.puts == []


def test_promote_reads_through_a_cached_pointer_404(published):
    """The edge answers 404 for ~3 minutes after a write; the second read is cache-busted."""
    release_id, objects = published
    objects["latest/release.json"] = objects[f"releases/{release_id}/release.json"]
    public = FakePublic(objects, pointer_404_first=True)
    result = promote_release(
        release_id, client=FakeClient(objects), public=public, allow_live=True, origin=None
    )
    assert result["action"] == "already-live"
    assert any("?" in key for key in public.fetched)

def test_promote_refuses_a_descriptor_the_manifest_disowns(published):
    """The other direction: the manifest claims a release.json hash that is wrong."""
    release_id, objects = published
    manifest = json.loads(objects[f"releases/{release_id}/manifest.json"])
    manifest["files"] = [{"path": "release.json", "sha256": "0" * 64, "bytes": 1}]
    manifest_bytes = json.dumps(manifest).encode()
    descriptor_bytes = json.dumps(_descriptor(release_id, manifest_bytes)).encode()
    objects[f"releases/{release_id}/manifest.json"] = manifest_bytes
    objects[f"releases/{release_id}/release.json"] = descriptor_bytes
    with pytest.raises(ReleaseError, match="not internally consistent"):
        promote_release(
            release_id, client=FakeClient(objects), public=FakePublic(objects), allow_live=True, origin=None
        )
