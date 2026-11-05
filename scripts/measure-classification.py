#!/usr/bin/env python3
"""Measure the country-classification migration on a built release.

Reads only published artifacts — `companies/countries.json`, `catalogue.json` and
`funds/{TICKER}.json` — and prints, for **both** providers in the generated table
(`MSCI`, the default, and `FTSE`):

* the three-segment split of the placed base, in basis points and as a share of it;
* the per-country table: code, tier, bucket, weight, share, company count;
* where each basis point was placed (decided country, contested map, the row's own
  `filed_country`), and the weight excluded as cash or derivative;
* the companies whose bucket differs between the two providers, with the weight
  that moves.

The placement rule is the fund page's own (`fund_pages.market_split`), restated here
with the provider as a parameter because the page prints one convention and this
script has to print two. The restatement is not trusted: every fund is also run
through `market_split` and the MSCI totals are compared, so a drift between this
script and the page fails loudly instead of producing a second opinion.

Usage:
    python scripts/measure-classification.py [RELEASE]
    python scripts/measure-classification.py --funds AVGV,VT,AVES,AVDV,AVIV,AVUV,AVLV,AVMV

No network, no writes. Company names and `company_id` only — never an identifier
value (invariant I1).
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "pipeline"))

from pipeline import classification_generated, fund_pages  # noqa: E402

DEFAULT_RELEASE = "artifacts/releases/2026-11-05.1"

#: The bar's three segments, in draw order, and the words for each.
SEGMENTS = fund_pages.TIERS

#: The five tiers the table carries, shortened for a column.
TIER_WORDS = {
    "DEVELOPED": "Developed",
    "EMERGING": "Emerging",
    "FRONTIER": "Frontier",
    "STANDALONE": "Standalone",
    "UNCLASSIFIED": "Unclassified",
}

#: The providers this script compares, default first.
PROVIDERS = ("MSCI", "FTSE")


def pct(part: int, whole: int) -> float:
    return part * 100.0 / whole if whole else 0.0


def load_release(release: Path) -> tuple[dict[str, str], dict[str, str], list[str]]:
    """The decided map, the contested map, and the tickers the release publishes."""
    countries = json.loads((release / "companies/countries.json").read_text())
    decided = countries.get("companies") or {}
    contested = countries.get("contested") or {}
    catalogue = json.loads((release / "catalogue.json").read_text())["funds"]
    tickers = [t for t in catalogue if fund_pages.SAFE_TICKER.match(t)]
    return decided, contested, tickers


def walk(
    release: Path,
    decided: dict[str, str],
    contested: dict[str, str],
    tickers: list[str],
) -> dict:
    """One pass over every published row, accumulating both providers at once.

    The placed base is provider-independent: a row is placed when the release has a
    country for it, and `tier_of` returns `None` only when there is no country at all.
    So the denominator cannot move between providers — only the split of it can, which
    is the property the whole measurement rests on.
    """
    totals = {p: {key: 0 for key, _ in SEGMENTS} for p in PROVIDERS}
    placed_bp = 0
    unplaced_bp = 0
    unplaced_companies: set[str] = set()

    by_country: dict[str, int] = defaultdict(int)
    country_companies: dict[str, set[str]] = defaultdict(set)

    company_weight: dict[str, int] = defaultdict(int)
    company_name: dict[str, str] = {}
    company_country: dict[str, str] = {}

    methods: dict[str, dict] = {
        "decided": {"bp": 0, "companies": set()},
        "contested": {"bp": 0, "companies": set()},
        "filed_country": {"bp": 0, "companies": set(), "rows": 0},
        "unplaced": {"bp": 0, "companies": set()},
    }
    excluded = {"cash": 0, "derivative": 0}
    negative_bp = 0
    rows_total = 0
    funds_read = 0
    funds_missing = 0

    per_fund: dict[str, dict] = {}

    for ticker in tickers:
        path = release / "funds" / f"{ticker}.json"
        if not path.exists():
            funds_missing += 1
            continue
        fund = json.loads(path.read_text())
        rows = fund.get("holdings") or []
        funds_read += 1
        rows_total += len(rows)

        fund_totals = {p: {key: 0 for key, _ in SEGMENTS} for p in PROVIDERS}
        fund_placed = 0
        fund_unplaced = 0

        for row in rows:
            weight = int(row.get("weight_bp") or 0)
            if weight <= 0:
                # The page's rule: a short is not placed in a market, and a zero row
                # is not a position. Counted so the doc can say how much is outside.
                if weight < 0:
                    negative_bp += -weight
                continue
            company_id = row.get("company_id")
            if company_id:
                country = decided.get(company_id) or contested.get(company_id)
                if decided.get(company_id):
                    method = "decided"
                elif contested.get(company_id):
                    method = "contested"
                else:
                    method = "unplaced"
            elif row.get("asset_cat") in ("cash", "derivative"):
                excluded[row["asset_cat"]] += weight
                continue
            else:
                country = row.get("filed_country")
                method = "filed_country" if country else "unplaced"

            if not country:
                unplaced_bp += weight
                fund_unplaced += weight
                methods["unplaced"]["bp"] += weight
                if company_id:
                    unplaced_companies.add(company_id)
                    methods["unplaced"]["companies"].add(company_id)
                continue

            code = country.strip().upper()
            placed_bp += weight
            fund_placed += weight
            by_country[code] += weight
            if company_id:
                country_companies[code].add(company_id)
                company_weight[company_id] += weight
                company_name.setdefault(company_id, row.get("name") or company_id)
                company_country[company_id] = code
                methods[method]["companies"].add(company_id)
            else:
                methods["filed_country"]["rows"] += 1
            methods[method]["bp"] += weight

            for provider in PROVIDERS:
                key = classification_generated.tier_of(code, provider=provider)
                # `tier_of` is total over every code, so a placed row always lands.
                totals[provider][key] += weight
                fund_totals[provider][key] += weight

        per_fund[ticker] = {
            "totals": fund_totals,
            "placed": fund_placed,
            "unplaced": fund_unplaced,
            "coverage_pct": fund.get("coverage_pct"),
            "name": fund.get("name"),
        }

    return {
        "totals": totals,
        "placed_bp": placed_bp,
        "unplaced_bp": unplaced_bp,
        "unplaced_companies": unplaced_companies,
        "by_country": by_country,
        "country_companies": country_companies,
        "company_weight": company_weight,
        "company_name": company_name,
        "company_country": company_country,
        "methods": methods,
        "excluded": excluded,
        "negative_bp": negative_bp,
        "rows_total": rows_total,
        "funds_read": funds_read,
        "funds_missing": funds_missing,
        "per_fund": per_fund,
    }


def cross_check(release: Path, decided, contested, tickers, data) -> list[str]:
    """Run every fund through the page's own `market_split` and compare the MSCI side.

    This is the check that makes the restatement safe: if the page's rule and this
    script's rule ever disagree, the numbers below are not the numbers the site shows.
    """
    problems: list[str] = []
    for ticker in tickers:
        path = release / "funds" / f"{ticker}.json"
        if not path.exists():
            continue
        rows = json.loads(path.read_text()).get("holdings") or []
        split = fund_pages.market_split(rows, decided, contested)
        mine = data["per_fund"][ticker]
        if split.placed_bp != mine["placed"]:
            problems.append(f"{ticker}: placed {split.placed_bp} vs {mine['placed']}")
            continue
        page = {segment.key: segment.weight_bp for segment in split.segments}
        for key, _label in SEGMENTS:
            if page.get(key, 0) != mine["totals"]["MSCI"][key]:
                problems.append(
                    f"{ticker}: {key} {page.get(key, 0)} vs {mine['totals']['MSCI'][key]}"
                )
    return problems


def print_split(data: dict) -> None:
    placed = data["placed_bp"]
    print("=== three-segment split of the placed base ===")
    print(f"  placed base: {placed:,} bp   (unplaced {data['unplaced_bp']:,} bp, "
          f"{len(data['unplaced_companies']):,} companies)")
    print()
    header = f"  {'segment':<32}" + "".join(f"{p:>22}" for p in PROVIDERS)
    print(header)
    for key, label in SEGMENTS:
        cells = ""
        for provider in PROVIDERS:
            weight = data["totals"][provider][key]
            cells += f"{weight:>12,} bp {pct(weight, placed):>6.2f}%"
        print(f"  {label:<32}{cells}")
    print(f"  {'sum of the three':<32}" + "".join(
        f"{sum(data['totals'][p].values()):>12,} bp "
        f"{pct(sum(data['totals'][p].values()), placed):>6.2f}%" for p in PROVIDERS
    ))
    print()
    print("  delta (FTSE − MSCI):")
    for key, label in SEGMENTS:
        delta = data["totals"]["FTSE"][key] - data["totals"]["MSCI"][key]
        print(f"    {label:<30} {delta:>+12,} bp  {pct(delta, placed):>+6.2f} pt")


def print_countries(data: dict) -> None:
    placed = data["placed_bp"]
    print()
    print("=== per country (both providers) ===")
    print(f"  {'code':<5}{'MSCI tier':<13}{'MSCI':<5}{'FTSE tier':<13}{'FTSE':<5}"
          f"{'weight bp':>12}{'% placed':>10}{'companies':>11}")
    for code, weight in sorted(data["by_country"].items(), key=lambda kv: (-kv[1], kv[0])):
        m_tier = classification_generated.market_tier_of(code, provider="MSCI")
        f_tier = classification_generated.market_tier_of(code, provider="FTSE")
        m_bucket = classification_generated.tier_of(code, provider="MSCI")
        f_bucket = classification_generated.tier_of(code, provider="FTSE")
        mark = " *" if m_bucket != f_bucket else ""
        print(f"  {code:<5}{TIER_WORDS.get(m_tier, m_tier):<13}{m_bucket:<5}"
              f"{TIER_WORDS.get(f_tier, f_tier):<13}{f_bucket:<5}"
              f"{weight:>12,}{pct(weight, placed):>9.2f}%"
              f"{len(data['country_companies'][code]):>11,}{mark}")
    print("  * bucket differs between the providers")


def print_methods(data: dict) -> None:
    placed = data["placed_bp"]
    print()
    print("=== where each basis point was placed ===")
    for name, label in (
        ("decided", "decided country (vote)"),
        ("contested", "contested map"),
        ("filed_country", "row filed_country"),
        ("unplaced", "no country at all"),
    ):
        entry = data["methods"][name]
        companies = len(entry["companies"])
        rows = f", {entry['rows']:,} rows" if entry.get("rows") else ""
        print(f"  {label:<26}{entry['bp']:>12,} bp  {pct(entry['bp'], placed):>6.2f}%"
              f"  {companies:>6,} companies{rows}")
    print(f"  {'cash (excluded)':<26}{data['excluded']['cash']:>12,} bp")
    print(f"  {'derivative (excluded)':<26}{data['excluded']['derivative']:>12,} bp")
    print(f"  {'short rows (not placed)':<26}{data['negative_bp']:>12,} bp")
    print(f"  rows read: {data['rows_total']:,} across {data['funds_read']:,} funds"
          + (f" ({data['funds_missing']:,} catalogue entries had no file)"
             if data["funds_missing"] else ""))


def moved_weight(data: dict) -> tuple[int, int]:
    """The weight whose bucket changes, and the part of it that names a company.

    Two numbers, because they are not the same and the difference is a real part of
    the release: a row placed by its own filing's `filed_country` has no company to
    name, so it moves with its country and never appears in a company table. Reporting
    only the company part would understate the migration by that much.
    """
    total = sum(
        weight
        for code, weight in data["by_country"].items()
        if classification_generated.tier_of(code, provider="MSCI")
        != classification_generated.tier_of(code, provider="FTSE")
    )
    named = sum(
        weight
        for company_id, weight in data["company_weight"].items()
        if classification_generated.tier_of(
            data["company_country"][company_id], provider="MSCI"
        ) != classification_generated.tier_of(
            data["company_country"][company_id], provider="FTSE"
        )
    )
    return total, named


def print_movers(data: dict, top: int) -> None:
    placed = data["placed_bp"]
    movers = [
        (company_id, weight)
        for company_id, weight in data["company_weight"].items()
        if classification_generated.tier_of(
            data["company_country"][company_id], provider="MSCI"
        ) != classification_generated.tier_of(
            data["company_country"][company_id], provider="FTSE"
        )
    ]
    movers.sort(key=lambda item: (-item[1], data["company_name"][item[0]].upper()))
    total, named = moved_weight(data)
    print()
    print(f"=== companies whose bucket differs between the providers "
          f"(top {top} of {len(movers):,}) ===")
    print(f"  weight that moves: {total:,} bp  ({pct(total, placed):.2f}% of the "
          f"placed base)")
    print(f"    of which named companies: {named:,} bp; rows placed by their filing's "
          f"own country: {total - named:,} bp")
    print(f"  {'company_id':<19}{'name':<44}{'ctry':<5}{'MSCI':<5}{'FTSE':<5}"
          f"{'weight bp':>12}{'% placed':>10}")
    for company_id, weight in movers[:top]:
        code = data["company_country"][company_id]
        name = data["company_name"][company_id]
        if len(name) > 42:
            name = name[:41] + "…"
        print(f"  {company_id:<19}{name:<44}{code:<5}"
              f"{classification_generated.tier_of(code, provider='MSCI'):<5}"
              f"{classification_generated.tier_of(code, provider='FTSE'):<5}"
              f"{weight:>12,}{pct(weight, placed):>9.2f}%")


def print_funds(data: dict, tickers: list[str]) -> None:
    print()
    print("=== golden funds, both providers ===")
    print(f"  {'ticker':<8}{'placed bp':>11}{'unplaced':>10}"
          + "".join(f"{p + ' US':>9}{p + ' DM':>9}{p + ' EM':>9}" for p in PROVIDERS))
    for ticker in tickers:
        fund = data["per_fund"].get(ticker)
        if fund is None:
            print(f"  {ticker:<8}  not in this release")
            continue
        placed = fund["placed"]
        cells = ""
        for provider in PROVIDERS:
            for key, _label in SEGMENTS:
                cells += f"{pct(fund['totals'][provider][key], placed):>8.2f}%"
        print(f"  {ticker:<8}{placed:>11,}{fund['unplaced']:>10,}{cells}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("release", nargs="?", default=DEFAULT_RELEASE,
                        help=f"release directory (default {DEFAULT_RELEASE})")
    parser.add_argument("--funds", default="",
                        help="comma-separated tickers for the per-fund table")
    parser.add_argument("--top", type=int, default=25,
                        help="how many moving companies to list (default 25)")
    args = parser.parse_args(argv)

    release = Path(args.release)
    if not release.is_absolute():
        release = REPO_ROOT / release
    if not (release / "companies/countries.json").exists():
        print(f"not a release directory: {release}", file=sys.stderr)
        return 2

    decided, contested, tickers = load_release(release)
    data = walk(release, decided, contested, tickers)

    print(f"release: {release.name}   classification as_of: "
          f"{classification_generated.TIER_AS_OF}   "
          f"default provider: {classification_generated.DEFAULT_PROVIDER}")
    print(f"companies: {len(decided):,} decided, {len(contested):,} contested   "
          f"funds: {data['funds_read']:,}")
    print()

    print_split(data)
    print_countries(data)
    print_methods(data)
    print_movers(data, args.top)
    moved_bp, named_bp = moved_weight(data)

    if args.funds:
        print_funds(data, [t.strip().upper() for t in args.funds.split(",") if t.strip()])

    problems = cross_check(release, decided, contested, tickers, data)
    print()
    if problems:
        print(f"cross-check vs fund_pages.market_split: {len(problems)} MISMATCH(ES)")
        for problem in problems[:10]:
            print(f"  {problem}")
        return 1
    print("cross-check vs fund_pages.market_split: OK "
          f"({data['funds_read']:,} funds, MSCI side identical)")

    # The invariant the deploy rests on: the three segments are the placed base.
    for provider in PROVIDERS:
        total = sum(data["totals"][provider].values())
        if total != data["placed_bp"]:
            print(f"segments do not sum to the placed base under {provider}: "
                  f"{total:,} vs {data['placed_bp']:,}")
            return 1
    print(f"segments sum to the placed base under both providers: OK "
          f"({data['placed_bp']:,} bp)")

    # Every basis point of positive weight is in exactly one of these four places.
    positive = (data["placed_bp"] + data["unplaced_bp"]
                + data["excluded"]["cash"] + data["excluded"]["derivative"])
    print(f"reconciliation: placed {data['placed_bp']:,} + unplaced "
          f"{data['unplaced_bp']:,} + cash {data['excluded']['cash']:,} + derivative "
          f"{data['excluded']['derivative']:,} = {positive:,} bp of positive weight "
          f"(+ {data['negative_bp']:,} bp of shorts, not placed)")

    print(f"weight that moves between the providers: {moved_bp:,} bp "
          f"({pct(moved_bp, data['placed_bp']):.2f}% of the placed base), "
          f"{named_bp:,} bp of it in named companies")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
