"""The OpenFIGI layer: a keyed cache, an acceptance rule, and a refresh that asks only what it must.

No test here touches the network: ``refresh`` takes a ``transport``, and every one is a fake that
answers from a dict. Every identifier is synthetic — an ISIN built with ``isin_check_digit`` and a
FIGI built with ``figi_check_digit`` — because a real one committed to a public repository would
repeat the leak this layer exists to avoid.
"""

from __future__ import annotations

import json
import re

import pytest

from pipeline import figi, identifiers
from pipeline.namespaces import COMPANY_ID_RE, is_security_id

PEPPER = b"a-test-pepper-of-sixteen+bytes"
TODAY = "2026-11-18"


def synthetic_isin(serial: int, prefix: str = "KR") -> str:
    body = f"{prefix}{serial:09d}"
    return body + identifiers.isin_check_digit(body)


def synthetic_figi(serial: int) -> str:
    body = f"BBG{serial:08d}"
    return body + identifiers.figi_check_digit(body)


ISIN_A, ISIN_B, ISIN_C = synthetic_isin(1), synthetic_isin(2), synthetic_isin(3)
FIGI_A, FIGI_B = synthetic_figi(1), synthetic_figi(2)


def record(figi_value=FIGI_A, sector="Equity", type2="Common Stock") -> dict:
    """One OpenFIGI mapping record, with the fields the layer reads and two it must ignore."""
    return {
        "figi": "BBG00ignored0",
        "shareClassFIGI": figi_value,
        "marketSector": sector,
        "securityType": "Common Stock",
        "securityType2": type2,
        "name": "NOT READ — Related Security Description",
        "ticker": "NOTREAD",
    }


class FakeOpenFigi:
    """A transport that answers from ``table`` (ISIN → record, or absent for no match)."""

    def __init__(self, table: dict[str, dict], script: list[tuple[int, dict, bytes]] | None = None):
        self.table = table
        self.script = list(script or [])
        self.bodies: list[list[str]] = []
        self.headers_seen: list[dict[str, str]] = []

    def __call__(self, body: bytes, headers: dict[str, str]):
        self.headers_seen.append(dict(headers))
        isins = [job["idValue"] for job in json.loads(body)]
        self.bodies.append(isins)
        if self.script:
            return self.script.pop(0)
        payload = [
            {"data": [self.table[isin]]} if isin in self.table else {"warning": "No identifier found."}
            for isin in isins
        ]
        return 200, {}, json.dumps(payload).encode()

    @property
    def requests(self) -> int:
        return len(self.bodies)


class Clock:
    """A fake clock so the throttle never really sleeps."""

    def __init__(self) -> None:
        self.now = 0.0
        self.slept: list[float] = []

    def time(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)
        self.now += seconds


def run(isins, tmp_path, transport, *, clock=None, **kwargs):
    clock = clock or Clock()
    return figi.refresh(
        isins,
        cache_path=tmp_path / "figi_cache_v1.jsonl",
        pepper=PEPPER,
        api_key="test-key-not-a-real-one",
        today=kwargs.pop("today", TODAY),
        transport=transport,
        sleep=clock.sleep,
        clock=clock.time,
        **kwargs,
    )


# --- keys and ids ------------------------------------------------------------


def test_the_cache_key_is_keyed_stable_and_not_an_isin():
    key = figi.cache_key(PEPPER, ISIN_A)
    assert key == figi.cache_key(PEPPER, ISIN_A.lower()), "case must not change the key"
    assert key != figi.cache_key(b"another-pepper-sixteen+", ISIN_A), "the pepper is what makes it keyed"
    assert key != figi.cache_key(PEPPER, ISIN_B)
    assert ISIN_A not in key and len(key) == 32 and re.fullmatch(r"[0-9a-f]{32}", key)


@pytest.mark.parametrize("environ", [{}, {figi.PEPPER_ENV: ""}, {figi.PEPPER_ENV: "short"}])
def test_a_missing_or_short_pepper_is_refused_with_no_unkeyed_fallback(environ):
    with pytest.raises(figi.PepperMissing):
        figi.pepper_from_env(environ)


