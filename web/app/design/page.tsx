import type { Metadata } from "next";

/**
 * The component page: every token and every primitive, on one screen.
 *
 * This exists so a change to `globals.css` can be *looked at* rather than
 * reasoned about, and so the two-pane workspace, the tables and the charts share
 * one reference for what "right" means. It is also the honest answer to "what
 * does the design system consist of" — if a component is not on this page, it is
 * not in the system.
 *
 * Deliberately not linked from the site's navigation: it is a workbench, not a
 * page a reader needs. It is `noindex` for the same reason.
 */

export const metadata: Metadata = {
  title: "Design system — UnpackFund",
  robots: { index: false, follow: false },
};

const SURFACES = [
  ["--paper", "page background"],
  ["--surface", "raised panel"],
  ["--wash", "subtle fill"],
  ["--wash-strong", "hover fill"],
  ["--rule", "hairline rule"],
  ["--rule-strong", "emphasised rule"],
  ["--ink", "body text"],
  ["--graphite", "secondary text"],
] as const;

const SEMANTIC = [
  ["--tier-us", "US"],
  ["--tier-dm", "international developed ex-US"],
  ["--tier-em", "emerging"],
  ["--tier-none", "untiered"],
  ["--alert", "error only"],
  ["--delta-up", "above zero"],
  ["--delta-down", "below zero"],
  ["--tint-direct", "directly held"],
] as const;

const TYPE_SCALE = [
  ["--text-40", "40", "page title"],
  ["--text-28", "28", "section title"],
  ["--text-20", "20", "panel title"],
  ["--text-16", "16", "body"],
  ["--text-14", "14", "table, secondary"],
  ["--text-12", "12", "labels, captions"],
] as const;

const ROWS = [
  ["Apple Inc.", "AAPL", "US", "US", 6.12, 58, 4],
  ["Microsoft Corp.", "MSFT", "US", "US", 5.44, 58, 4],
  ["Nestlé S.A.", "NESN", "CH", "DM", 2.31, 41, 3],
  ["Taiwan Semiconductor", "TSM", "TW", "EM", 2.04, 44, 3],
  ["Samsung Electronics", "005930", "KR", "EM", 1.72, 39, 2],
  ["Cayman holdco", "—", "KY", "US", 0.86, 0, 1],
] as const;

