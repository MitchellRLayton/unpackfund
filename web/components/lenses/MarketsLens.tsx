"use client";

/**
 * Markets: where the companies you own are domiciled.
 *
 * One stacked bar (never a pie — parts of a whole read as lengths on one line),
 * one table of the bar's five segments, one table of every country code behind
 * them. Colour carries the tier and nothing else: blue for the United States,
 * ochre for developed markets elsewhere, a deeper ochre for emerging, solid grey
 * for a domicile with no market classification, and a dashed grey for what the
 * filings cannot place at all. Every segment's number is printed, and the code
 * itself is always text, so a monochrome print and a screen reader lose nothing.
 *
 * The bar's dashed segment is not one fact but a short list, and the sentence under
 * the bar names every part of it with its own number (`lookthrough-math-and-qa` §5:
 * an unresolved holding is disclosed, never redistributed, and never averaged into
 * a number that reads as coverage).
 */

import { useMemo } from "react";

import { TIER_AS_OF, TIER_CONVENTION } from "@/lib/country-tier";
import { saveCsv } from "@/lib/export";
import { formatCount, formatShare } from "@/lib/format";
import type { LensProps } from "@/components/workspace/types";

import {
  CellNote,
  LensExport,
  LensLede,
  LensProblem,
  LensSection,
  LensState,
} from "./lens-chrome";
import { lensCsvName, marketsCsv } from "./lens-csv";
import { lensGateState } from "./lens-gate";
import { BUCKET_WORD, TIER_WORD, marketSplit, type MarketBucket } from "./lens-math";

/** The bar segment and the row-bar fill for each segment. */
const SEGMENT_BACKGROUND: Record<MarketBucket, string> = {
  US: "bar__seg--us",
  DM: "bar__seg--dm",
  EM: "bar__seg--em",
  OTHER: "bar__seg--none",
  UNKNOWN: "bar__seg--unplaced",
};

const ROW_FILL: Record<MarketBucket, string> = {
  US: "rowbar__fill--us",
  DM: "rowbar__fill--dm",
  EM: "rowbar__fill--em",
  OTHER: "rowbar__fill--none",
  UNKNOWN: "rowbar__fill--none",
};

/** The dashed segment is called "Unplaced": it is the one segment with several causes. */
const ROW_WORD: Record<MarketBucket, string> = {
  ...BUCKET_WORD,
  UNKNOWN: "Unplaced",
};

interface Segment {
  bucket: MarketBucket;
  weight: number;
  companies: number;
}

