"use client";

/**
 * The concentration curve: how fast the money piles up in the largest companies.
 *
 * It is the deeper view behind "See the curve" in the Effective holdings block, and it is
 * loaded only when that expander opens — the module and its d3 imports are a lazy chunk,
 * so nothing here is in the first page bundle.
 *
 * d3 computes the scales, the path strings and the tick positions; React renders the SVG.
 * There is no d3-selection: the chart is a pure function of its props, which is what keeps
 * it testable and keeps the DOM out of the maths. The two series share one log-rank grid,
 * so the gap between them is a real area rather than two independently sampled lines.
 *
 * The chart is never the only carrier: the summary sentence above it states the half-way
 * ranks in words, the legend names both series, and a visually hidden table prints the
 * curve at the ranks a reader is most likely to want.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { scaleLinear, scaleLog } from "d3-scale";
import { area, curveStepAfter, line } from "d3-shape";

import {
  cumulativeCurve,
  curveAriaLabel,
  invertRank,
  k50,
  logGrid,
  resample,
  sortWeights,
  summarySentence,
  topShare,
  type WeightedCompany,
} from "@/lib/concentration";

import styles from "./ConcentrationCurve.module.css";

export interface CurveProps {
  you: WeightedCompany[];
  benchmark: { ticker: string; weights: WeightedCompany[] } | null;
}

const MARGIN = { top: 16, right: 24, bottom: 40, left: 48 };
const Y_TICKS = [0, 0.25, 0.5, 0.75, 1];
const TABLE_RANKS = [1, 5, 10, 25, 50, 100, 250, 500, 1000];

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function ConcentrationCurve({ you, benchmark }: CurveProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<{ rank: number; pinned: boolean } | null>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    setWidth(element.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);

  const youSorted = useMemo(() => sortWeights(you), [you]);
  const youCurve = useMemo(() => cumulativeCurve(you), [you]);
  const benchCurve = useMemo(
    () => (benchmark ? cumulativeCurve(benchmark.weights) : []),
    [benchmark],
  );

  const nYou = youCurve.length;
  const nBench = benchCurve.length;
  const maxN = Math.max(nYou, nBench, 1);
  const grid = useMemo(() => logGrid(maxN), [maxN]);
  const youPoints = useMemo(() => resample(youCurve, grid), [youCurve, grid]);
  const benchPoints = useMemo(() => resample(benchCurve, grid), [benchCurve, grid]);

  const height = width > 0 && width < 640 ? 220 : 300;
  const plotW = Math.max(10, width - MARGIN.left - MARGIN.right);
  const plotH = Math.max(10, height - MARGIN.top - MARGIN.bottom);

  const x = useMemo(
    () =>
      scaleLog()
        .domain([1, maxN])
        .range([MARGIN.left, MARGIN.left + plotW]),
    [maxN, plotW],
  );
  const y = useMemo(
    () =>
      scaleLinear()
        .domain([0, 1])
        .range([MARGIN.top + plotH, MARGIN.top]),
    [plotH],
  );

  const youLine = useMemo(
    () =>
      line<[number, number]>()
        .x((point) => x(point[0]))
        .y((point) => y(point[1]))
        .curve(curveStepAfter),
    [x, y],
  );
  const benchLine = useMemo(
    () =>
      line<[number, number]>()
        .x((point) => x(point[0]))
        .y((point) => y(point[1]))
        .curve(curveStepAfter),
    [x, y],
  );
  const gapArea = useMemo(
    () =>
      area<{ rank: number; you: number; bench: number }>()
        .x((point) => x(point.rank))
        .y0((point) => y(point.bench))
        .y1((point) => y(point.you))
        .curve(curveStepAfter),
    [x, y],
  );

  const kYou = k50(youCurve);
  const kBench = nBench > 0 ? k50(benchCurve) : null;
  const top10Rank = Math.min(10, nYou);
  const top10You = topShare(youCurve, 10);
  const top10Bench = nBench > 0 ? topShare(benchCurve, 10) : null;

  const summary = summarySentence(
    kYou,
    benchmark && kBench !== null ? { ticker: benchmark.ticker, k50: kBench } : null,
  );
  const ariaLabel = curveAriaLabel(
    summary,
    top10You,
    benchmark && top10Bench !== null
      ? { ticker: benchmark.ticker, top10: top10Bench }
      : null,
  );

  if (nYou === 1) {
    return (
      <p className="small muted">
        Your portfolio is one company, so 100% of your money is in it.
      </p>
    );
  }

  if (width === 0) {
    return <div ref={containerRef} className={styles.wrapper} aria-hidden="true" />;
  }

  const xTicks = [1, 10, 100, 1000, 10000].filter((tick) => tick <= maxN);
  const minorTicks: number[] = [];
  for (const power of [1, 10, 100, 1000]) {
    for (let digit = 2; digit <= 9; digit += 1) {
      const tick = power * digit;
      if (tick <= maxN) minorTicks.push(tick);
    }
  }
  const narrow = width < 320;

  const hoverRank = hover?.rank ?? null;
  const hoverYou =
    hoverRank === null ? null : (youCurve[Math.min(hoverRank, nYou) - 1] ?? 1);
  const hoverBench =
    hoverRank === null || nBench === 0
      ? null
      : (benchCurve[Math.min(hoverRank, nBench) - 1] ?? 1);
  const hoverCompany =
    hoverRank !== null && hoverRank <= nYou ? youSorted[hoverRank - 1] : null;

  const move = (rank: number) => {
    setHover({ rank: Math.min(maxN, Math.max(1, rank)), pinned: hover?.pinned ?? false });
  };

  const onKeyDown = (event: React.KeyboardEvent<SVGSVGElement>) => {
    const current = hover?.rank ?? 1;
    if (event.key === "ArrowRight") {
      event.preventDefault();
      move(event.shiftKey ? current * 10 : current + 1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      move(event.shiftKey ? Math.max(1, Math.round(current / 10)) : current - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      move(1);
    } else if (event.key === "End") {
      event.preventDefault();
      move(maxN);
    } else if (event.key === "Escape") {
      setHover(null);
    }
  };

  const onPointerMove = (event: React.PointerEvent<SVGRectElement>) => {
    const rect = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (!rect) return;
    const px = ((event.clientX - rect.left) / rect.width) * width;
    move(invertRank(px, MARGIN.left, plotW, maxN));
  };

  const onPointerDown = (event: React.PointerEvent<SVGRectElement>) => {
    const rect = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (!rect) return;
    const px = ((event.clientX - rect.left) / rect.width) * width;
    const rank = invertRank(px, MARGIN.left, plotW, maxN);
    setHover((previous) =>
      previous?.pinned && previous.rank === rank ? null : { rank, pinned: true },
    );
  };

  const gapPoints = youPoints.map(([rank, youValue]) => ({
    rank,
    you: youValue,
    bench: benchCurve[Math.min(rank, nBench) - 1] ?? 1,
  }));
  const tooltipLeft = hoverRank === null ? 0 : x(hoverRank);
  const flip = tooltipLeft > width * 0.6;

  return (
    <div ref={containerRef} className={styles.wrapper}>
      <p className={styles.summary}>{summary}</p>
      <p className={styles.legend}>
        <span className={styles.swatchYou} aria-hidden="true" /> You
        {benchmark ? (
          <>
            {" "}
            <span className={styles.swatchBench} aria-hidden="true" /> {benchmark.ticker}
          </>
        ) : null}
      </p>

      <div className={styles.chartWrap}>
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={ariaLabel}
          tabIndex={0}
          className={styles.svg}
          onKeyDown={onKeyDown}
        >
          {Y_TICKS.map((tick) => (
            <g key={`y-${tick}`}>
              <line
                x1={MARGIN.left}
                x2={MARGIN.left + plotW}
                y1={y(tick)}
                y2={y(tick)}
                className={styles.grid}
              />
              <text
                x={MARGIN.left - 8}
                y={y(tick) + 4}
                textAnchor="end"
                className={styles.tick}
              >
                {Math.round(tick * 100)}%
              </text>
            </g>
          ))}

          {!narrow
            ? minorTicks.map((tick) => (
                <line
                  key={`minor-${tick}`}
                  x1={x(tick)}
                  x2={x(tick)}
                  y1={MARGIN.top + plotH}
                  y2={MARGIN.top + plotH + 4}
                  className={styles.minorTick}
                />
              ))
            : null}

          {xTicks.map((tick) => (
            <g key={`x-${tick}`}>
              <line
                x1={x(tick)}
                x2={x(tick)}
                y1={MARGIN.top + plotH}
                y2={MARGIN.top + plotH + 6}
                className={styles.axis}
              />
              <text
                x={x(tick)}
                y={MARGIN.top + plotH + 20}
                textAnchor="middle"
                className={styles.tick}
              >
                {tick.toLocaleString("en-US")}
              </text>
            </g>
          ))}

          {!narrow ? (
            <>
              <text
                x={MARGIN.left + plotW / 2}
                y={height - 4}
                textAnchor="middle"
                className={styles.axisTitle}
              >
                Number of companies, largest first
              </text>
              <text
                x={12}
                y={MARGIN.top + plotH / 2}
                textAnchor="middle"
                transform={`rotate(-90 12 ${MARGIN.top + plotH / 2})`}
                className={styles.axisTitle}
              >
                Share of your money
              </text>
            </>
          ) : null}

          {benchmark && benchPoints.length > 0 ? (
            <path d={gapArea(gapPoints) ?? ""} className={styles.gap} />
          ) : null}
          {benchmark && benchPoints.length > 0 ? (
            <path d={benchLine(benchPoints) ?? ""} className={styles.benchLine} />
          ) : null}
          <path d={youLine(youPoints) ?? ""} className={styles.youLine} />

          <line
            x1={MARGIN.left}
            x2={MARGIN.left + plotW}
            y1={y(0.5)}
            y2={y(0.5)}
            className={styles.halfLine}
          />
          <circle cx={x(kYou)} cy={y(0.5)} r={3.5} className={styles.dotYou} />
          <text
            x={x(kYou)}
            y={y(0.5) - 8}
            textAnchor="middle"
            className={styles.annotation}
          >
            {kYou}
          </text>
          {benchmark && kBench !== null ? (
            <>
              <circle cx={x(kBench)} cy={y(0.5)} r={3.5} className={styles.dotBench} />
              <text
                x={x(kBench)}
                y={y(0.5) + 16}
                textAnchor="middle"
                className={styles.annotation}
              >
                {kBench}
              </text>
            </>
          ) : null}

          <line
            x1={x(top10Rank)}
            x2={x(top10Rank)}
            y1={MARGIN.top}
            y2={MARGIN.top + plotH}
            className={styles.topLine}
          />
          <text
            x={x(top10Rank)}
            y={MARGIN.top - 4}
            textAnchor="middle"
            className={styles.annotation}
          >
            {nYou < 10 ? `All ${nYou}` : "Top 10"}
          </text>
          <circle
            cx={x(top10Rank)}
            cy={y(youCurve[top10Rank - 1] ?? 1)}
            r={3}
            className={styles.dotYou}
          />
          {benchmark && nBench > 0 ? (
            <circle
              cx={x(top10Rank)}
              cy={y(benchCurve[Math.min(top10Rank, nBench) - 1] ?? 1)}
              r={3}
              className={styles.dotBench}
            />
          ) : null}

          {hoverRank !== null ? (
            <g>
              <line
                x1={x(hoverRank)}
                x2={x(hoverRank)}
                y1={MARGIN.top}
                y2={MARGIN.top + plotH}
                className={styles.crosshair}
              />
              <circle
                cx={x(hoverRank)}
                cy={y(hoverYou ?? 1)}
                r={3.5}
                className={styles.dotYou}
              />
              {hoverBench !== null ? (
                <circle
                  cx={x(hoverRank)}
                  cy={y(hoverBench)}
                  r={3.5}
                  className={styles.dotBench}
                />
              ) : null}
            </g>
          ) : null}

          <rect
            x={MARGIN.left}
            y={MARGIN.top}
            width={plotW}
            height={plotH}
            fill="transparent"
            onPointerMove={onPointerMove}
            onPointerDown={onPointerDown}
            onPointerLeave={() => {
              if (!hover?.pinned) setHover(null);
            }}
          />
        </svg>

        {hoverRank !== null ? (
          <div
            className={styles.tooltip}
            style={{
              left: tooltipLeft,
              top: MARGIN.top + 8,
              transform: flip ? "translateX(-100%)" : undefined,
            }}
          >
            <p className={styles.tooltipTitle}>Top {hoverRank} companies</p>
            <p>
              You: {pct(hoverYou ?? 1)}
              {benchmark && hoverBench !== null
                ? ` · ${benchmark.ticker}: ${pct(hoverBench)}`
                : ""}
            </p>
            {hoverCompany ? (
              <p className={styles.tooltipCompany}>
                #{hoverRank} for you: {hoverCompany.name}
                {hoverCompany.ticker ? ` (${hoverCompany.ticker})` : ""}{" "}
                {pct(hoverCompany.weight)}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      <table className={styles.srOnly}>
        <caption>{summary}</caption>
        <thead>
          <tr>
            <th scope="col">Rank</th>
            <th scope="col">You %</th>
            {benchmark ? <th scope="col">{benchmark.ticker} %</th> : null}
          </tr>
        </thead>
        <tbody>
          {TABLE_RANKS.filter((rank) => rank <= maxN).map((rank) => (
            <tr key={rank}>
              <th scope="row">{rank}</th>
              <td>{pct(youCurve[Math.min(rank, nYou) - 1] ?? 1)}</td>
              {benchmark ? (
                <td>{pct(benchCurve[Math.min(rank, nBench) - 1] ?? 1)}</td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
