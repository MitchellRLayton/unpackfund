"use client";

import { useMemo, useState } from "react";

import { FUNDS, ORDER, type Fund, type Measure } from "./data";
import s from "./panel.module.css";

type Variant = "a" | "b" | "c";

/** Highest-coverage measure leads: ROE covers 92.5–98.5 % of every US fund, CBOP 90.1–96.7 %, OP 76.9–89.3 % of applicable weight. */
const VARIANTS: { key: Variant; label: string; hint: string }[] = [
  { key: "a", label: "A · headline + disclosure", hint: "ROE as the one big number, its limitation beside it" },
  { key: "b", label: "B · three measures, one axis", hint: "bars against each measure's peer range" },
  { key: "c", label: "C · table first", hint: "no headline, a row per measure" },
];

const pct = (x: number | null, digits = 1) => (x == null ? "—" : `${(x * 100).toFixed(digits)}%`);

function gate(cov: number): { tone: "ok" | "warn" | "low"; text: string } {
  if (cov >= 80) return { tone: "ok", text: `${cov.toFixed(1)}% · rankable` };
  if (cov >= 60) return { tone: "warn", text: `${cov.toFixed(1)}% · unranked` };
  return { tone: "low", text: `${cov.toFixed(1)}% · suppressed` };
}

const ROWS: { key: keyof Fund; name: string; note: string }[] = [
  { key: "roe", name: "ROE", note: "Profit against book value — highest coverage, most distorted by buybacks and debt." },
  { key: "op", name: "Operating profit", note: "Operating quality, interest deducted. Applies to the non-financial weight only." },
  { key: "cbop", name: "Cash operating return", note: "Accruals stripped — cash actually collected, one of the two operating measures." },
  { key: "lev", name: "Leverage", note: "Context for ROE: high ROE with high leverage is not high quality." },
];

