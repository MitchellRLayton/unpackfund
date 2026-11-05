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

import { TIER_AS_OF, TIER_CONVENTION } from "@/lib/country-tier";
import { saveCsv } from "@/lib/export";
import { formatCount, formatShare } from "@/lib/format";
import type { LensProps } from "@/components/workspace/types";

import { LensExport, LensLede, LensProblem, LensSection, LensState } from "./lens-chrome";
import { lensCsvName, marketsCsv } from "./lens-csv";
import { lensGateState } from "./lens-gate";
import { BUCKET_WORD, TIER_WORD, marketSplit, type MarketBucket } from "./lens-math";

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

export function MarketsLens({ model }: LensProps) {
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
    });

    const maxCountry = split.countries.reduce(
      (largest, country) => Math.max(largest, Math.max(0, country.weight)),
      0,
    );

    return { split, maxCountry };
  }, [ledger, countryOf, contested, funds, fundWeights]);

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

  const { split, maxCountry } = analysis;
  const releaseAsOf = model.releaseAsOf ?? "unknown";
  const { outside } = split;

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
        with the two-letter code printed rather than implied.
      </LensLede>

      <div className="stack stack--tight">
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
              {BUCKET_WORD[tier.bucket]}
            </span>
          ))}
        </div>
        <div className="prose">
          <p className="small muted">
            The bar draws three shares of one total — the weight the filings place in a
            market — and the table beneath it prints each one. {outsideSentence}
            {split.hasNegative
              ? " A company line with a negative weight (a short position inside a fund) is printed in the table and left out of the drawing: a bar is made of positive parts of a whole."
              : ""}
          </p>
        </div>
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
                  <th scope="row">{BUCKET_WORD[tier.bucket]}</th>
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
                ? `Developed and emerging follow the ${TIER_CONVENTION}, as of ${TIER_AS_OF}; offshore holding domiciles such as Bermuda and the Cayman Islands are the United States, because that is where their shares trade.`
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
                    <span className="country-tag">{country.code}</span>
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