export function MarketsLens({ model }: LensProps) {
  const gate = lensGateState(model);
  const ledger = model.ledger;
  const countryOf = model.countryOf;
  const funds = model.funds;
  const fundWeights = model.split.fundWeights;

  const analysis = useMemo(() => {
    if (!ledger) return null;
    const split = marketSplit({
      rows: ledger.rows,
      countryOf,
      unmapped: ledger.unmapped,
      metrics: ledger.metrics,
      funds,
      weights: fundWeights,
    });

    const segments: Segment[] = split.tiers
      .filter((tier) => tier.bucket !== "UNKNOWN")
      .map((tier) => ({
        bucket: tier.bucket,
        weight: tier.weight,
        companies: tier.companies,
      }));
    segments.push({
      bucket: "UNKNOWN",
      weight: split.unplaced.total,
      companies: split.unplaced.unknownCompanies,
    });

    const drawn = segments.reduce((sum, segment) => sum + Math.max(0, segment.weight), 0);
    const maxCountry = split.countries.reduce(
      (largest, country) => Math.max(largest, Math.max(0, country.weight)),
      0,
    );

    return { split, segments, drawn, maxCountry };
  }, [ledger, countryOf, funds, fundWeights]);

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

  const { split, segments, drawn, maxCountry } = analysis;
  const releaseAsOf = model.releaseAsOf ?? "unknown";
  const { unplaced } = split;

  const exportMarkets = () => {
    saveCsv(
      marketsCsv(split, releaseAsOf),
      lensCsvName("markets", new Date(), releaseAsOf),
    );
  };

  // The correction term is printed only when there is one: "0.00% is the weight the
  // filings report outside their schedules" is a clause that reads as a puzzle. Both
  // templates are fixed; only the numbers in them change.
  const overshootClause =
    Math.abs(unplaced.filedOvershoot) < 0.00005
      ? "and the filings report no weight outside their own holding schedules."
      : `and ${formatShare(
          unplaced.filedOvershoot,
        )} is the weight the filings report outside their own holding schedules.`;

  const unplacedSentence = `Unplaced is ${formatShare(unplaced.total)}: ${formatShare(
    unplaced.unknownCountry,
  )} is ${formatCount(unplaced.unknownCompanies)} ${
    unplaced.unknownCompanies === 1 ? "company" : "companies"
  } the release has no country for, ${formatShare(
    unplaced.unmatchedSecurities,
  )} is share positions inside funds that resolved to no company, ${formatShare(
    unplaced.unmatchedCashDerivatives,
  )} is cash and derivative lines inside funds, ${formatShare(
    unplaced.cash,
  )} is cash you hold, ${overshootClause}`;

  return (
    <div className="stack">
      <LensProblem model={model} />
      <LensLede>
        Every company the ledger resolved, split by the market its domicile belongs to,
        plus one dashed segment for the weight the filings cannot place. Weight is a share
        of your whole portfolio. The countries behind the segments are in the second
        table, with the two-letter code printed rather than implied.
      </LensLede>

      <div className="stack stack--tight">
        <div className="bar bar--tall" aria-hidden="true">
          {segments.map((segment) => (
            <span
              key={segment.bucket}
              className={`bar__seg ${SEGMENT_BACKGROUND[segment.bucket]}`}
              style={{
                width: `${drawn > 0 ? (Math.max(0, segment.weight) / drawn) * 100 : 0}%`,
              }}
            />
          ))}
        </div>
        <div className="legend">
          {segments.map((segment) => (
            <span key={segment.bucket} className="legend__item">
              <span
                className={`legend__swatch ${SEGMENT_BACKGROUND[segment.bucket]}`}
                aria-hidden="true"
              />
              {ROW_WORD[segment.bucket]}
            </span>
          ))}
        </div>
        <div className="prose">
          <p className="small muted">
            The bar draws five shares of one total — the weight the filings place in a
            company, plus the weight they place nowhere — and the table beneath it prints
            each one. {unplacedSentence}
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
              The five segments in the order the bar draws them. Weight is a share of the
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
              {segments.map((segment) => (
                <tr
                  key={segment.bucket}
                  data-tier={segment.bucket === "UNKNOWN" ? "OTHER" : segment.bucket}
                  data-country-missing={segment.bucket === "UNKNOWN" ? "true" : undefined}
                >
                  <th scope="row">
                    {ROW_WORD[segment.bucket]}
                    {segment.bucket === "UNKNOWN" ? (
                      <CellNote>
                        drawn as one dashed segment; its parts are under the bar
                      </CellNote>
                    ) : null}
                  </th>
                  <td className="num">{formatShare(segment.weight)}</td>
                  <td className="num">
                    {formatCount(segment.companies)}
                    {segment.bucket === "UNKNOWN" ? (
                      <CellNote>companies with no country answer</CellNote>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">Everything the bar draws</th>
                <td className="num">{formatShare(drawn)}</td>
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
              largest country. A row with no code is a company the release cannot place:
              its edge is dashed and it counts inside Unplaced in the table above.{" "}
              {split.countries.length > 0
                ? `Developed and emerging follow the ${TIER_CONVENTION}, as of ${TIER_AS_OF}.`
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
              {split.countries.map((country) => {
                const bucket: MarketBucket = country.code
                  ? (country.tier ?? "OTHER")
                  : "UNKNOWN";
                return (
                  <tr
                    key={country.code ?? "no-country"}
                    data-tier={bucket === "UNKNOWN" ? "OTHER" : bucket}
                    data-country-missing={country.code === null ? "true" : undefined}
                  >
                    <th scope="row">
                      <span className="country-tag">{country.code ?? "no code"}</span>
                    </th>
                    <td>
                      {country.tier ? TIER_WORD[country.tier] : "No country answer"}
                    </td>
                    <td className="num">{formatShare(country.weight)}</td>
                    <td className="num">{formatCount(country.companies)}</td>
                    <td>
                      <span className="rowbar">
                        <span
                          className={`rowbar__fill ${ROW_FILL[bucket]}`}
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
                );
              })}
            </tbody>
          </table>
        </div>
      </LensSection>
    </div>
  );
}