def test_a_good_pepper_is_read_from_the_environment():
    assert figi.pepper_from_env({figi.PEPPER_ENV: PEPPER.decode()}) == PEPPER


def test_the_security_id_is_a_namespaced_hash_never_the_figi():
    ident = figi.security_id(FIGI_A)
    assert is_security_id(ident) and COMPANY_ID_RE.match(ident)
    assert ident == figi.security_id(FIGI_A.lower()), "normalised before hashing"
    assert ident != figi.security_id(FIGI_B)
    assert FIGI_A not in ident


# --- what is accepted --------------------------------------------------------


def answer(**fields) -> figi.Answer:
    base = dict(status="OK", fetched_at=TODAY, share_class_figi=FIGI_A, sector="Equity",
                security_type2="Common Stock")
    base.update(fields)
    return figi.Answer(**base)


@pytest.mark.parametrize("type2", sorted(figi.ACCEPTED_TYPES))
def test_every_allow_listed_equity_type_is_accepted(type2):
    assert answer(security_type2=type2).accepted()


@pytest.mark.parametrize(
    "fields",
    [
        dict(security_type2="Mutual Fund"),  # an open-end fund, ETP or closed-end fund filed as an equity
        dict(security_type2="Warrant"),
        dict(security_type2="Right"),
        dict(security_type2=None),
        dict(sector="Corp"),
        dict(sector="Govt"),
        dict(share_class_figi=None),
        dict(share_class_figi="BBG000000000"),  # right shape, wrong check digit
        dict(status="NO_MATCH"),
    ],
)
def test_everything_else_is_refused(fields):
    assert not answer(**fields).accepted()


def test_the_allow_list_reads_security_type_two_not_security_type():
    """OpenFIGI's ``securityType`` says ``ADR``/``NVDR``; the vocabulary we accept is in ``securityType2``."""
    payload = [{"data": [{**record(type2="Depositary Receipt"), "securityType": "ADR"}]}]
    got = figi.answers_from_payload(payload, [ISIN_A], TODAY)[ISIN_A]
    assert got.security_type2 == "Depositary Receipt" and got.accepted()


def test_names_and_tickers_are_never_kept():
    got = figi.answers_from_payload([{"data": [record()]}], [ISIN_A], TODAY)[ISIN_A]
    assert "NOT READ" not in repr(got) and "NOTREAD" not in repr(got)
    assert set(got.to_record("k")) == {"key", "status", "fetched_at", "share_class_figi", "sector",
                                       "security_type2"}


def test_a_job_with_no_data_is_no_match_and_a_short_response_is_an_error():
    got = figi.answers_from_payload([{"warning": "No identifier found."}], [ISIN_A], TODAY)
    assert got[ISIN_A].status == figi.STATUS_NO_MATCH
    with pytest.raises(figi.FigiError):
        figi.answers_from_payload([], [ISIN_A], TODAY)


# --- the cache file ----------------------------------------------------------


def test_the_cache_file_is_deterministic_sorted_and_holds_no_isin(tmp_path):
    table = {ISIN_A: record(FIGI_A), ISIN_B: record(FIGI_B, type2="REIT")}
    run([ISIN_B, ISIN_A, ISIN_C], tmp_path, FakeOpenFigi(table))
    path = tmp_path / "figi_cache_v1.jsonl"
    first = path.read_bytes()

    text = first.decode()
    for isin in (ISIN_A, ISIN_B, ISIN_C):
        assert isin not in text, "an ISIN was written in the clear"
    keys = [json.loads(line)["key"] for line in text.splitlines()]
    assert keys == sorted(keys) and len(keys) == 3

    reloaded = figi.ShareClassMap.load(path, PEPPER)
    reloaded.write(tmp_path / "again.jsonl")
    assert (tmp_path / "again.jsonl").read_bytes() == first, "write → load → write is a fixed point"
    assert reloaded.sha256 == figi.ShareClassMap.load(tmp_path / "again.jsonl", PEPPER).sha256