export function Panel() {
  const [variant, setVariant] = useState<Variant>("a");
  const [fundKey, setFundKey] = useState<string>("AVUV");
  const fund = FUNDS[fundKey] ?? FUNDS.AVUV!;

  const peers = useMemo(() => Object.values(FUNDS).filter((f) => f.supported), []);
  const maxAll = useMemo(
    () => Math.max(...peers.flatMap((f) => [f.roe.median, f.op.median, f.cbop.median].filter((v): v is number => v != null))) * 1.05,
    [peers],
  );
  const span = (key: "roe" | "op" | "cbop"): [number, number] => {
    const vals = peers.map((f) => f[key].median).filter((v): v is number => v != null);
    return [Math.min(...vals), Math.max(...vals)];
  };
  const pos = (x: number) => Math.max(0, Math.min(100, (x / maxAll) * 100));

  const measure = (key: keyof Fund) => fund[key] as Measure;
  const g = (key: "roe" | "op" | "cbop") => gate(measure(key).cov);

  return (
    <div className={s.wrap}>
      <header className={s.head}>
        <h1 className={s.title}>Profitability panel</h1>
        <p className={s.sub}>
          Prototype — not the live product. Real holdings and fundamentals, SEC EDGAR only, as of each fund&apos;s holdings date.
        </p>
      </header>

      <div className={s.question}>
        <strong>Question:</strong> how should a fund page present profitability when ROE is the headline, operating profit the
        fallback, and cash operating return the highest-coverage of the two operating measures? The three variants differ in
        hierarchy, not styling.
      </div>

      <div className={s.controls}>
        <label className={s.lbl} htmlFor="fund">Fund</label>
        <select id="fund" className={s.select} value={fundKey} onChange={(e) => setFundKey(e.target.value)}>
          {ORDER.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <div className={s.tabs} role="tablist" aria-label="Variant">
          {VARIANTS.map((v) => (
            <button
              key={v.key}
              role="tab"
              aria-selected={variant === v.key}
              className={variant === v.key ? `${s.tab} ${s.tabOn}` : s.tab}
              onClick={() => setVariant(v.key)}
              title={v.hint}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>

      <section className={s.card}>
        <div className={s.cardHead}>
          <span className={s.fund}>{fundKey}</span>
          <span className={s.meta}>
            holdings as of {fund.report_date} · {fund.nav_b.toFixed(2)} billion net assets · {fund.fin_pct.toFixed(1)}% banks and insurers
          </span>
        </div>

        {!fund.supported ? (
          <p className={s.unsupported}>
            This fund holds mostly non-US issuers with no SEC filing, so none of the three measures reaches the coverage bar.
            The panel shows nothing rather than a partial number.
          </p>
        ) : variant === "a" ? (
          <>
            <div className={s.lbl}>Return on equity</div>
            <div className={s.big}>
              {pct(fund.roe.median)} <small>weighted median · {fund.roe.n ?? 0} companies</small>
            </div>
            <p className={s.note}>Leverage {pct(fund.lev.median, 0)} of assets — read the two together.</p>
            <div className={s.disclose}>
              <h2 className={s.warnHead}>What ROE can and cannot tell you</h2>
              ROE is profit divided by accounting book value. Buybacks shrink book value, so a company that has repurchased most
              of its equity can show a high ROE without being any more profitable, and a company with thin or negative book value
              drops out entirely. ROE also rises with debt. Read it beside the leverage figure and the operating measures, never
              on its own.
            </div>
            <div className={s.tiles}>
              <div className={s.tile}>
                <div className={s.lbl}>Operating profit</div>
                <div className={s.tileValue}>{pct(fund.op.median)}</div>
                <div className={s.note}>covers {fund.op.cov.toFixed(1)}% of applicable weight</div>
              </div>
              <div className={s.tile}>
                <div className={s.lbl}>Cash operating return</div>
                <div className={s.tileValue}>{pct(fund.cbop.median)}</div>
                <div className={s.note}>covers {fund.cbop.cov.toFixed(1)}% of weight</div>
              </div>
              <div className={s.tile}>
                <div className={s.lbl}>Leverage</div>
                <div className={s.tileValue}>{pct(fund.lev.median, 0)}</div>
                <div className={s.note}>of assets funded by debt and other liabilities</div>
              </div>
            </div>
            <div className={s.pills}>
              {(["roe", "op", "cbop"] as const).map((k) => {
                const t = g(k);
                return <span key={k} className={`${s.pill} ${s[t.tone]}`}>{k.toUpperCase()} {t.text}</span>;
              })}
            </div>
          </>
        ) : variant === "b" ? (
          <>
            <div className={s.bars}>
              {(["roe", "op", "cbop"] as const).map((k) => {
                const m = measure(k);
                const [lo, hi] = span(k);
                return (
                  <div key={k} className={s.row}>
                    <span className={s.rowName}>{k === "cbop" ? "Cash operating return" : k === "op" ? "Operating profit" : "ROE"}</span>
                    <span className={s.track}>
                      <i className={s.band} style={{ left: `${pos(lo)}%`, width: `${Math.max(2, pos(hi) - pos(lo))}%` }} />
                      <i className={s.fill} style={{ width: `${pos(m.median ?? 0)}%` }} />
                    </span>
                    <span className={s.num}>{pct(m.median)}</span>
                    <span className={s.numMuted}>{m.cov.toFixed(0)}% cov</span>
                  </div>
                );
              })}
            </div>
            <p className={s.note}>
              The shaded span behind each bar is the range across the ten US funds measured. The three measures share a scale but
              are not comparable to each other — different denominators — so read each against its own range, never against the
              neighbouring bar.
            </p>
            <div className={s.disclose}>
              <h2 className={s.warnHead}>What ROE can and cannot tell you</h2>
              Buybacks shrink book value, so a repurchasing company can show a high ROE without being more profitable; thin or
              negative book value drops out entirely; and ROE rises with debt. Read it beside leverage and the operating measures.
            </div>
            <div className={s.disclose}>
              <h2 className={s.warnHead}>What cash operating return can and cannot tell you</h2>
              Operating cash flow plus interest, divided by book value. It strips accounting accruals, so it is closer to cash
              actually collected — a cash-flow analogue of cash-based operating profitability, not the academic accrual-adjustment
              construction. It still carries working-capital swings and one-off cash items, and it depends on the same book value
              ROE does.
            </div>
            <div className={s.pills}>
              {(["roe", "op", "cbop"] as const).map((k) => {
                const t = g(k);
                return <span key={k} className={`${s.pill} ${s[t.tone]}`}>{k.toUpperCase()} {t.text}</span>;
              })}
            </div>
          </>
        ) : (
          <>
            <table className={s.table}>
              <thead>
                <tr><th>Measure</th><th>Median</th><th>Mean</th><th>Coverage</th><th>Read it as</th></tr>
              </thead>
              <tbody>
                {ROWS.map((r) => {
                  const m = measure(r.key);
                  return (
                    <tr key={r.key}>
                      <td><strong>{r.name}</strong></td>
                      <td className={s.num}>{pct(m.median)}</td>
                      <td className={s.num}>{pct(m.mean)}</td>
                      <td className={s.num}>{m.cov.toFixed(1)}%</td>
                      <td>{r.note}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className={s.disclose}>
              <h2 className={s.warnHead}>What ROE can and cannot tell you</h2>
              ROE is profit divided by accounting book value. Buybacks shrink book value, so a company that has repurchased most
              of its equity can show a high ROE without being any more profitable, and a company with thin or negative book value
              drops out entirely. ROE also rises with debt. Read it beside the leverage figure and the operating measures, never
              on its own.
            </div>
            <div className={s.pills}>
              {(["roe", "op", "cbop"] as const).map((k) => {
                const t = g(k);
                return <span key={k} className={`${s.pill} ${s[t.tone]}`}>{k.toUpperCase()} {t.text}</span>;
              })}
            </div>
          </>
        )}
      </section>

      <p className={s.foot}>
        Coverage is the share of the fund&apos;s equity holdings, by value, for which that measure can be computed — except
        operating profit, which is measured against the non-financial weight because banks and insurers are outside the
        definition. Values are weighted medians; the winsorised mean is shown beside them. Source: SEC EDGAR.
      </p>
    </div>
  );
}
