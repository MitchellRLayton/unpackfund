"""The identifier layer: batching, caching, pacing, resuming, and what it may not say.

Two kinds of test here, and they answer different questions.

*The machinery* — batch sizes, the request-hash cache, the pacing arithmetic, the 429
retry, a batch that fails, a warm cache that issues no requests — is tested through
injected seams (a fake transport, a fake filing loader, a fake clock) so the whole
suite runs offline in milliseconds. A test that reached the real API would be a test
nobody runs.

*The two rules that are not negotiable* get their own tests: no ISIN, CUSIP or LEI
value reaches stdout or a log line, and the same cache produces byte-identical output.
The first is the compliance rule from ``compliance-licensing-guard``; the second is
invariant I5 in ``xray-project-conventions``, and both are the kind of thing that
breaks silently months later.

Every identifier in this file is synthetic: ``XS`` plus eight zeros plus a serial, with
a real ISO 6166 check digit. No fixture here is a real security's ISIN, and the "CUSIP"
used to prove redaction is nine zeros.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import re

import pytest

from pipeline import identifiers, nport

# --- synthetic identifiers -------------------------------------------------

#: A CUSIP-shaped dummy: nine zeros, which is not any security's CUSIP.
CUSIP_SHAPED = "000000000"
#: An LEI-shaped dummy: twenty zeros.
LEI_SHAPED = "00000000000000000000"


def synthetic_isin(serial: int, prefix: str = "XS") -> str:
    """A well-formed ISIN with a real check digit and an obviously empty body."""
    body = f"{prefix}{serial:09d}"
    assert len(body) == 11
    return body + identifiers.isin_check_digit(body)


ISIN_ALPHA = synthetic_isin(1)
ISIN_BETA = synthetic_isin(2)
ISIN_GAMMA = synthetic_isin(3)
ISIN_DELTA = synthetic_isin(4)
ISIN_EPSILON = synthetic_isin(5)
ISIN_THETA = synthetic_isin(6)
ISIN_MAPPED = synthetic_isin(9)

SOURCE_A = "https://www.sec.gov/Archives/edgar/data/1/000000000026000002/primary_doc.xml"
SOURCE_B = "https://www.sec.gov/Archives/edgar/data/1/000000000026000003/primary_doc.xml"

#: An ISIN-shaped token in free text is what a leak looks like. Uppercase, 12 chars.
ISIN_TEXT_RE = re.compile(r"\b[A-Z]{2}[A-Z0-9]{9}[0-9]\b")
#: A CUSIP-shaped token: nine alphanumerics, at least one digit at each end.
CUSIP_TEXT_RE = re.compile(r"\b[0-9]{3}[0-9A-Z]{5}[0-9]\b")
#: An LEI-shaped token: twenty alphanumerics.
LEI_TEXT_RE = re.compile(r"\b[0-9A-Z]{20}\b")


# --- fixtures: a release, its filings, and the seams that feed them --------


def holding(
    name: str,
    *,
    value: float | None = None,
    asset_cat: str = "EC",
    issuer_cat: str | None = None,
    identifier: str | None = None,
    derivative: bool = False,
) -> nport.Holding:
    return nport.Holding(
        name=name,
        title=None,
        cusip=None,
        isin=identifier,
        ticker=None,
        lei=None,
        balance=None,
        units=None,
        cur_cd="USD",
        val_usd=value,
        pct_val=None,
        asset_cat=asset_cat,
        issuer_cat=issuer_cat,
        inv_country="US",
        payoff_profile=None,
        is_derivative=derivative,
    )


def filing(rows: list[nport.Holding], net_assets: float = 100_000.0) -> nport.NportFiling:
    return nport.NportFiling(
        accession="0000000000-26-000002",
        submission_type="NPORT-P",
        cik="1",
        class_ids=[],
        fiscal_year_end="2026-06-30",
        total_assets=net_assets,
        total_liabilities=0.0,
        series_id="S000000002",
        series_name="Test Identifier Fund",
        registrant_name="Test Registrant",
        report_date="2026-06-30",
        holdings=rows,
        net_assets=net_assets,
    )


def published(
    name: str,
    *,
    weight_bp: int,
    asset_cat: str = "equity",
    company_id: str | None = None,
) -> dict:
    return {
        "company_id": company_id,
        "name": name,
        "ticker": None,
        "asset_cat": asset_cat,
        "weight_bp": weight_bp,
    }


def write_release(root, funds: dict[str, list[dict]], *, source_url: str = SOURCE_A):
    release = root / "artifacts" / "universe-c" / "releases" / "2026-10-30.5"
    (release / "funds").mkdir(parents=True, exist_ok=True)
    for ticker, holdings in funds.items():
        document = {
            "schema_version": 1,
            "ticker": ticker,
            "source_url": source_url,
            "holdings": holdings,
            "coverage_pct": 0.0,
            "warnings": [],
        }
        (release / "funds" / f"{ticker}.json").write_text(json.dumps(document))
    return release


def two_fund_release(root):
    """AAA: 1,500 bp of unmapped claim (600 equity / 400 debt / 500 fund) + noise.

    BBB holds the same Alpha ISIN at 60 bp so per-fund attribution of a shared ISIN is
    exercised, and both funds carry rows that are mapped, cash or derivative — none of
    which may enter the target set.
    """
    funds = {
        "AAA": [
            published("Alpha Corp", weight_bp=300),
            published("Beta Ltd", weight_bp=200),
            published("Gamma SA", weight_bp=100),
            published("Delta Bond", weight_bp=400, asset_cat="debt"),
            published("Epsilon Fund", weight_bp=500, asset_cat="fund"),
            published("Zeta Mapped Co", weight_bp=250, company_id="c_0000000001"),
            published("Cash Row", weight_bp=50, asset_cat="cash"),
            published("Future Row", weight_bp=25, asset_cat="derivative"),
        ],
        "BBB": [
            published("Alpha Corp", weight_bp=60),
            published("Theta Inc", weight_bp=40),
        ],
    }
    filings = {
        SOURCE_A: filing(
            [
                holding("Alpha Corp", value=3_000.0, identifier=ISIN_ALPHA),
                holding("Beta Ltd", value=2_000.0, identifier=ISIN_BETA),
                holding("Gamma SA", value=1_000.0, identifier=ISIN_GAMMA),
                holding("Delta Bond", value=4_000.0, asset_cat="DBT", identifier=ISIN_DELTA),
                holding(
                    "Epsilon Fund", value=5_000.0, issuer_cat="RF", identifier=ISIN_EPSILON
                ),
                holding("Zeta Mapped Co", value=2_500.0, identifier=ISIN_MAPPED),
                holding("Cash Row", value=500.0, asset_cat="STIV"),
                holding("Future Row", value=-250.0, asset_cat="DE", derivative=True),
            ]
        ),
        SOURCE_B: filing(
            [
                holding("Alpha Corp", value=600.0, identifier=ISIN_ALPHA),
                holding("Theta Inc", value=400.0, identifier=ISIN_THETA),
            ]
        ),
    }
    release = write_release(
        root, {"AAA": funds["AAA"]}, source_url=SOURCE_A
    )
    # The second fund lives in its own document, with its own filing.
    (release / "funds" / "BBB.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "ticker": "BBB",
                "source_url": SOURCE_B,
                "holdings": funds["BBB"],
                "coverage_pct": 0.0,
                "warnings": [],
            }
        )
    )
    return release, filings


def many_isin_release(root, count: int):
    """One fund holding ``count`` distinct unmapped equity rows of 10 bp each."""
    values = [synthetic_isin(1000 + index) for index in range(count)]
    funds = {
        "MANY": [
            published(f"Holding {index} Corp", weight_bp=10)
            for index in range(count)
        ]
    }
    rows = [
        holding(f"Holding {index} Corp", value=100.0, identifier=value)
        for index, value in enumerate(values)
    ]
    release = write_release(root, funds, source_url=SOURCE_A)
    return release, {SOURCE_A: filing(rows)}, values


class FakeOpenFIGI:
    """A transport that answers in OpenFIGI's shape, and remembers what it was asked.

    ``calls`` keeps the decoded job arrays, which is how the batch-size and
    "no ISIN reaches the network" assertions are made: the request body is the only
    place the module touches the identifiers.
    """

    def __init__(self, *, resolved=None, script=None, status=200):
        self.resolved = resolved
        self.script = list(script or [])
        self.status = status
        self.calls: list[dict] = []
        self.headers: list[dict] = []

    def __call__(self, body, headers):
        jobs = json.loads(body)
        self.calls.append(jobs)
        self.headers.append(dict(headers))
        if self.script:
            return self.script.pop(0)
        if self.status != 200:
            return self.status, {}, b""
        payload = []
        for job in jobs:
            value = job["idValue"]
            if self.resolved is None or value in self.resolved:
                payload.append({"data": [record(value)]})
            else:
                payload.append({"error": "No identifier found."})
        return 200, {}, json.dumps(payload).encode()

    @property
    def job_counts(self) -> list[int]:
        return [len(jobs) for jobs in self.calls]

    @property
    def asked(self) -> list[str]:
        return [job["idValue"] for jobs in self.calls for job in jobs]


def record(value: str) -> dict:
    """One OpenFIGI record, shaped like the real response."""
    return {
        "figi": "BBG" + hashlib.sha256(value.encode()).hexdigest()[:9].upper(),
        "name": "NAMED SECURITY",
        "ticker": None,
        "exchCode": "US",
        "compositeFIGI": "BBG" + hashlib.sha256(b"C" + value.encode()).hexdigest()[:9].upper(),
        "shareClassFIGI": "BBG"
        + hashlib.sha256(b"S" + value.encode()).hexdigest()[:9].upper(),
        "securityType": "Common Stock",
        "securityType2": "Common Stock",
        "marketSector": "Equity",
    }


class Sleeps(list):
    """A recorded sleep: tests must never actually wait for a rate limit."""

    def __call__(self, seconds):
        self.append(round(seconds, 6))


def run_harvest(release, filings, transport, tmp_path, **overrides):
    kwargs = {
        "layer_dir": tmp_path / "layer",
        "cache_dir": tmp_path / "cache",
        "filing_cache": tmp_path / "filings-cache",
        "load_filing": lambda url, cache: filings[url],
        "transport": transport,
        "sleep": Sleeps(),
        "progress": None,
    }
    kwargs.update(overrides)
    sleeps = kwargs["sleep"]
    outcome = identifiers.harvest(release, **kwargs)
    return outcome, sleeps


@pytest.fixture(autouse=True)
def _no_ambient_api_key(monkeypatch):
    """Every test starts unauthenticated unless it says otherwise."""
    monkeypatch.delenv(identifiers.KEY_ENV, raising=False)


# --- ISIN validation: refuse before the network -----------------------------


def test_valid_isin_accepts_a_well_formed_value():
    assert identifiers.valid_isin(ISIN_ALPHA)
    assert identifiers.valid_isin(f"  {ISIN_ALPHA.lower()}  ")


@pytest.mark.parametrize(
    "candidate",
    ["", None, "XS", "XS00000001", CUSIP_SHAPED, LEI_SHAPED, "NOT AN ISIN", "XS0000000001"],
)
def test_valid_isin_rejects_blank_short_and_non_isin_values(candidate):
    assert identifiers.valid_isin(candidate) is False


def test_check_digit_completes_the_body_and_no_other_digit_does():
    body = "XS000000009"
    digit = identifiers.isin_check_digit(body)
    assert identifiers.valid_isin(body + digit)
    assert not any(identifiers.valid_isin(body + other) for other in "0123456789" if other != digit)


def test_a_row_whose_identifier_is_not_an_isin_never_reaches_the_network(tmp_path):
    release, filings, _values = many_isin_release(tmp_path, 3)
    # Replace a filed ISIN with a CUSIP-shaped value: it must be dropped and counted.
    filings[SOURCE_A].holdings[0] = holding(
        "Holding 0 Corp", value=100.0, identifier=CUSIP_SHAPED
    )
    transport = FakeOpenFIGI()
    outcome, _sleeps = run_harvest(release, filings, transport, tmp_path)
    assert all(identifiers.valid_isin(value) for value in transport.asked)
    assert CUSIP_SHAPED not in transport.asked
    index = identifiers.IsinIndex.from_document(
        identifiers._read_gzip_json(identifiers.index_path(tmp_path / "layer"))
    )
    assert index.distinct_isins == 2
    assert index.totals["no_isin_rows"] == 1
    assert index.totals["no_isin_bp"] == pytest.approx(10.0)


# --- batching --------------------------------------------------------------


def test_batch_splits_into_consecutive_groups():
    assert identifiers.batch(list(range(25)), 10) == [
        list(range(0, 10)),
        list(range(10, 20)),
        list(range(20, 25)),
    ]
    assert [len(group) for group in identifiers.batch(list(range(250)), 100)] == [
        100,
        100,
        50,
    ]


def test_default_batch_size_is_ten_unauthenticated_and_a_hundred_keyed():
    assert identifiers.default_jobs_per_request(False) == 10
    assert identifiers.default_jobs_per_request(True) == 100


def test_a_limited_batch_run_is_the_prefix_of_a_full_run():
    """A slice must not renumber the batches, or resuming it refetches everything."""
    values = [synthetic_isin(index) for index in range(1, 40)]
    full = identifiers.batch(values, 10)
    limited = identifiers.batch(values[:20], 10)
    assert limited == full[:2]


def test_harvest_batches_ten_jobs_unauthenticated(tmp_path):
    release, filings, _values = many_isin_release(tmp_path, 25)
    transport = FakeOpenFIGI()
    outcome, _sleeps = run_harvest(release, filings, transport, tmp_path)
    assert transport.job_counts == [10, 10, 5]
    assert outcome.batches_total == 3
    assert outcome.batches_requested == 3


def test_harvest_batches_a_hundred_jobs_with_a_key(tmp_path, monkeypatch):
    monkeypatch.setenv(identifiers.KEY_ENV, "test-key-not-a-real-one")
    release, filings, _values = many_isin_release(tmp_path, 25)
    transport = FakeOpenFIGI()
    outcome, _sleeps = run_harvest(release, filings, transport, tmp_path)
    assert transport.job_counts == [25]
    assert outcome.keyed is True
    assert transport.headers[0]["X-OPENFIGI-APIKEY"] == "test-key-not-a-real-one"


# --- pacing arithmetic -----------------------------------------------------


def test_interval_seconds_matches_the_published_rate_limits():
    assert identifiers.interval_seconds(25) == pytest.approx(2.4)
    assert identifiers.interval_seconds(250) == pytest.approx(0.24)
    assert identifiers.default_rpm(False) == 25
    assert identifiers.default_rpm(True) == 250


def test_interval_seconds_rejects_a_non_positive_rate():
    with pytest.raises(ValueError):
        identifiers.interval_seconds(0)


def test_throttle_waits_only_the_remainder_of_the_gap():
    now = [100.0]
    sleeps = Sleeps()
    throttle = identifiers.Throttle(2.4, clock=lambda: now[0], sleep=sleeps)
    assert throttle.wait() == 0.0  # the first request is immediate
    now[0] = 101.0
    assert throttle.wait() == pytest.approx(1.4)
    now[0] = 103.5  # the gap has already passed
    assert throttle.wait() == 0.0
    assert sleeps == [pytest.approx(1.4)]


def test_harvest_space_requests_at_the_unauthenticated_interval(tmp_path):
    release, filings, _values = many_isin_release(tmp_path, 25)
    transport = FakeOpenFIGI()
    _outcome, sleeps = run_harvest(release, filings, transport, tmp_path)
    # Three requests: the first is immediate, the next two wait a full 2.4 s gap.
    pacing = [value for value in sleeps if value == pytest.approx(2.4, abs=0.05)]
    assert len(pacing) == 2


# --- the request cache -----------------------------------------------------


def test_cache_key_is_the_documented_digest():
    body = identifiers._request_body([ISIN_ALPHA])
    expected = hashlib.sha256(body + b"/v3/mapping").hexdigest()
    assert identifiers.cache_key(body) == expected
    assert identifiers.cache_key(body) == identifiers.cache_key(body)


def test_cache_key_is_specific_to_the_request_body():
    first = identifiers.cache_key(identifiers._request_body([ISIN_ALPHA]))
    second = identifiers.cache_key(identifiers._request_body([ISIN_BETA]))
    assert first != second


def test_cache_path_shards_on_the_first_two_digest_characters_and_names_no_isin(tmp_path):
    key = identifiers.cache_key(identifiers._request_body([ISIN_ALPHA]))
    path = identifiers.cache_path(tmp_path, key)
    assert path.parent.name == key[:2]
    assert path.name == f"{key}.json"
    assert ISIN_ALPHA not in str(path)


def test_cache_round_trip_is_gzipped_json(tmp_path):
    key = identifiers.cache_key(identifiers._request_body([ISIN_ALPHA]))
    payload = json.dumps([{"data": [record(ISIN_ALPHA)]}]).encode()
    path = identifiers.write_cached_body(tmp_path, key, payload)
    assert path.suffix == ".json"
    assert gzip.decompress(path.read_bytes()) == payload
    assert identifiers.read_cached_body(tmp_path, key) == [{"data": [record(ISIN_ALPHA)]}]


def test_cache_miss_returns_none(tmp_path):
    assert identifiers.read_cached_body(tmp_path, "0" * 64) is None


def test_unreadable_cache_entry_raises_rather_than_pretending(tmp_path):
    key = "a" * 64
    path = identifiers.cache_path(tmp_path, key)
    path.parent.mkdir(parents=True)
    path.write_bytes(b"not gzip")
    with pytest.raises(identifiers.IdentifierError):
        identifiers.read_cached_body(tmp_path, key)


def test_the_api_key_never_changes_the_cache_key(tmp_path, monkeypatch):
    """The key is a header, not part of the request: the same batch is the same key.

    The batch size is held fixed with ``--jobs`` because gaining a key changes the
    default batch size, and a 10-job batch and a 100-job batch are genuinely different
    requests. That caveat is the reason this test pins the size rather than pretending
    switching modes is free.
    """
    release, filings, _values = many_isin_release(tmp_path, 15)
    first = FakeOpenFIGI()
    outcome_one, _ = run_harvest(
        release, filings, first, tmp_path, jobs_per_request=10
    )
    assert outcome_one.requests == 2

    monkeypatch.setenv(identifiers.KEY_ENV, "another-key")
    second = FakeOpenFIGI()
    outcome_two, _ = run_harvest(
        release, filings, second, tmp_path, jobs_per_request=10
    )
    assert outcome_two.keyed is True
    assert outcome_two.requests == 0
    assert second.calls == []


# --- resumability and --no-network ----------------------------------------


def test_a_second_harvest_over_a_warm_cache_issues_zero_requests(tmp_path):
    release, filings, _values = many_isin_release(tmp_path, 25)
    cold = FakeOpenFIGI()
    first, _ = run_harvest(release, filings, cold, tmp_path)
    assert first.requests == 3
    assert first.isins_resolved == 25

    warm = FakeOpenFIGI()
    second, _ = run_harvest(release, filings, warm, tmp_path)
    assert warm.calls == []
    assert second.requests == 0
    assert second.batches_cached == 3
    assert second.isins_resolved == first.isins_resolved


def test_no_network_reports_misses_instead_of_fetching(tmp_path):
    release, filings, _values = many_isin_release(tmp_path, 25)
    transport = FakeOpenFIGI()
    outcome, _sleeps = run_harvest(release, filings, transport, tmp_path, no_network=True)
    assert transport.calls == []
    assert outcome.requests == 0
    assert outcome.offline_misses == 3
    assert outcome.batches_total == 3


def test_no_network_with_a_warm_cache_reproduces_the_result(tmp_path):
    release, filings, _values = many_isin_release(tmp_path, 25)
    first, _ = run_harvest(release, filings, FakeOpenFIGI(), tmp_path)
    transport = FakeOpenFIGI()
    offline, _ = run_harvest(release, filings, transport, tmp_path, no_network=True)
    assert transport.calls == []
    assert offline.offline_misses == 0
    assert offline.batches_cached == first.batches_total
    assert offline.isins_resolved == first.isins_resolved


def test_limit_takes_the_prefix_of_the_harvest_order(tmp_path):
    release, filings, values = many_isin_release(tmp_path, 25)
    transport = FakeOpenFIGI()
    outcome, _ = run_harvest(release, filings, transport, tmp_path, limit=10)
    assert outcome.isins_selected == 10
    assert outcome.batches_total == 1
    expected = identifiers.harvest_order(values)[:10]
    assert sorted(transport.asked) == sorted(expected)


def test_harvest_order_is_content_addressed_not_country_ordered():
    values = [synthetic_isin(index) for index in range(1, 60)]
    forward = identifiers.harvest_order(values)
    reverse = identifiers.harvest_order(list(reversed(values)))
    assert forward == reverse
    assert forward != sorted(values)
    assert forward == sorted(
        values, key=lambda value: hashlib.sha256(value.encode()).hexdigest()
    )


# --- retry, failure and auth ----------------------------------------------


def test_a_429_honours_retry_after_and_then_succeeds(tmp_path):
    release, filings, values = many_isin_release(tmp_path, 5)
    transport = FakeOpenFIGI(script=[(429, {"retry-after": "7"}, b"")])
    outcome, sleeps = run_harvest(release, filings, transport, tmp_path)
    assert any(value == pytest.approx(7.0) for value in sleeps)
    assert outcome.requests == 2
    assert outcome.batches_failed == 0
    assert outcome.isins_resolved == len(values)
    assert outcome.stopped is None


def test_a_429_after_the_retry_budget_is_recorded_not_raised(tmp_path):
    release, filings, _values = many_isin_release(tmp_path, 5)
    transport = FakeOpenFIGI(
        script=[
            (429, {"retry-after": "1"}, b""),
            (429, {"retry-after": "1"}, b""),
            (429, {"retry-after": "1"}, b""),
        ]
    )
    outcome, sleeps = run_harvest(release, filings, transport, tmp_path)
    assert outcome.requests == identifiers.MAX_ATTEMPTS
    assert outcome.batches_failed == 1
    assert outcome.offline_misses == 0
    retry_sleeps = [value for value in sleeps if value == pytest.approx(1.0)]
    assert len(retry_sleeps) == identifiers.MAX_ATTEMPTS - 1


def test_a_permanent_server_error_is_recorded_and_the_run_continues(tmp_path):
    release, filings, _values = many_isin_release(tmp_path, 15)
    transport = FakeOpenFIGI(status=503)
    outcome, _sleeps = run_harvest(release, filings, transport, tmp_path)
    assert outcome.batches_failed == 2
    assert outcome.stopped is None
    assert outcome.isins_resolved == 0
    record = json.loads(identifiers.harvest_path(tmp_path / "layer").read_text())
    assert [entry["status"] for entry in record["batches"]] == ["failed", "failed"]
    assert all(entry["attempts"] == identifiers.MAX_ATTEMPTS for entry in record["batches"])


def test_a_failed_batch_is_retried_by_the_next_run(tmp_path):
    release, filings, _values = many_isin_release(tmp_path, 5)
    failing = FakeOpenFIGI(status=500)
    first, _ = run_harvest(release, filings, failing, tmp_path)
    assert first.batches_failed == 1

    recovering = FakeOpenFIGI()
    second, _ = run_harvest(release, filings, recovering, tmp_path)
    assert second.batches_requested == 1
    assert second.isins_resolved == 5


def test_an_auth_failure_stops_the_run_without_a_retry_storm(tmp_path):
    release, filings, _values = many_isin_release(tmp_path, 25)
    transport = FakeOpenFIGI(script=[(401, {}, b"")])
    outcome, _sleeps = run_harvest(release, filings, transport, tmp_path)
    assert outcome.stopped is not None
    assert "401" in outcome.stopped
    assert len(transport.calls) == 1
    assert outcome.batches_requested == 0


# --- the ISIN index -------------------------------------------------------


def test_the_index_takes_only_equity_debt_and_fund_rows(tmp_path):
    release, filings = two_fund_release(tmp_path)
    index = identifiers.build_isin_index(
        release,
        filing_cache=tmp_path / "filings",
        load_filing=lambda url, cache: filings[url],
    )
    assert index.totals["published_target_bp"] == pytest.approx(1_600.0)
    assert set(index.funds) == {"AAA", "BBB"}
    assert set(index.isin_category_bp) == {
        ISIN_ALPHA,
        ISIN_BETA,
        ISIN_GAMMA,
        ISIN_DELTA,
        ISIN_EPSILON,
        ISIN_THETA,
    }
    # The cash, derivative and mapped rows are not part of the gap.
    assert ISIN_MAPPED not in index.isin_bp
    assert index.isin_bp[ISIN_ALPHA] == pytest.approx(360.0)
    assert index.isin_category_bp[ISIN_DELTA] == {"debt": pytest.approx(400.0)}
    assert index.isin_category_bp[ISIN_EPSILON] == {"fund": pytest.approx(500.0)}


def test_the_index_reconciles_against_the_artifact(tmp_path):
    release, filings = two_fund_release(tmp_path)
    index = identifiers.build_isin_index(
        release,
        filing_cache=tmp_path / "filings",
        load_filing=lambda url, cache: filings[url],
    )
    published = index.totals["published_target_bp"]
    computed = index.totals["computed_bp"]
    assert computed == pytest.approx(published, abs=0.01)


def test_a_mapped_row_is_never_re_attributed_through_the_name_fallback():
    """The gap must not be inflated by a row that already has a company.

    The filing row's category differs from the unmapped row of the same name, which is
    exactly the case the uniqueness fallback exists for — and exactly the case that
    would re-import a mapped holding if the mapped name were not excluded first.
    """
    document = {
        "holdings": [
            published("Shared Name Co", weight_bp=100, asset_cat="debt"),
            published("Shared Name Co", weight_bp=250, company_id="c_0000000002"),
        ]
    }
    totals = {
        key: 0.0
        for key in (
            "computed_bp",
            "no_isin_bp",
            "no_isin_rows",
            "ambiguous_rows",
            "category_moved_rows",
        )
    }
    rows = identifiers._target_rows(
        document,
        filing([holding("Shared Name Co", value=2_500.0, identifier=ISIN_ALPHA)]),
        totals,
    )
    assert rows == []
    assert totals["computed_bp"] == 0.0


def test_the_index_round_trips_through_its_document(tmp_path):
    release, filings = two_fund_release(tmp_path)
    index = identifiers.build_isin_index(
        release,
        filing_cache=tmp_path / "filings",
        load_filing=lambda url, cache: filings[url],
    )
    restored = identifiers.IsinIndex.from_document(
        json.loads(json.dumps(index.to_document()))
    )
    assert restored.totals == pytest.approx(index.totals)
    assert restored.isin_bp == pytest.approx(index.isin_bp)
    assert set(restored.funds) == set(index.funds)


def test_the_stored_index_is_reused_for_the_same_release(tmp_path):
    release, filings = two_fund_release(tmp_path)
    calls = {"count": 0}

    def counting_loader(url, cache):
        calls["count"] += 1
        return filings[url]

    first = identifiers.load_or_build_index(
        release,
        tmp_path / "layer",
        filing_cache=tmp_path / "filings",
        load_filing=counting_loader,
    )
    assert calls["count"] == 2
    second = identifiers.load_or_build_index(
        release,
        tmp_path / "layer",
        filing_cache=tmp_path / "filings",
        load_filing=counting_loader,
    )
    assert calls["count"] == 2  # no new parses: the stored index was reused
    assert second.isin_bp == pytest.approx(first.isin_bp)


def test_a_fund_whose_filing_is_unreadable_still_counts_in_the_totals(tmp_path):
    release, _filings = two_fund_release(tmp_path)
    index = identifiers.build_isin_index(
        release,
        filing_cache=tmp_path / "filings",
        load_filing=lambda url, cache: (_ for _ in ()).throw(
            identifiers.OfflineMiss("not cached")
        ),
    )
    assert index.errors
    assert index.totals["published_target_bp"] == pytest.approx(1_600.0)
    assert index.distinct_isins == 0


# --- build: the map and the measurement -----------------------------------


def build_from(release, filings, transport, tmp_path, **overrides):
    outcome, _sleeps = run_harvest(release, filings, transport, tmp_path, **overrides)
    built = identifiers.build(
        release, layer_dir=tmp_path / "layer", cache_dir=tmp_path / "cache"
    )
    return outcome, built


def test_build_maps_exactly_the_eight_documented_fields(tmp_path):
    release, filings = two_fund_release(tmp_path)
    _outcome, built = build_from(release, filings, FakeOpenFIGI(), tmp_path)
    assert set(built.isin_map) == {
        ISIN_ALPHA,
        ISIN_BETA,
        ISIN_GAMMA,
        ISIN_DELTA,
        ISIN_EPSILON,
        ISIN_THETA,
    }
    assert set(built.isin_map[ISIN_ALPHA]) == set(identifiers.ISIN_MAP_FIELDS)
    assert built.isin_map[ISIN_ALPHA]["market_sector"] == "Equity"
    assert built.isin_map[ISIN_ALPHA]["security_type"] == "Common Stock"
    assert built.isin_map[ISIN_ALPHA]["figi"].startswith("BBG")


def test_build_omits_an_isin_openfigi_did_not_name(tmp_path):
    release, filings = two_fund_release(tmp_path)
    _outcome, built = build_from(
        release, filings, FakeOpenFIGI(resolved={ISIN_ALPHA, ISIN_BETA}), tmp_path
    )
    assert set(built.isin_map) == {ISIN_ALPHA, ISIN_BETA}
    assert built.measurement["isins_in_map"] == 2


def test_build_refuses_without_a_harvest_record(tmp_path):
    release, _filings = two_fund_release(tmp_path)
    with pytest.raises(identifiers.IdentifierError):
        identifiers.build(
            release, layer_dir=tmp_path / "empty", cache_dir=tmp_path / "cache"
        )


def test_the_measurement_is_hand_calculable(tmp_path):
    """One resolved ISIN of 360 bp inside a 1,600 bp gap, 700 bp of it equity.

    Hand arithmetic: 360 / 1,600 = 22.5% of the gap; 360 / 700 = 51.43% of the equity
    asked; 300 / 600 = 50.0% for fund AAA and 60 / 100 = 60.0% for fund BBB.
    """
    release, filings = two_fund_release(tmp_path)
    _outcome, built = build_from(
        release, filings, FakeOpenFIGI(resolved={ISIN_ALPHA}), tmp_path
    )
    measured = built.measurement
    assert measured["published_target_bp"] == pytest.approx(1_600.0)
    assert measured["asked_bp"] == pytest.approx(1_600.0)
    assert measured["resolved_bp"] == pytest.approx(360.0)
    assert measured["resolved_pct_of_asked"] == pytest.approx(22.5)
    assert measured["resolved_pct_of_unmapped"] == pytest.approx(22.5)
    assert measured["by_category"]["equity"]["resolved_pct_of_asked"] == pytest.approx(51.43)
    assert measured["by_category"]["debt"]["resolved_bp"] == pytest.approx(0.0)
    assert measured["funds_with_resolution"] == 2
    assert measured["by_market_sector"] == [
        {"key": "Equity", "bp": pytest.approx(360.0), "pct_of_resolved": 100.0, "isins": 1}
    ]
    assert measured["by_security_type"][0]["key"] == "Common Stock"
    # The equity ranking exists separately because total weight is bond-dominated.
    assert [row["ticker"] for row in measured["top_funds_equity"]] == ["AAA", "BBB"]
    assert measured["top_funds_equity"][0]["resolved_equity_bp"] == pytest.approx(300.0)
    per_fund = {row["ticker"]: row for row in measured["per_fund"]}
    # AAA: 300 of 1,500 asked overall (20.0%), but 300 of its 600 bp of equity (50.0%).
    assert per_fund["AAA"]["resolved_pct_of_asked"] == pytest.approx(20.0)
    assert per_fund["AAA"]["equity_resolved_pct_of_equity_asked"] == pytest.approx(50.0)
    assert per_fund["AAA"]["unmapped_equity_bp"] == pytest.approx(600.0)
    assert per_fund["AAA"]["resolved_equity_bp"] == pytest.approx(300.0)
    assert per_fund["BBB"]["resolved_pct_of_asked"] == pytest.approx(60.0)
    assert per_fund["BBB"]["equity_resolved_pct_of_equity_asked"] == pytest.approx(60.0)


def test_a_slice_reports_what_was_asked_not_the_whole_corpus_as_asked(tmp_path):
    """A 3-ISIN slice must not claim the 6-ISIN corpus as its denominator.

    With ``--limit 3`` only three of six ISINs are asked. Resolved weight stays
    whatever resolved, but ``asked_bp`` must be the weight of those three, so
    ``resolved_pct_of_asked`` is a rate and ``projected_bp`` can be an estimate.
    """
    release, filings = two_fund_release(tmp_path)
    outcome, _ = run_harvest(release, filings, FakeOpenFIGI(), tmp_path, limit=3)
    built = identifiers.build(
        release, layer_dir=tmp_path / "layer", cache_dir=tmp_path / "cache"
    )
    measured = built.measurement
    assert outcome.isins_selected == 3
    assert measured["jobs_asked"] == 3
    assert measured["asked_bp"] < measured["covered_bp"]
    assert measured["covered_bp"] == pytest.approx(1_600.0)
    assert measured["resolved_pct_of_asked"] == pytest.approx(100.0)
    assert measured["resolved_pct_of_unmapped"] == pytest.approx(
        measured["asked_bp"] / 1_600.0 * 100.0, abs=0.01
    )
    assert measured["projected_bp"] == pytest.approx(1_600.0, abs=0.01)
    # Whether a given slice touches a given fund depends on the hash order, so the
    # invariant is what is asserted: a percentage exists exactly when a denominator
    # does, and an unasked fund is never rendered as a 0% fund.
    for row in measured["per_fund"]:
        assert (row["resolved_pct_of_asked"] is None) == (row["asked_bp"] == 0)
        assert (row["equity_resolved_pct_of_equity_asked"] is None) == (
            row["asked_equity_bp"] == 0
        )
    assert measured["funds_asked"] <= 2


def test_the_measurement_says_a_security_is_not_a_company(tmp_path):
    release, filings = two_fund_release(tmp_path)
    _outcome, built = build_from(release, filings, FakeOpenFIGI(), tmp_path)
    assert "NAMED SECURITY, NOT A COMPANY" in built.report
    assert "not a company" in built.measurement["note"].lower()
    assert "company coverage" in built.measurement["note"]


def test_build_writes_byte_identical_output_twice(tmp_path):
    release, filings = two_fund_release(tmp_path)
    run_harvest(release, filings, FakeOpenFIGI(), tmp_path)
    first = identifiers.build(
        release, layer_dir=tmp_path / "layer", cache_dir=tmp_path / "cache"
    )
    map_bytes = identifiers.isin_map_path(tmp_path / "layer").read_bytes()
    measurement_bytes = identifiers.measurement_path(tmp_path / "layer").read_bytes()
    second = identifiers.build(
        release, layer_dir=tmp_path / "layer", cache_dir=tmp_path / "cache"
    )
    assert first.isin_map == second.isin_map
    assert identifiers.isin_map_path(tmp_path / "layer").read_bytes() == map_bytes
    assert (
        identifiers.measurement_path(tmp_path / "layer").read_bytes()
        == measurement_bytes
    )


def test_the_same_cache_rebuilds_the_same_map_elsewhere(tmp_path):
    """The map is a function of the index and the response cache, not of the clock."""
    release, filings = two_fund_release(tmp_path)
    run_harvest(release, filings, FakeOpenFIGI(), tmp_path)
    identifiers.build(release, layer_dir=tmp_path / "layer", cache_dir=tmp_path / "cache")
    original = identifiers.isin_map_path(tmp_path / "layer").read_bytes()

    second = tmp_path / "layer-two"
    second.mkdir()
    for name in ("isin_index.json.gz", "harvest.json"):
        (second / name).write_bytes((tmp_path / "layer" / name).read_bytes())
    identifiers.build(release, layer_dir=second, cache_dir=tmp_path / "cache")
    assert identifiers.isin_map_path(second).read_bytes() == original


def test_the_map_is_written_with_sorted_keys(tmp_path):
    release, filings = two_fund_release(tmp_path)
    _outcome, _built = build_from(release, filings, FakeOpenFIGI(), tmp_path)
    text = identifiers.isin_map_path(tmp_path / "layer").read_text()
    parsed = json.loads(text)
    assert list(parsed) == sorted(parsed)
    assert text.endswith("\n")


def test_a_missing_cached_batch_is_reported_in_the_measurement(tmp_path):
    release, filings = two_fund_release(tmp_path)
    run_harvest(release, filings, FakeOpenFIGI(), tmp_path)
    for path in (tmp_path / "cache").rglob("*.json"):
        path.unlink()
    built = identifiers.build(
        release, layer_dir=tmp_path / "layer", cache_dir=tmp_path / "cache"
    )
    assert built.measurement["isins_in_map"] == 0
    assert built.isin_map == {}


# --- the compliance rule: no identifier in anything printed ----------------


def _assert_no_identifiers(text: str, *, forbidden: list[str]) -> None:
    for value in forbidden:
        assert value not in text, f"an identifier leaked: {value[:2]}…"
    assert not ISIN_TEXT_RE.findall(text), f"ISIN-shaped token in output: {ISIN_TEXT_RE.findall(text)}"
    assert not CUSIP_TEXT_RE.findall(text), "CUSIP-shaped token in output"
    assert not LEI_TEXT_RE.findall(text), "LEI-shaped token in output"


def test_harvest_and_build_print_no_identifier(tmp_path, capsys, monkeypatch):
    release, filings = two_fund_release(tmp_path)
    monkeypatch.setattr(identifiers, "http_transport", FakeOpenFIGI())
    monkeypatch.setattr(
        identifiers, "load_nport_filing", lambda url, cache: filings[url]
    )
    common = [
        "--release",
        str(release),
        "--layer-dir",
        str(tmp_path / "layer"),
        "--cache-dir",
        str(tmp_path / "cache"),
    ]
    assert identifiers.main(["harvest", *common]) == 0
    assert identifiers.main(["build", *common]) == 0
    captured = capsys.readouterr()
    forbidden = [
        ISIN_ALPHA,
        ISIN_BETA,
        ISIN_GAMMA,
        ISIN_DELTA,
        ISIN_EPSILON,
        ISIN_THETA,
        CUSIP_SHAPED,
        LEI_SHAPED,
    ]
    _assert_no_identifiers(captured.out + captured.err, forbidden=forbidden)


def test_the_api_key_is_never_printed(tmp_path, capsys, monkeypatch):
    # Short and obviously fake on purpose: the repo's pre-commit guard reads a long
    # literal beside a key-ish name as a credential, and a guard that cries wolf is a
    # guard people learn to bypass.
    stub_key = "stub-key"
    monkeypatch.setenv(identifiers.KEY_ENV, stub_key)
    release, filings = two_fund_release(tmp_path)
    monkeypatch.setattr(identifiers, "http_transport", FakeOpenFIGI())
    monkeypatch.setattr(
        identifiers, "load_nport_filing", lambda url, cache: filings[url]
    )
    assert (
        identifiers.main(
            [
                "harvest",
                "--release",
                str(release),
                "--layer-dir",
                str(tmp_path / "layer"),
                "--cache-dir",
                str(tmp_path / "cache"),
            ]
        )
        == 0
    )
    captured = capsys.readouterr()
    assert stub_key not in captured.out + captured.err
    assert "harvest: keyed" in captured.out


def test_the_cli_reports_unauthenticated_without_a_key(tmp_path, capsys, monkeypatch):
    release, filings = two_fund_release(tmp_path)
    monkeypatch.setattr(identifiers, "http_transport", FakeOpenFIGI())
    monkeypatch.setattr(
        identifiers, "load_nport_filing", lambda url, cache: filings[url]
    )
    identifiers.main(
        [
            "harvest",
            "--release",
            str(release),
            "--layer-dir",
            str(tmp_path / "layer"),
            "--cache-dir",
            str(tmp_path / "cache"),
        ]
    )
    captured = capsys.readouterr()
    assert "unauthenticated (25 req/min, 10 jobs/request)" in captured.out


def test_offline_harvest_exits_nonzero_when_the_cache_cannot_answer(
    tmp_path, capsys, monkeypatch
):
    release, filings = two_fund_release(tmp_path)
    monkeypatch.setattr(identifiers, "http_transport", FakeOpenFIGI())
    monkeypatch.setattr(
        identifiers, "load_nport_filing", lambda url, cache: filings[url]
    )
    code = identifiers.main(
        [
            "harvest",
            "--release",
            str(release),
            "--layer-dir",
            str(tmp_path / "layer"),
            "--cache-dir",
            str(tmp_path / "cache"),
            "--no-network",
        ]
    )
    assert code == 1
    assert "not in the cache" in capsys.readouterr().err


def test_the_whole_320k_corpus_projection_matches_the_measurement_note():
    """31,039 unauthenticated requests ≈ 20.7 h; 3,104 keyed ≈ 12.4 min.

    The same two numbers the research note derived by hand (§7), reproduced from the
    pacing constants — so a change to the rate limits cannot pass unnoticed.
    """
    line = identifiers._projection(310_386)
    assert "31,039 requests unauthenticated ≈ 20.7 h" in line
    assert "3,104 requests keyed ≈ 12.4 min" in line