def test_a_map_answers_by_isin_and_only_accepted_answers_become_a_security(tmp_path):
    table = {ISIN_A: record(FIGI_A), ISIN_B: record(FIGI_B, type2="Mutual Fund")}
    run([ISIN_A, ISIN_B, ISIN_C], tmp_path, FakeOpenFigi(table))
    cache = figi.ShareClassMap.load(tmp_path / "figi_cache_v1.jsonl", PEPPER)

    assert cache.security_for(ISIN_A) == figi.security_id(FIGI_A)
    assert cache.security_for(ISIN_B) is None, "a Mutual Fund is a fund position, not a company"
    assert cache.security_for(ISIN_C) is None, "no match"
    assert cache.answer_for(synthetic_isin(99)) is None, "never asked"
    assert cache.answer_for("not an isin") is None
    assert cache.stats() == {"records": 3, "ok": 2, "no_match": 1, "accepted": 1}
    assert cache.provenance()["sha256"] == cache.sha256


def test_a_map_read_with_the_wrong_pepper_finds_nothing(tmp_path):
    run([ISIN_A], tmp_path, FakeOpenFigi({ISIN_A: record()}))
    other = figi.ShareClassMap.load(tmp_path / "figi_cache_v1.jsonl", b"another-pepper-sixteen+")
    assert other.security_for(ISIN_A) is None


# --- the refresh -------------------------------------------------------------


def test_only_uncached_isins_are_asked_and_a_second_run_makes_no_request(tmp_path):
    transport = FakeOpenFigi({ISIN_A: record(), ISIN_B: record(FIGI_B)})
    first = run([ISIN_A, ISIN_B, ISIN_C], tmp_path, transport)
    assert (first.requests, first.asked, first.ok, first.no_match) == (1, 3, 2, 1)

    second = run([ISIN_A, ISIN_B, ISIN_C], tmp_path, transport)
    assert second.requests == 0 and second.asked == 0 and second.already_cached == 3
    assert transport.requests == 1

    ISIN_D = synthetic_isin(4)
    third = run([ISIN_A, ISIN_D], tmp_path, transport)
    assert third.asked == 1 and transport.bodies[-1] == [ISIN_D], "only the new ISIN is sent"


def test_isins_are_batched_by_jobs_per_request(tmp_path):
    isins = [synthetic_isin(n) for n in range(10, 15)]
    transport = FakeOpenFigi({})
    outcome = run(isins, tmp_path, transport, jobs_per_request=2)
    assert outcome.requests == 3 and [len(b) for b in transport.bodies] == [2, 2, 1]


def test_an_invalid_isin_is_never_sent(tmp_path):
    transport = FakeOpenFigi({})
    wrong_check_digit = ISIN_A[:-1] + str((int(ISIN_A[-1]) + 1) % 10)
    run([ISIN_A, wrong_check_digit, "", "12345", "not an isin"], tmp_path, transport)
    sent = [isin for body in transport.bodies for isin in body]
    assert sent == [ISIN_A]


def test_requests_are_paced_at_eighty_percent_of_the_keyed_limit(tmp_path):
    assert figi.DEFAULT_RPM == 200.0 and figi.DEFAULT_JOBS == 100
    clock = Clock()
    isins = [synthetic_isin(n) for n in range(20, 26)]
    run(isins, tmp_path, FakeOpenFigi({}), clock=clock, jobs_per_request=2)
    gaps = [round(s, 3) for s in clock.slept]
    assert gaps and all(abs(gap - 0.3) < 0.01 for gap in gaps), "60 s / 200 requests = 0.3 s apart"


@pytest.mark.parametrize(
    "status, age_days, asked",
    [("OK", 179, False), ("OK", 181, True), ("NO_MATCH", 89, False), ("NO_MATCH", 91, True)],
)
def test_answers_expire_ok_after_180_days_and_no_match_after_90(tmp_path, status, age_days, asked):
    from datetime import date, timedelta

    fetched = (date.fromisoformat(TODAY) - timedelta(days=age_days)).isoformat()
    cache = figi.ShareClassMap.empty(PEPPER)
    cache.merge({ISIN_A: answer(status=status, fetched_at=fetched)})
    cache.write(tmp_path / "figi_cache_v1.jsonl")
    transport = FakeOpenFigi({ISIN_A: record()})
    run([ISIN_A], tmp_path, transport)
    assert (transport.requests == 1) is asked


