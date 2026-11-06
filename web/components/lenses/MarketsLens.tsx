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
 */

import { useMemo } from "react";

import { flagEmoji } from "@/lib/country-flag";
import {
  PROVIDERS,
  PROVIDER_NAMES,
  TIER_AS_OF,
  tierConvention,
} from "@/lib/country-tier";
import { saveCsv } from "@/lib/export";
import { formatCount, formatShare } from "@/lib/format";
import type { LensProps } from "@/components/workspace/types";

import { LensExport, LensLede, LensProblem, LensSection, LensState } from "./lens-chrome";
import { lensCsvName, marketsCsv } from "./lens-csv";
import { lensGateState } from "./lens-gate";
import {
  BUCKET_WORD,
  PROVIDER_SHORT,
  TIER_WORD,
  bucketWord,
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

/** Below this a term is a rounding artefact, not a fact worth a clause. */
const NEGLIGIBLE = 0.00005;

/**
 * How much of the bar a country must be before the convention that moves it is worth a
 * sentence: one per cent. Below that the move is real but invisible — a reader cannot see
 * a tenth of a point change a segment — and a callout for it would be noise.
 */
const NOTABLE_MOVE = 0.01;

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

  // Every term is printed with its own number, and a term that is zero is left out
  // rather than printed as "0.00% is …", which reads as a puzzle.
  const outsideParts: string[] = [];
  if (Math.abs(outside.unplacedCompanyWeight) > NEGLIGIBLE) {
    outsideParts.push(
      `${formatShare(outside.unplacedCompanyWeight)} is ${formatCount(
        outside.unplacedCompanies,
      )} ${
        outside.unplacedCompanies === 1 ? "company" : "companies"
      } the release has no country for`,
    );
  }
  if (Math.abs(outside.unplacedSecurities) > NEGLIGIBLE) {
    outsideParts.push(
      `${formatShare(
        outside.unplacedSecurities,
      )} is share positions inside funds whose filing states no country`,
    );
  }
  if (Math.abs(outside.cashAndDerivatives) > NEGLIGIBLE) {
    outsideParts.push(
      `${formatShare(outside.cashAndDerivatives)} is cash and derivative lines inside funds`,
    );
  }
  if (Math.abs(outside.cash) > NEGLIGIBLE) {
    outsideParts.push(`${formatShare(outside.cash)} is cash you hold`);
  }
  if (Math.abs(outside.filedOvershoot) > NEGLIGIBLE) {
    outsideParts.push(
      `${formatShare(
        outside.filedOvershoot,
      )} is the weight the filings report outside their own holding schedules`,
    );
  }

  const outsideSentence =
    outsideParts.length === 0
      ? "Nothing is outside the bar: every position the filings report is placed in a market."
      : `Outside the bar: ${outsideParts.join(", ")}.`;

  return (
    <div className="stack">
      <LensProblem model={model} />
      <LensLede>
        Every position the release can place, split by the market its country belongs to:
        the United States, international developed markets outside it, and emerging
        markets. Weight is a share of the weight the filings place in a market — cash,
        derivatives and positions whose filing states no country sit outside the bar and
        are named under it. The countries behind the segments are in the second table,
        with the two-letter code printed rather than implied. Which publisher&rsquo;s
        convention decides that is your choice, and every label below names the one in
        use.
      </LensLede>

      <div className="stack stack--tight">
        {/* The convention, before the bar it decides. Two buttons rather than a select:
         * both choices are visible, the current one is pressed, and a reader can see
         * that there is a choice at all without opening anything. */}
        <div className="row row--between">
          <p className="small muted" id="markets-provider-label">
            Classify by:
          </p>
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
              {bucketWord(tier.bucket, provider)}
            </span>
          ))}
        </div>

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
              is {BUCKET_WORD[move.from]} under {PROVIDER_NAMES[provider]} and{" "}
              {BUCKET_WORD[move.to]} under {PROVIDER_NAMES[other]} — the two publishers
              disagree about it, and the bar follows the convention you pick.
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

        <div className="prose">
          <p className="small muted">
            The bar draws three shares of one total — the weight the filings place in a
            market — and the table beneath it prints each one. {outsideSentence}
            {split.hasNegative
              ? " A company line with a negative weight (a short position inside a fund) is printed in the table and left out of the drawing: a bar is made of positive parts of a whole."
              : ""}
          </p>
        </div>

        {/* What the toggle would change, and nothing else. A table of every country with
         * two identical columns would bury the dozen that move; when none move, one
         * sentence says so rather than an empty table with a caption. */}
        {moves.length === 0 ? (
          <p className="small muted">
            The two conventions agree for this portfolio: every country in it lands in the
            same segment under {PROVIDER_NAMES.MSCI} and {PROVIDER_NAMES.FTSE}.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <caption>
                Only the countries whose segment changes between the two conventions are
                listed. Share of the bar is the weight that moves when you switch, as a
                share of the weight the bar draws.
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
                      <td>{BUCKET_WORD[underMsci]}</td>
                      <td>{BUCKET_WORD[underFtse]}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <LensSection
        title="The bar, in numbers"
        action={<LensExport label="markets by segment" onExport={exportMarkets} />}
      >
        <div className="table-wrap">
          <table className="table">
            <caption>
              The three segments in the order the bar draws them. Weight is a share of the
              total the bar draws, and that total is the last row. A company is counted
              once however many funds hold it, so Companies counts company lines, never
              positions.
            </caption>
            <thead>
              <tr>
                <th scope="col">Market</th>
                <th scope="col" className="num">
                  Weight
                </th>
                <th scope="col" className="num">
                  Companies
                </th>
              </tr>
            </thead>
            <tbody>
              {split.tiers.map((tier) => (
                <tr key={tier.bucket} data-tier={tier.bucket}>
                  <th scope="row">{bucketWord(tier.bucket, provider)}</th>
                  <td className="num">{formatShare(tier.weight)}</td>
                  <td className="num">{formatCount(tier.companies)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">Everything the bar draws</th>
                <td className="num">{formatShare(split.placed)}</td>
                <td className="num">{formatCount(split.companies)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </LensSection>

      <LensSection
        title="By country"
        action={<LensExport label="countries in your mix" onExport={exportMarkets} />}
      >
        <div className="table-wrap">
          <table className="tier-edge table">
            <caption>
              One row per country code the release answers with, largest weight first. The
              two-letter code is the domicile the filings agree on; Tier is the market
              convention applied to it. Weight is a share of your whole portfolio, and the
              bar draws the same weight on one scale for the whole table, set by the
              largest country.{" "}
              {split.countries.length > 0
                ? `Developed and emerging follow the ${tierConvention(provider)}, as of ${TIER_AS_OF}; offshore holding domiciles such as Bermuda and the Cayman Islands are the United States, because most of the weight in them is an American business listed in New York.`
                : ""}
            </caption>
            <thead>
              <tr>
                <th scope="col">Country</th>
                <th scope="col">Tier</th>
                <th scope="col" className="num">
                  Weight
                </th>
                <th scope="col" className="num">
                  Companies
                </th>
                <th scope="col">Weight, drawn</th>
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
                  <td>{TIER_WORD[country.tier]}</td>
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
        </div>
      </LensSection>
    </div>
  );
}