export default function DesignPage() {
  return (
    <main id="main" className="shell page">
      <p className="eyebrow">Design system</p>
      <h1 className="title">UnpackFund, as components</h1>
      <p className="lede">
        Every token and primitive the site is built from, on one page. Numbers are tabular
        everywhere; colour only ever means something.
      </p>

      <section className="stack stack--loose">
        <h2 className="title--sm">Colour</h2>
        <p className="muted small">
          OKLCH, with a dark scheme that swaps lightness rather than hue. The two rows are
          the page&apos;s structural colours and the ones that carry meaning.
        </p>

        <div className="panel">
          <div className="panel__head">
            <h3 className="panel__title">Surfaces and ink</h3>
          </div>
          <div className="panel__body">
            <div className="swatches">
              {SURFACES.map(([token, label]) => (
                <div key={token} className="swatch">
                  <span
                    className="swatch__chip"
                    style={{ background: `var(${token})` }}
                    aria-hidden="true"
                  />
                  <span className="mono tiny">{token}</span>
                  <span className="tiny muted">{label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="panel__head">
            <h3 className="panel__title">Meaning</h3>
          </div>
          <div className="panel__body">
            <div className="swatches">
              {SEMANTIC.map(([token, label]) => (
                <div key={token} className="swatch">
                  <span
                    className="swatch__chip"
                    style={{ background: `var(${token})` }}
                    aria-hidden="true"
                  />
                  <span className="mono tiny">{token}</span>
                  <span className="tiny muted">{label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="stack stack--loose">
        <h2 className="title--sm">Type</h2>
        <p className="muted small">
          Inter for the interface (tabular figures), Newsreader for page titles and the
          answer strip, IBM Plex Mono for tickers and codes. All three are self-hosted
          from <span className="mono">/fonts</span> — no third-party font request anywhere
          on the site.
        </p>

        <div className="panel">
          <div className="panel__head">
            <h3 className="panel__title">Scale</h3>
          </div>
          <div className="panel__body stack stack--tight">
            {TYPE_SCALE.map(([token, size, use]) => (
              <div key={token} className="row row--between type-row">
                <span style={{ fontSize: `var(${token})` }}>
                  See the companies you actually own
                </span>
                <span className="mono tiny muted">
                  {size}px · {use}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="panel__body stack stack--tight">
            <p className="title" style={{ fontSize: "var(--text-40)" }}>
              Newsreader, 40
            </p>
            <p className="title--sm">Newsreader, 28</p>
            <p className="answer__sentence">
              You own 3,127 companies through 3 funds. Your ten largest are{" "}
              <strong>18.4%</strong> of the mix.
            </p>
            <p>
              Body text at 16 with a 68-character measure. A number in a sentence is still
              tabular: <span className="num">6.12%</span>.
            </p>
            <p className="mono">VTI · VXUS · BND · AAPL · c_0000320193</p>
          </div>
        </div>
      </section>

      <section className="stack stack--loose">
        <h2 className="title--sm">Buttons and fields</h2>
        <div className="panel">
          <div className="panel__body stack">
            <div className="row">
              <button type="button" className="btn btn--primary">
                Copy share link
              </button>
              <button type="button" className="btn">
                Export CSV
              </button>
              <button type="button" className="btn btn--quiet">
                Compare
              </button>
              <button type="button" className="btn btn--sm">
                Add
              </button>
              <button type="button" className="btn btn--icon" aria-label="Remove">
                ×
              </button>
            </div>

            <div className="field" style={{ maxWidth: "28rem" }}>
              <label className="field__label" htmlFor="design-holdings">
                Add a fund or stock
              </label>
              <input
                id="design-holdings"
                className="field__input"
                placeholder="VTI, Vanguard Total Stock Market ETF, or AAPL"
                defaultValue="VTI"
              />
              <p className="field__hint">
                Ticker, fund name, issuer, or a stock symbol. Percentages or dollars.
              </p>
            </div>

            <div className="suggest" style={{ maxWidth: "28rem" }}>
              <button type="button" className="suggest__item">
                <span className="suggest__ticker mono">VTI</span>
                <span className="suggest__name">Vanguard Total Stock Market ETF</span>
                <span className="suggest__meta small muted">70% covered</span>
              </button>
              <button type="button" className="suggest__item">
                <span className="suggest__ticker mono">VOO</span>
                <span className="suggest__name">Vanguard S&amp;P 500 ETF</span>
                <span className="suggest__meta small muted">70% covered</span>
              </button>
            </div>

            <div className="field" style={{ maxWidth: "28rem" }}>
              <label className="field__label" htmlFor="design-amount">
                Weight
              </label>
              <input
                id="design-amount"
                className="field__input num"
                defaultValue="60"
                inputMode="decimal"
              />
              <p className="field__error">
                <span aria-hidden="true">!</span> That is more than 100%.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="stack stack--loose">
        <h2 className="title--sm">Chips and dates</h2>
        <p className="muted small">
          A chip is the shortest true statement about a number: how much of the fund was
          traced, or how old the filing is. It never replaces the number beside it.
        </p>
        <div className="panel">
          <div className="panel__body row">
            <span className="chip chip--full">Coverage 71.2%</span>
            <span className="chip chip--partial">Coverage 64.8%</span>
            <span className="chip chip--none">Coverage 41.0% · metrics withheld</span>
            <span className="chip chip--mono">VTI</span>
            <span className="chip chip--date">Jun 30, 2026</span>
            <span className="chip chip--old">Filed 212 days ago</span>
            <span className="country-tag">US</span>
            <span className="country-tag">CH</span>
            <span className="country-tag">TW</span>
            <span className="delta delta--up">(+2.54%)</span>
            <span className="delta delta--down">(-2.54%)</span>
          </div>
        </div>
      </section>

      <section className="stack stack--loose">
        <h2 className="title--sm">The answer strip</h2>
        <p className="muted small">
          Three to five fixed sentences, never generated text. Numbers in the sentence
          come from the same formatter the table uses, so the strip and the table cannot
          disagree.
        </p>
        <div className="panel">
          <div className="panel__body">
            <div className="answer">
              <p className="answer__sentence">
                You own <strong>3,127 companies</strong> through 3 funds. Your ten largest
                are <strong>18.4%</strong> of the mix, and the largest is Apple at 6.12%.
              </p>
              <p className="answer__sentence">
                <strong>63.0%</strong> is in the United States, 28.0% in international
                developed markets outside it, and 9.0% in emerging markets.
              </p>
              <p className="answer__note">
                Coverage 71.2% · reporting period Jun 30, 2026 · filed Aug 28, 2026 · 59
                days old.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="stack stack--loose">
        <h2 className="title--sm">Bars, meters and legends</h2>
        <div className="panel">
          <div className="panel__head">
            <h3 className="panel__title">Market split, one scale</h3>
          </div>
          <div className="panel__body stack">
            <div>
              <p className="small muted">This mix</p>
              <div
                className="bar bar--tall"
                role="img"
                aria-label="This mix: 63.0% United States, 28.0% international developed ex-US, 9.0% emerging markets"
              >
                <span className="bar__seg bar__seg--us" style={{ width: "63%" }} />
                <span className="bar__seg bar__seg--dm" style={{ width: "28%" }} />
                <span className="bar__seg bar__seg--em" style={{ width: "9%" }} />
              </div>
            </div>
            <div>
              <p className="small muted">The benchmark</p>
              <div
                className="bar bar--tall"
                role="img"
                aria-label="Benchmark: 64.0% United States, 27.0% international developed ex-US, 9.0% emerging markets"
              >
                <span className="bar__seg bar__seg--us" style={{ width: "64%" }} />
                <span className="bar__seg bar__seg--dm" style={{ width: "27%" }} />
                <span className="bar__seg bar__seg--em" style={{ width: "9%" }} />
              </div>
            </div>
            <div className="legend">
              <span className="legend__item">
                <span className="legend__swatch bar__seg--us" aria-hidden="true" /> United
                States 63.0%
              </span>
              <span className="legend__item">
                <span className="legend__swatch bar__seg--dm" aria-hidden="true" />{" "}
                International Developed ex-US 28.0%
              </span>
              <span className="legend__item">
                <span className="legend__swatch bar__seg--em" aria-hidden="true" />{" "}
                Emerging Markets 9.0%
              </span>
            </div>

            <div className="stack stack--tight">
              <div className="row">
                <span className="mono tiny" style={{ width: "4rem" }}>
                  AAPL
                </span>
                <span className="rowbar" style={{ flex: 1 }}>
                  <span
                    className="rowbar__fill rowbar__fill--us"
                    style={{ width: "100%" }}
                  />
                </span>
                <span className="num tiny">6.12%</span>
              </div>
              <div className="row">
                <span className="mono tiny" style={{ width: "4rem" }}>
                  NESN
                </span>
                <span className="rowbar" style={{ flex: 1 }}>
                  <span
                    className="rowbar__fill rowbar__fill--dm"
                    style={{ width: "37%" }}
                  />
                </span>
                <span className="num tiny">2.31%</span>
              </div>
              <div className="row">
                <span className="mono tiny" style={{ width: "4rem" }}>
                  TSM
                </span>
                <span className="rowbar" style={{ flex: 1 }}>
                  <span
                    className="rowbar__fill rowbar__fill--em"
                    style={{ width: "33%" }}
                  />
                </span>
                <span className="num tiny">2.04%</span>
              </div>
              <div className="row">
                <span className="mono tiny" style={{ width: "4rem" }}>
                  —
                </span>
                <span className="rowbar" style={{ flex: 1 }}>
                  <span
                    className="rowbar__fill rowbar__fill--none"
                    style={{ width: "14%" }}
                  />
                </span>
                <span className="num tiny">0.86%</span>
              </div>
            </div>

            <div className="meter" aria-hidden="true">
              <span className="meter__track">
                <span className="meter__fill" style={{ width: "71.2%" }} />
              </span>
              <span className="meter__label small muted">Coverage 71.2%</span>
            </div>
          </div>
        </div>
      </section>

      <section className="stack stack--loose">
        <h2 className="title--sm">Tables</h2>
        <p className="muted small">
          A real table, with a caption that says what it is. A market tier is a left edge
          on the row plus a two-letter code in text, so the colour is never the only
          carrier of the fact. An untiered row is solid grey; an unknown country is
          dashed. A directly held row is tinted.
        </p>
        <div className="table-wrap">
          <table className="table">
            <caption className="small muted">
              Largest companies in the mix, by portfolio weight. Market tier is shown as a
              left edge and a country code.
            </caption>
            <thead>
              <tr>
                <th scope="col" className="num">
                  #
                </th>
                <th scope="col">Company</th>
                <th scope="col" aria-sort="none">
                  <button type="button" className="table__sort">
                    Country
                  </button>
                </th>
                <th scope="col" className="num">
                  Weight
                </th>
                <th scope="col" className="num">
                  Held by
                </th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map(([name, ticker, country, tier, weight, , funds], index) => (
                <tr
                  key={name}
                  data-tier={tier}
                  data-country-missing={country === null ? "true" : undefined}
                  data-direct={index === 1 ? "true" : undefined}
                >
                  <td className="num tiny muted">{index + 1}</td>
                  <td>
                    <span className="tier-edge" aria-hidden="true" />
                    <strong>{name}</strong>{" "}
                    <span className="mono tiny muted">{ticker}</span>
                  </td>
                  <td>
                    {country ? (
                      <span className="country-tag">{country}</span>
                    ) : (
                      <span className="muted">Unknown</span>
                    )}
                  </td>
                  <td className="num">{weight.toFixed(2)}%</td>
                  <td className="num">{funds}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="stack stack--loose">
        <h2 className="title--sm">Notices</h2>
        <div className="stack">
          <div className="notice">
            <p>
              <strong>Coverage 64.8%.</strong> Two funds in this mix do not trace enough
              of themselves to compute concentration, so those numbers are withheld rather
              than estimated.
            </p>
          </div>
          <div className="notice notice--quiet">
            <p>
              This portfolio is stored in the page&apos;s URL. Nothing is sent to a
              server, and clearing the address clears the portfolio.
            </p>
          </div>
          <div className="notice notice--alert">
            <p>
              <span className="notice__icon" aria-hidden="true">
                !
              </span>
              <strong>That link could not be opened.</strong> It contains a holding this
              version cannot read, so nothing was loaded.
            </p>
          </div>
          <p className="notice-line">
            <strong>Not investment advice.</strong> UnpackFund shows what funds hold, from
            public SEC filings. <a href="/disclaimer/">Read the full disclaimer</a>.
          </p>
        </div>
      </section>

      <section className="stack stack--loose">
        <h2 className="title--sm">Empty state</h2>
        <div className="empty">
          <p className="empty__title">Nothing in this portfolio yet</p>
          <p className="muted">
            Add a fund, a stock, or cash, and the companies behind them appear here.
          </p>
          <div className="ways-in">
            <div className="way">
              <p className="way__title">Type it</p>
              <p className="small muted">
                One line at a time, with a weight in percent or dollars.
              </p>
            </div>
            <div className="way">
              <p className="way__title">Paste it</p>
              <p className="small muted">
                A whole list at once — <span className="mono">VTI 40%</span>,{" "}
                <span className="mono">VXUS $12,000</span>.
              </p>
            </div>
            <div className="way">
              <p className="way__title">Try an example</p>
              <p className="small muted">Example portfolio, not a recommendation.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="stack stack--loose">
        <h2 className="title--sm">Reading layout</h2>
        <div className="prose">
          <p>
            Methodology, About, Glossary and the legal pages use the same reading layout:
            a 68-character measure, a sticky table of contents at large sizes, and section
            anchors a shared link can land on.
          </p>
        </div>
      </section>
    </main>
  );
}