def test_a_429_waits_the_time_it_asks_for_and_then_succeeds(tmp_path):
    transport = FakeOpenFigi({ISIN_A: record()}, script=[(429, {"retry-after": "7"}, b"")])
    clock = Clock()
    outcome = run([ISIN_A], tmp_path, transport, clock=clock)
    assert 7.0 in clock.slept, "Retry-After is honoured"
    assert outcome.requests == 2 and outcome.ok == 1 and outcome.failed_batches == 0


def test_a_batch_that_keeps_failing_is_counted_and_never_stored_as_an_answer(tmp_path):
    always_500 = [(500, {}, b"")] * identifiers.MAX_ATTEMPTS
    outcome = run([ISIN_A], tmp_path, FakeOpenFigi({}, script=always_500))
    assert outcome.failed_batches == 1 and outcome.ok == 0 and outcome.no_match == 0
    cache = figi.ShareClassMap.load(tmp_path / "figi_cache_v1.jsonl", PEPPER)
    assert len(cache) == 0, "a failure is not 'no match' — it is asked again next run"

    retry = FakeOpenFigi({ISIN_A: record()})
    run([ISIN_A], tmp_path, retry)
    assert retry.requests == 1


@pytest.mark.parametrize("code", [401, 403])
def test_a_rejected_key_stops_the_run_and_keeps_what_it_had(tmp_path, code):
    run([ISIN_A], tmp_path, FakeOpenFigi({ISIN_A: record()}))
    with pytest.raises(identifiers.KeyRequired):
        run([ISIN_A, ISIN_B], tmp_path, FakeOpenFigi({}, script=[(code, {}, b"")]))
    cache = figi.ShareClassMap.load(tmp_path / "figi_cache_v1.jsonl", PEPPER)
    assert cache.security_for(ISIN_A) is not None


def test_no_key_refuses_an_unkeyed_run(tmp_path):
    with pytest.raises(identifiers.KeyRequired):
        figi.refresh([ISIN_A], cache_path=tmp_path / "c.jsonl", pepper=PEPPER, api_key=None,
                     transport=FakeOpenFigi({}))


def test_the_key_is_sent_in_a_header_and_never_in_the_body_or_the_output(tmp_path, monkeypatch, capsys):
    transport = FakeOpenFigi({ISIN_A: record()})
    monkeypatch.setattr(identifiers, "http_transport", transport)
    monkeypatch.setenv(figi.PEPPER_ENV, PEPPER.decode())
    monkeypatch.setenv(identifiers.KEY_ENV, "sentinel-key-value-0123456789")
    isins = tmp_path / "isins.json"
    isins.write_text(json.dumps([ISIN_A]))

    code = figi.main(["refresh", "--isins", str(isins), "--cache", str(tmp_path / "c.jsonl")])

    out = capsys.readouterr()
    assert code == 0
    assert transport.headers_seen[0]["X-OPENFIGI-APIKEY"] == "sentinel-key-value-0123456789"
    for stream in (out.out, out.err, (tmp_path / "c.jsonl").read_text()):
        assert "sentinel-key-value" not in stream and PEPPER.decode() not in stream and ISIN_A not in stream
    assert json.loads(out.out)["asked"] == 1


def test_the_command_line_refuses_without_a_pepper(tmp_path, monkeypatch, capsys):
    monkeypatch.delenv(figi.PEPPER_ENV, raising=False)
    (tmp_path / "isins.json").write_text(json.dumps([ISIN_A]))
    code = figi.main(["refresh", "--isins", str(tmp_path / "isins.json"), "--cache", str(tmp_path / "c")])
    assert code == 2 and "no unkeyed fallback" in capsys.readouterr().err
