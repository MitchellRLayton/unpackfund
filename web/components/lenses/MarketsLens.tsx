"use client";

/**
 * Markets: where the money you own is invested, by market.
 *
 * One stacked bar (never a pie — parts of a whole read as lengths on one line), one
 * table of the bar's three segments, one table of every country code behind them.
 * Colour carries the tier and nothing else: blue for the United States, ochre for
 * international developed markets outside it, a deeper ochre for emerging markets.
 * Every segment's number is printed, and the code itself is always text, so a
 * monochrome print and a screen reader lose nothing.
 *
 * **Three segments, not five.** A reader compares this bar against an issuer's own
 * factsheet, and "no market tier" / "unplaced" are questions the page could not answer
 * rather than answers. So every position the release can place lands in one of the
 * three, and what it cannot place — cash, derivatives, a position whose filing states
 * no country — is named with its own number in the sentence under the bar instead of
 * drawn as a fourth segment (operator's instruction, 2026-11-05).
 *
 * The bar's denominator is therefore the weight the release can *place*, and the
 * sentence under it says so. A bar that silently renormalised over a subset would be a
 * share of the wrong whole (`lookthrough-math-and-qa` §5).
 *
 * **Compact labels, one convention (OD-04, operator, 2026-11-18).** The bar and both
 * tables print `US` / `DM` / `EM`, and the convention is named once per view — a tag
 * beside the toggle — instead of `(MSCI)` on every label. The long names sit in the tips
 * behind those labels. Nothing about the split changes: the code, the number and the
 * tooltip's word are all text, so colour is still never the only carrier (H9).
 */

import { TableScroll } from "@/components/TableScroll";
import { useMemo } from "react";

import { flagEmoji } from "@/lib/country-flag";
import { PROVIDERS, PROVIDER_NAMES } from "@/lib/country-tier";
import { saveCsv } from "@/lib/export";
import { formatCount, formatShare } from "@/lib/format";
import { InfoTip } from "@/components/feedback/InfoTip";
import type { LensProps } from "@/components/workspace/types";

import { LensExport, LensProblem, LensSection, LensState } from "./lens-chrome";
import { lensCsvName, marketsCsv } from "./lens-csv";
import { lensGateState } from "./lens-gate";
import {
  MARKET_LONG,
  PROVIDER_SHORT,
  marketSplit,
  otherProvider,
  providerMoves,
  type MarketBucket,
} from "./lens-math";
import { useProvider } from "./provider-preference";

/** The bar segment and the row-bar fill for each segment. */
const SEGMENT_BACKGROUND: Record<MarketBucket, string> = {
  US: "bar__seg--us",
  DM: "bar__seg--dm",
  EM: "bar__seg--em",
};

const ROW_FILL: Record<MarketBucket, string> = {
  US: "rowbar__fill--us",
  DM: "rowbar__fill--dm",
  EM: "rowbar__fill--em",
};

/** `concepts.market_tier.popover` — the Tier column's one explanation (R4). */
const MARKET_TIER_TIP =
  "US, developed ex-US (DM), or emerging (EM), by the country's classification. Offshore holding domiciles such as Bermuda count as US.";

/** CN_OFFSHORE_TIER: the tip on a tier cell the shared rule decided. */
const OFFSHORE_TIER_TIP = "Offshore holding domicile, counted as US.";

/**
 * The eleven offshore holding domiciles — where a company is registered, not where it
 * operates. The rule and the set live in `classification/classification.json`
 * (`bucket_rules.shared`); this is only the display trigger for CN_OFFSHORE_TIER, so it
 * moves with that file and never decides a tier itself.
 */
const OFFSHORE_HOLDCO = new Set("BM BS GG GI IM JE KY MC MH PA VG".split(" "));

/** Below this a term is a rounding artefact, not a fact worth a clause. */
const NEGLIGIBLE = 0.00005;

/**
 * How much of the bar a country must be before the convention that moves it is worth a
 * sentence: one per cent. Below that the move is real but invisible — a reader cannot see
 * a tenth of a point change a segment — and a callout for it would be noise.
 */
const NOTABLE_MOVE = 0.01;

