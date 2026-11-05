#!/usr/bin/env python3
"""Generate the two classification modules from ``classification/classification.json``.

The JSON is the source of truth: one file, both providers, effective-dated rows, and
git history as the audit trail. Two consumers need it and neither can read the other's
language — the browser bundle is TypeScript and the fund-page generator is Python — so
this script emits both from the one file rather than letting two hand-maintained tables
drift apart.

    python scripts/gen_classification.py            # write both modules
    python scripts/gen_classification.py --check    # exit 1 if either is stale

``--check`` is the gate a human runs; the drift tests in ``web/lib/classification.test.ts``
and ``pipeline/tests/test_classification_generated.py`` are the gate CI runs, and they
compare the emitted tables against the JSON directly rather than trusting a hash.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SOURCE = REPO_ROOT / "classification" / "classification.json"
TS_OUT = REPO_ROOT / "web" / "lib" / "classification.generated.ts"
PY_OUT = REPO_ROOT / "pipeline" / "pipeline" / "classification_generated.py"

TIERS = ("DEVELOPED", "EMERGING", "FRONTIER", "STANDALONE", "UNCLASSIFIED")
BUCKETS = ("US", "DM", "EM")

BANNER = (
    "GENERATED FILE — do not edit by hand.\n"
    "Source: classification/classification.json\n"
    "Regenerate: python scripts/gen_classification.py"
)


def load() -> dict:
    return json.loads(SOURCE.read_text())


def _rows(document: dict, provider: str) -> list[tuple[str, str, str | None, str, str]]:
    """``(iso2, effective_from, effective_to, tier, provider_label)``, sorted."""
    out = []
    for row in document["providers"][provider]["rows"]:
        tier = row["tier"]
        if tier not in TIERS:
            raise SystemExit(f"{provider} {row['iso2']}: unknown tier {tier!r}")
        out.append(
            (
                row["iso2"],
                row["effective_from"],
                row.get("effective_to"),
                tier,
                row.get("provider_label") or tier.title(),
            )
        )
    out.sort(key=lambda r: (r[0], r[1]))
    return out


def _check_no_overlap(document: dict) -> None:
    """Two rows for one ``(provider, iso2)`` may not cover the same day."""
    for provider in document["providers"]:
        spans: dict[str, list[tuple[str, str | None]]] = {}
        for iso2, start, end, _tier, _label in _rows(document, provider):
            spans.setdefault(iso2, []).append((start, end))
        for iso2, windows in spans.items():
            windows.sort()
            for (start, end), (next_start, _next_end) in zip(windows, windows[1:]):
                if end is None or end > next_start:
                    raise SystemExit(
                        f"{provider} {iso2}: {start}..{end} overlaps {next_start}"
                    )


def _ts_string(value: str) -> str:
    return json.dumps(value)


def render_ts(document: dict) -> str:
    providers = list(document["providers"])
    default = next(p for p in providers if document["providers"][p]["is_default"])
    lines: list[str] = []
    add = lines.append

    add("// " + BANNER.replace("\n", "\n// "))
    add("")
    add("/** Which publisher's country classification a view is using. */")
    add("export type Provider = " + " | ".join(_ts_string(p) for p in providers) + ";")
    add("")
    add("/** The provider's own tier for a domicile. */")
    add("export type MarketTier = " + " | ".join(_ts_string(t) for t in TIERS) + ";")
    add("")
    add("/** The three segments the Markets bar draws. */")
    add("export type CountryTier = " + " | ".join(_ts_string(b) for b in BUCKETS) + ";")
    add("")
    add("/** The vintage of the classification below. */")
    add(f"export const TIER_AS_OF = {_ts_string(document['as_of'])};")
    add("")
    add("/** The provider a view uses when the reader has not chosen one. */")
    add(f"export const DEFAULT_PROVIDER: Provider = {_ts_string(default)};")
    add("")
    add("/** Every provider, in the order the toggle shows them. */")
    add("export const PROVIDERS: readonly Provider[] = [")
    for provider in providers:
        add(f"  {_ts_string(provider)},")
    add("];")
    add("")
    add("/** The name to print for a provider. */")
    add("export const PROVIDER_NAMES: Readonly<Record<Provider, string>> = {")
    for provider in providers:
        add(f"  {_ts_string(provider)}: {_ts_string(document['providers'][provider]['name'])},")
    add("};")
    add("")
    add("/** The attribution line a page prints beside the split. */")
    add("export const PROVIDER_LABELS: Readonly<Record<Provider, string>> = {")
    for provider in providers:
        add(f"  {_ts_string(provider)}: {_ts_string(document['providers'][provider]['label'])},")
    add("};")
    add("")
    add("/** Where a reader can check the provider's own published classification. */")
    add("export const PROVIDER_SOURCE_URLS: Readonly<Record<Provider, string>> = {")
    for provider in providers:
        add(f"  {_ts_string(provider)}: {_ts_string(document['providers'][provider]['source_url'])},")
    add("};")
    add("")
    add("/**")
    add(" * One row per `(provider, iso2, window)`: `[iso2, effective_from, effective_to, tier, label]`.")
    add(" * The window is `[from, to)`; `null` means still in force. Exported so the drift test can")
    add(" * compare it against the JSON rather than trusting a hash.")
    add(" */")
    add("export type ClassificationRow = readonly [string, string, string | null, MarketTier, string];")
    add("")
    add("export const CLASSIFICATION_ROWS: Readonly<Record<Provider, readonly ClassificationRow[]>> = {")
    for provider in providers:
        add(f"  {_ts_string(provider)}: [")
        for iso2, start, end, tier, label in _rows(document, provider):
            end_lit = "null" if end is None else _ts_string(end)
            add(f"    [{_ts_string(iso2)}, {_ts_string(start)}, {end_lit}, {_ts_string(tier)}, {_ts_string(label)}],")
        add("  ],")
    add("};")
    add("")
    add("/** How a tier folds into the bar's three segments. */")
    add("export const TIER_FOLD: Readonly<Record<MarketTier, CountryTier>> = {")
    for tier, bucket in document["bucket_rules"]["fold"].items():
        add(f"  {_ts_string(tier)}: {_ts_string(bucket)},")
    add("};")
    add("")
    add("/**")
    add(" * Domiciles the provider does not classify, placed by a stated product rule.")
    add(" * `shared` applies to every provider; `byProvider` overrides it for one.")
    add(" */")
    add("export const SHARED_BUCKETS: Readonly<Record<string, CountryTier>> = {")
    for iso2, bucket in sorted(document["bucket_rules"]["shared"].items()):
        add(f"  {_ts_string(iso2)}: {_ts_string(bucket)},")
    add("};")
    add("")
    add("export const PROVIDER_BUCKETS: Readonly<Record<Provider, Readonly<Record<string, CountryTier>>>> = {")
    for provider in providers:
        overrides = document["bucket_rules"].get("by_provider", {}).get(provider, {})
        add(f"  {_ts_string(provider)}: {{")
        for iso2, bucket in sorted(overrides.items()):
            add(f"    {_ts_string(iso2)}: {_ts_string(bucket)},")
        add("  },")
    add("};")
    add("")
    add("export interface TierOptions {")
    add("  /** Defaults to `DEFAULT_PROVIDER`. */")
    add("  provider?: Provider;")
    add("  /** Defaults to `TIER_AS_OF`. The window is `[from, to)`. */")
    add("  asOf?: string;")
    add("}")
    add("")
    add("function indexOf(provider: Provider): ReadonlyMap<string, readonly ClassificationRow[]> {")
    add("  const index = new Map<string, ClassificationRow[]>();")
    add("  for (const row of CLASSIFICATION_ROWS[provider]) {")
    add("    const rows = index.get(row[0]);")
    add("    if (rows) rows.push(row);")
    add("    else index.set(row[0], [row]);")
    add("  }")
    add("  return index;")
    add("}")
    add("")
    add("// Written out rather than built with `Object.fromEntries`, which widens to")
    add("// `Record<string, …>` and would let a provider be added to the data without a")
    add("// compile error here. A missing provider is a type error, not a silent gap.")
    add("const BY_PROVIDER: Readonly<Record<Provider, ReadonlyMap<string, readonly ClassificationRow[]>>> = {")
    for provider in providers:
        add(f'  {provider}: indexOf("{provider}"),')
    add("};")
    add("")
    add("/**")
    add(" * The provider's tier for a domicile, or `null` when there is no domicile to classify.")
    add(" *")
    add(" * `null` is reserved for \"the release has no country for this company\", which is a")
    add(" * different statement and is answered by the release's contested map, not by a default")
    add(" * here. A code the provider does not classify is `UNCLASSIFIED`, which is a tier.")
    add(" */")
    add("export function marketTierOf(")
    add("  country: string | null | undefined,")
    add("  options: TierOptions = {},")
    add("): MarketTier | null {")
    add("  if (!country) return null;")
    add("  const code = country.trim().toUpperCase();")
    add("  if (!code) return null;")
    add("  const provider = options.provider ?? DEFAULT_PROVIDER;")
    add("  const asOf = options.asOf ?? TIER_AS_OF;")
    add("  const rows = BY_PROVIDER[provider].get(code);")
    add("  if (!rows) return \"UNCLASSIFIED\";")
    add("  for (const row of rows) {")
    add("    if (row[1] <= asOf && (row[2] === null || asOf < row[2])) return row[3];")
    add("  }")
    add("  return \"UNCLASSIFIED\";")
    add("}")
    add("")
    add("/**")
    add(" * The bar's three segments for a domicile, or `null` when there is no domicile.")
    add(" *")
    add(" * Total over every ISO alpha-2 code: a domicile the provider does not classify is")
    add(" * placed by a stated rule, so the Markets bar never has a fourth segment to draw.")
    add(" */")
    add("export function tierOf(")
    add("  country: string | null | undefined,")
    add("  options: TierOptions = {},")
    add("): CountryTier | null {")
    add("  if (!country) return null;")
    add("  const code = country.trim().toUpperCase();")
    add("  if (!code) return null;")
    add("  const provider = options.provider ?? DEFAULT_PROVIDER;")
    add("  const shared = SHARED_BUCKETS[code];")
    add("  if (shared) return shared;")
    add("  const override = PROVIDER_BUCKETS[provider][code];")
    add("  if (override) return override;")
    add("  const tier = marketTierOf(code, { provider, asOf: options.asOf });")
    add("  return tier === null ? null : TIER_FOLD[tier];")
    add("}")
    add("")
    return "\n".join(lines)


def render_py(document: dict) -> str:
    providers = list(document["providers"])
    default = next(p for p in providers if document["providers"][p]["is_default"])
    lines: list[str] = []
    add = lines.append

    add('"""' + BANNER.replace("\n", "\n") + '"""')
    add("")
    add("from __future__ import annotations")
    add("")
    add("from typing import Mapping")
    add("")
    add(f"TIER_AS_OF = {document['as_of']!r}")
    add(f"DEFAULT_PROVIDER = {default!r}")
    add(f"PROVIDERS = ({', '.join(repr(p) for p in providers)},)")
    add("")
    add("PROVIDER_NAMES = {")
    for provider in providers:
        add(f"    {provider!r}: {document['providers'][provider]['name']!r},")
    add("}")
    add("")
    add("PROVIDER_LABELS = {")
    for provider in providers:
        add(f"    {provider!r}: {document['providers'][provider]['label']!r},")
    add("}")
    add("")
    add("PROVIDER_SOURCE_URLS = {")
    for provider in providers:
        add(f"    {provider!r}: {document['providers'][provider]['source_url']!r},")
    add("}")
    add("")
    add("#: ``provider -> ((iso2, effective_from, effective_to, tier, label), ...)``.")
    add("CLASSIFICATION_ROWS = {")
    for provider in providers:
        add(f"    {provider!r}: (")
        for iso2, start, end, tier, label in _rows(document, provider):
            add(f"        ({iso2!r}, {start!r}, {end!r}, {tier!r}, {label!r}),")
        add("    ),")
    add("}")
    add("")
    add("TIER_FOLD = {")
    for tier, bucket in document["bucket_rules"]["fold"].items():
        add(f"    {tier!r}: {bucket!r},")
    add("}")
    add("")
    add("SHARED_BUCKETS = {")
    for iso2, bucket in sorted(document["bucket_rules"]["shared"].items()):
        add(f"    {iso2!r}: {bucket!r},")
    add("}")
    add("")
    add("PROVIDER_BUCKETS = {")
    for provider in providers:
        overrides = document["bucket_rules"].get("by_provider", {}).get(provider, {})
        add(f"    {provider!r}: {{")
        for iso2, bucket in sorted(overrides.items()):
            add(f"        {iso2!r}: {bucket!r},")
        add("    },")
    add("}")
    add("")
    add("")
    add("def _index(provider: str) -> Mapping[str, tuple]:")
    add("    return _INDEX[provider]")
    add("")
    add("")
    add("_INDEX = {")
    add("    provider: {")
    add("        iso2: tuple(r for r in rows if r[0] == iso2)")
    add("        for iso2 in {r[0] for r in rows}")
    add("    }")
    add("    for provider, rows in CLASSIFICATION_ROWS.items()")
    add("}")
    add("")
    add("")
    add("def market_tier_of(")
    add("    country: str | None,")
    add("    as_of: str | None = None,")
    add("    provider: str | None = None,")
    add(") -> str | None:")
    add('    """The provider\'s tier for a domicile, or ``None`` when there is no domicile."""')
    add("    if not country:")
    add("        return None")
    add("    code = country.strip().upper()")
    add("    if not code:")
    add("        return None")
    add("    provider = provider or DEFAULT_PROVIDER")
    add("    as_of = as_of or TIER_AS_OF")
    add("    rows = _index(provider).get(code)")
    add("    if not rows:")
    add('        return "UNCLASSIFIED"')
    add("    for _iso2, start, end, tier, _label in rows:")
    add("        if start <= as_of and (end is None or as_of < end):")
    add("            return tier")
    add('    return "UNCLASSIFIED"')
    add("")
    add("")
    add("def tier_of(")
    add("    country: str | None,")
    add("    as_of: str | None = None,")
    add("    provider: str | None = None,")
    add(") -> str | None:")
    add('    """The bar\'s three segments for a domicile, or ``None`` when there is no domicile."""')
    add("    if not country:")
    add("        return None")
    add("    code = country.strip().upper()")
    add("    if not code:")
    add("        return None")
    add("    provider = provider or DEFAULT_PROVIDER")
    add("    shared = SHARED_BUCKETS.get(code)")
    add("    if shared:")
    add("        return shared")
    add("    override = PROVIDER_BUCKETS[provider].get(code)")
    add("    if override:")
    add("        return override")
    add("    tier = market_tier_of(code, as_of=as_of, provider=provider)")
    add("    return None if tier is None else TIER_FOLD[tier]")
    add("")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="exit 1 if a module is stale")
    args = parser.parse_args(argv)

    document = load()
    _check_no_overlap(document)
    outputs = {TS_OUT: render_ts(document), PY_OUT: render_py(document)}

    stale = []
    for path, text in outputs.items():
        current = path.read_text() if path.exists() else None
        if current == text:
            continue
        stale.append(path)
        if not args.check:
            path.write_text(text)

    if args.check:
        if stale:
            for path in stale:
                print(f"stale: {path.relative_to(REPO_ROOT)}", file=sys.stderr)
            print("run: python scripts/gen_classification.py", file=sys.stderr)
            return 1
        print("classification modules are up to date")
        return 0

    for path in outputs:
        state = "wrote" if path in stale else "unchanged"
        print(f"{state}: {path.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