/**
 * How many countries may move before the one-line sentence becomes a table again: the
 * condition's own bound (CN_FTSE_DIFF, `template_n_le_3`).
 */
const MOVES_IN_A_LINE = 3;

export function MarketsLens({ model }: LensProps) {
  const { provider, setProvider } = useProvider();
  const gate = lensGateState(model);
  const ledger = model.ledger;
  const countryOf = model.countryOf;
  const contested = model.contested;
  const funds = model.funds;
  const fundWeights = model.split.fundWeights;

  const analysis = useMemo(() => {
    if (!ledger) return null;
    const split = marketSplit({
      rows: ledger.rows,
      countryOf,
      contested,
      unmapped: ledger.unmapped,
      metrics: ledger.metrics,
      funds,
      weights: fundWeights,
      provider,
    });

    const maxCountry = split.countries.reduce(
      (largest, country) => Math.max(largest, Math.max(0, country.weight)),
      0,
    );

    return { split, maxCountry, moves: providerMoves(split.countries, provider) };
  }, [ledger, countryOf, contested, funds, fundWeights, provider]);

  if (gate.kind === "blocked") {
    return <LensState title={gate.title} body={gate.body} />;
  }

  // A country map that has not arrived is not a country map with no answers: the
  // release may publish one, and until it is here every company would draw as
  // unplaced. Say which it is rather than printing a bar that is 100% grey.
  if (model.countries === null) {
    return (
      <LensState
        title="Waiting for the country map"
        body="The release names a country object and it is still arriving. Until it is here no company can be placed, and a bar of solid grey would be a wrong answer rather than an empty one."
      />
    );
  }

  if (!analysis) {
    return (
      <LensState
        title="Working out the look-through"
        body="The ledger is aggregating the funds' filings. This lens reads only the finished ledger, so it waits for it."
      />
    );
  }

  const { split, maxCountry, moves } = analysis;
  const releaseAsOf = model.releaseAsOf ?? "unknown";
  const { outside } = split;
  const other = otherProvider(provider);
  // The countries worth a sentence: the ones a reader can actually see move.
  const notable = moves.filter(
    (move) => split.placed > 0 && move.weight / split.placed >= NOTABLE_MOVE,
  );

  const exportMarkets = () => {
    saveCsv(
      marketsCsv(split, releaseAsOf),
      lensCsvName("markets", new Date(), releaseAsOf),
    );
  };

  // CN_MARKETS_OUTSIDE: the parts of what the bar does not draw that have a clause of
  // their own. A part that rounds to nothing is left out with its comma rather than
  // printed as "0.00% is …", which reads as a puzzle; when neither is left the line is
  // not rendered at all, because then the condition has not fired.
  const outsideClauses: string[] = [];
  if (Math.abs(outside.cashAndDerivatives) > NEGLIGIBLE) {
    outsideClauses.push(
      `${formatShare(outside.cashAndDerivatives)} cash and derivatives`,
    );
  }
  if (Math.abs(outside.filedOvershoot) > NEGLIGIBLE) {
    outsideClauses.push(
      `${formatShare(outside.filedOvershoot)} filed outside listed holdings`,
    );
  }
  const outsideLine =
    outsideClauses.length > 0 ? `Not in the bar: ${outsideClauses.join(", ")}.` : null;

  // CN_FTSE_DIFF: one sentence while up to three countries move, the table behind a
  // summary when more do. `moves` is the list the table prints; nothing is recomputed.
  const moveClauses = moves.map(
    (move) =>
      `${move.code} would be ${move.to} (${formatShare(
        split.placed > 0 ? move.weight / split.placed : 0,
      )})`,
  );
  const moveLine =
    moveClauses.length > 0
      ? `Under ${PROVIDER_NAMES[other]}, ${moveClauses.join("; ")}.`
      : null;

  return (
    <div className="stack">
      <LensProblem model={model} />

      <div className="stack stack--tight">
        {/* The convention, before the bar it decides. Two buttons rather than a select:
         * both choices are visible, the current one is pressed, and a reader can see
         * that there is a choice at all without opening anything. */}
        <div className="row row--between">
          <p className="small muted">
            <span id="markets-provider-label">Classify by</span>
            <InfoTip label="Classify by">
              Index providers disagree on a few countries, such as South Korea. Pick whose
              list to use.
            </InfoTip>
          </p>
          <div className="row">
            <div role="group" aria-labelledby="markets-provider-label" className="row">
              {PROVIDERS.map((option) => (
                <button
                  key={option}
                  type="button"
                  className={`btn btn--sm${option === provider ? "btn--primary" : ""}`}
                  aria-pressed={option === provider}
                  onClick={() => setProvider(option)}
                >
                  {PROVIDER_SHORT[option]}
                </button>
              ))}
            </div>
            {/* OD-04: the convention is named once, here, so no label below repeats it. */}
            <span className="chip" data-convention={provider}>
              {PROVIDER_SHORT[provider]}
            </span>
          </div>
        </div>

        <div className="bar bar--tall" aria-hidden="true">
          {split.tiers.map((tier) => (
            <span
              key={tier.bucket}
              className={`bar__seg ${SEGMENT_BACKGROUND[tier.bucket]}`}
              style={{
                width: `${
                  split.placed > 0 ? (Math.max(0, tier.weight) / split.placed) * 100 : 0
                }%`,
              }}
            />
          ))}
        </div>
        <div className="legend">
          {split.tiers.map((tier) => (
            <span key={tier.bucket} className="legend__item">
              <span
                className={`legend__swatch ${SEGMENT_BACKGROUND[tier.bucket]}`}
                aria-hidden="true"
              />
              {tier.bucket}
              <InfoTip label={tier.bucket}>{MARKET_LONG[tier.bucket]}</InfoTip>
            </span>
          ))}
        </div>

        {/* CN_MARKETS_OUTSIDE, directly under the legend it explains. */}
        {outsideLine === null ? null : <p className="small muted">{outsideLine}</p>}

        {/* What the toggle would change, and nothing else — directly under the line it
         * extends (CN_FTSE_DIFF's placement). A table of every country with two identical
         * columns would bury the dozen that move; when none move, one sentence says so
         * rather than an empty table with a caption. */}
        {moves.length === 0 ? (
          <p className="small muted">
            The two conventions agree for this portfolio: every country in it lands in the
            same segment under {PROVIDER_NAMES.MSCI} and {PROVIDER_NAMES.FTSE}.
          </p>
        ) : moves.length <= MOVES_IN_A_LINE ? (
          <p className="small muted">{moveLine}</p>
        ) : (
          <details>
            <summary className="small muted">
              {moves.length} countries change under {PROVIDER_NAMES[other]}
            </summary>
            <TableScroll label="Markets, share of your money">
              <table className="table">
                <caption className="visually-hidden">
                  Only the countries whose segment changes between the two conventions are
                  listed.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Country</th>
                    <th scope="col" className="num">
                      Share of the bar
                    </th>
                    <th scope="col">Under {PROVIDER_NAMES.MSCI}</th>
                    <th scope="col">Under {PROVIDER_NAMES.FTSE}</th>
                  </tr>
                </thead>
                <tbody>
                  {moves.map((move) => {
                    const underMsci = provider === "MSCI" ? move.from : move.to;
                    const underFtse = provider === "MSCI" ? move.to : move.from;
                    return (
                      <tr key={move.code}>
                        <th scope="row">
                          <span className="country-tag">
                            {flagEmoji(move.code)} {move.code}
                          </span>
                        </th>
                        <td className="num">
                          {formatShare(split.placed > 0 ? move.weight / split.placed : 0)}
                        </td>
                        <td>{underMsci}</td>
                        <td>{underFtse}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableScroll>
          </details>
        )}

        {/* A company line with a negative weight is printed, never drawn. The rule is on
         * `/methodology/#concentration` (MA-07); the sentence stays because it is a fact
         * about this portfolio, not a definition. */}
        {split.hasNegative ? (
          <p className="small muted">
            A company line with a negative weight (a short position inside a fund) is
            printed in the table and left out of the drawing: a bar is made of positive
            parts of a whole.
          </p>
        ) : null}

        {/* The one country a reader would otherwise have to notice for themselves. A
         * segment that moves when the convention changes is not a rounding difference:
         * it is two publishers disagreeing, and the sentence says so and offers the
         * other convention rather than leaving the reader to find the toggle. */}
        {notable.map((move) => (
          <div key={move.code} className="notice notice--quiet">
            <p className="small">
              <span className="country-tag">
                {flagEmoji(move.code)} {move.code}
              </span>{" "}
              is {move.from} under {PROVIDER_NAMES[provider]} and {move.to} under{" "}
              {PROVIDER_NAMES[other]} — the two publishers disagree about it, and the bar
              follows the convention you pick.
            </p>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => setProvider(other)}
            >
              Show {PROVIDER_SHORT[other]}
            </button>
          </div>
        ))}
      </div>

      <LensSection
        title="By market"
        action={<LensExport label="markets by segment" onExport={exportMarkets} />}
      >
        <TableScroll label="Markets by fund">
          <table className="table">
            {/* A caption for a screen reader only (R2, H9): what the table is, and that
                its total is the bar's denominator — the rows print every number. */}
            <caption className="visually-hidden">
              Weight by market, as a share of placed weight.
            </caption>
            <thead>
              <tr>
                <th scope="col">Market</th>
                <th scope="col" className="num">
                  Weight
                  <InfoTip label="Weight">
                    Share of the weight we can place in a market.
                  </InfoTip>
                </th>
                <th scope="col" className="num">
                  Companies
                  <InfoTip label="Companies">
                    Each company counted once, however many funds hold it.
                  </InfoTip>
                </th>
              </tr>
            </thead>
            <tbody>
              {split.tiers.map((tier) => (
                <tr key={tier.bucket} data-tier={tier.bucket}>
                  <th scope="row">{tier.bucket}</th>
                  <td className="num">{formatShare(tier.weight)}</td>
                  <td className="num">{formatCount(tier.companies)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">Total</th>
                <td className="num">{formatShare(split.placed)}</td>
                <td className="num">{formatCount(split.companies)}</td>
              </tr>
            </tfoot>
          </table>
        </TableScroll>
      </LensSection>

      <LensSection
        title="By country"
        action={<LensExport label="countries in your mix" onExport={exportMarkets} />}
      >
        <TableScroll label="Markets, detail">
          <table className="tier-edge table">
            {/* The tier convention, its vintage and the offshore rule are the Tier
                header's tip and the glossary entry behind it (R4, H6). */}
            <caption className="visually-hidden">
              Countries in your portfolio, largest first.
            </caption>
            <thead>
              <tr>
                <th scope="col">Country</th>
                <th scope="col">
                  Tier
                  <InfoTip label="Tier">{MARKET_TIER_TIP}</InfoTip>
                </th>
                <th scope="col" className="num">
                  Weight
                  <InfoTip label="Weight">Share of your whole portfolio.</InfoTip>
                </th>
                <th scope="col" className="num">
                  Companies
                </th>
                <th scope="col">
                  <span className="visually-hidden">Bar</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {split.countries.map((country) => (
                <tr key={country.code} data-tier={country.tier}>
                  <th scope="row">
                    {/* The flag is derived from the code and is decoration: the glyph
                      is `aria-hidden` and a screen reader hears the code, exactly as it
                      does in the delta table above and on every other surface. */}
                    <span className="country-tag">
                      <span aria-hidden="true">{flagEmoji(country.code)}</span>{" "}
                      {country.code}
                    </span>
                  </th>
                  <td>
                    {country.tier}
                    {country.tier === "US" && OFFSHORE_HOLDCO.has(country.code) ? (
                      <InfoTip label="Offshore domicile">{OFFSHORE_TIER_TIP}</InfoTip>
                    ) : null}
                  </td>
                  <td className="num">{formatShare(country.weight)}</td>
                  <td className="num">{formatCount(country.companies)}</td>
                  <td>
                    <span className="rowbar">
                      <span
                        className={`rowbar__fill ${ROW_FILL[country.tier]}`}
                        style={{
                          width: `${
                            maxCountry > 0
                              ? (Math.max(0, country.weight) / maxCountry) * 100
                              : 0
                          }%`,
                        }}
                      />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </LensSection>
    </div>
  );
}
