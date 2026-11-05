import type { Metadata } from "next";
import Link from "next/link";

import { ReadingLayout, type ReadingSection } from "@/components/prose/ReadingLayout";
import { Term } from "@/components/prose/Term";
import {
  CONTACT_EMAIL,
  EFFECTIVE_DATE,
  LEGAL_COPY_VERSION,
  LEGAL_ENTITY,
  METHODOLOGY_VERSION,
} from "@/lib/legal";

export const metadata: Metadata = {
  title: "UnpackFund — methodology",
  description:
    "How every number on UnpackFund is produced: the filings it reads, how a holding becomes a company, the look-through arithmetic, coverage and the 70/60 bands, the three dates, concentration, overlap, market tiers, the benchmark, and what is not known.",
};

/**
 * The headings, in order, for the table of contents.
 *
 * Written by hand next to the headings themselves rather than scraped from the
 * rendered page: this file is a server component, and the layout is not going to
 * run the page twice to find its own anchors. `ReadingLayout.test.tsx` renders
 * every page and fails if a link here has no heading with that id, so the two
 * cannot drift apart silently.
 */
const SECTIONS: readonly ReadingSection[] = [
  { id: "sources", title: "What the site reads" },
  { id: "holdings", title: "What a holding is" },
  { id: "identity", title: "How a holding becomes a company" },
  { id: "look-through", title: "How the look-through is computed" },
  { id: "coverage", title: "Coverage, and the 70/60 bands" },
  { id: "dates", title: "The three dates" },
  { id: "concentration", title: "Concentration" },
  { id: "effective-holdings", title: "Effective holdings" },
  { id: "overlap", title: "Overlap" },
  { id: "markets", title: "Market tiers" },
  { id: "markets-divergence", title: "Where the two conventions disagree", depth: 3 },
  {
    id: "markets-rules",
    title: "The three segments, and the rules that place a domicile",
    depth: 3,
  },
  { id: "country-decision", title: "How a country is decided", depth: 3 },
  { id: "country-contested", title: "When the vote cannot decide", depth: 3 },
  { id: "limits", title: "What is not known" },
  { id: "benchmark", title: "The benchmark: VT" },
  { id: "corrections", title: "Corrections" },
  { id: "attribution", title: "Source attribution" },
];

export default function MethodologyPage() {
  return (
    <ReadingLayout
      eyebrow="How it works"
      title="Methodology"
      lede="How every number on this site is produced, so a reader can decide how much to trust it. When the method changes, the version above changes, and the previous version stays readable in the site's public history."
      meta={`Effective ${EFFECTIVE_DATE} · version ${METHODOLOGY_VERSION} · copy ${LEGAL_COPY_VERSION}`}
      sections={SECTIONS}
    >
      <p>
        This page describes what the code does, not what it intends to do. Every number on
        the site is computed by the pipeline described here, and where a claim on this
        page and a number on another page disagree, the number is right and this page is a
        bug. The vocabulary is defined in the <Link href="/glossary/">glossary</Link>.
      </p>

      <h2 id="sources">What the site reads</h2>
      <p>
        Every number here comes from a filing the US Securities and Exchange Commission
        publishes. <Term name="n-port">Form N-PORT</Term> supplies the holdings: each fund
        lists its positions at a quarter-end, each with a value and a share of net assets.
        EDGAR&rsquo;s submission records supply the filings themselves — which series
        filed which form, and when — and two EDGAR ticker files supply identity: the
        exchange list for operating companies, and the fund list that maps a symbol to a
        CIK and a series. The GLEIF golden copy, which is CC0, supplies legal-entity
        identity, jurisdiction, and the ISIN-to-LEI mapping for issuers that file no
        N-PORT of their own.
      </p>
      <p>
        No issuer website, no vendor feed and no scraped page contributes a number to this
        site. A CUSIP is licensed data: the build reads one to match a position to a
        company and never publishes it, so the numbers here can be recomputed from the
        filings while the licensed identifier cannot be lifted from a page. Fund and
        company names are used descriptively, no SEC seal or logo is used, and neither the
        SEC nor GLEIF has reviewed or endorsed this site.
      </p>

      <p>
        Three sources that exist are deliberately not read: a fund&rsquo;s annual
        shareholder report (N-CSR), its summary prospectus (497K or 485BPOS), and the XBRL
        company facts published under data.sec.gov. The three numbers a reader might
        expect from those — a return, an expense ratio, a performance ranking — are absent
        for that reason, and the one that is here, the holdings, is recomputed from the
        positions rather than quoted from a summary.
      </p>

      <h2 id="holdings">What a holding is</h2>
      <p>
        A fund&rsquo;s N-PORT lists positions, each with a value and a percentage of net
        assets, and the release stores every percentage as whole{" "}
        <Term name="basis-point">basis points</Term> so no stored value carries a
        conversion error.
      </p>
      <p>
        Four kinds of row matter. A security row is a holding in an issuer. A{" "}
        <Term name="cash-line">cash line</Term> is money in cash or a cash equivalent:
        part of the fund, and with no company behind it by definition. A derivative row is
        an exposure rather than an issuer. A <Term name="fund">fund</Term> row is a
        position in another registered fund, and it may be followed through to what that
        fund holds — the next section says when.
      </p>
      <p>
        Nothing is inferred from a fund&rsquo;s name, its marketing page, or the index it
        tracks. If a position says it is a holding in a company, it is treated as one; if
        it is a fund, it is treated as a fund; if it is cash, it is cash.
      </p>

      <h2 id="identity">How a holding becomes a company</h2>
      <p>
        Each position is matched to a <Term name="company">company</Term> through the
        identifiers in the filing, deterministically, by the same rules on every build. An
        SEC operating company is keyed by its CIK. An issuer that files no N-PORT is keyed
        by a legal-entity identifier from GLEIF where the filing carries one. A ticker
        never decides identity on its own: a ticker or a name that resolves without
        corroboration is refused, which is why the same list of positions can resolve more
        completely on one release than on another.
      </p>
      <p>
        A position that cannot be matched is <Term name="unmapped-weight">unmapped</Term>:
        counted, split by cause, and printed as weight. It is never dropped, never
        back-filled from another source, and never spread across the companies that did
        resolve — that last rule is what stops a fund with 40% of its weight explained
        from looking average.
      </p>
      <p>
        Every holding that resolves to the same company is summed into one row, so two
        <Term name="share-class">share classes</Term> of one issuer are one company, and a
        stock you hold yourself lands on the same row as any fund&rsquo;s holding of it.
      </p>

      <h2 id="look-through">How the look-through is computed</h2>
      <p>
        The ledger answers one question: how much of each company does this portfolio own,
        directly or through the funds in it? That question is the{" "}
        <Term name="look-through">look-through</Term>, and for a company i the weight is
      </p>
      <p className="mono">total(i) = w_direct(i) + Σ_k W_k · w(i,k)</p>
      <p>
        where w_direct(i) is the weight of a{" "}
        <Term name="direct-holding">direct holding</Term>, W_k is your portfolio weight in
        fund k, and w(i,k) is company i&rsquo;s weight inside fund k. Each factor is a
        fraction of its own whole — W_k of the portfolio, w(i,k) of the fund&rsquo;s net
        assets — and the products are added into the company&rsquo;s row. Nothing is
        renormalised afterwards.
      </p>
      <p>
        Two consequences are intended. A company held through three funds counts once, at
        the sum of three products. A company a fund could not identify is not spread
        across the ones it could, so the unresolved share lowers coverage rather than
        inflating a resolved weight.
      </p>
      <p>
        A fund that holds other registered funds is followed through them, up to three
        hops, but only when that is worth publishing: the flattened vector replaces the
        as-filed one when at least 5% of the wrapper&rsquo;s net assets arrives through
        fund edges and the result fits in 6,000 rows. Below either bound — a target-date
        fund with twelve sleeves, say — the page names the funds the wrapper holds and
        claims no view inside them. A fund is never truncated to fit, because a shortened
        vector would understate the weights it did publish without saying so.
      </p>

      <h2 id="coverage">Coverage, and the 70/60 bands</h2>
      <p>
        <Term name="coverage">Coverage</Term> is the share of a fund&rsquo;s weight that
        could be attributed to a company: 100 × (weight with a company) ÷ (gross weight of
        every position the fund files). Gross, not net: both sides of a short are real
        exposure, so a fund that holds 100% long and 50% short is measured against 150%,
        and the ratio cannot exceed 100%. By weight rather than by counting positions,
        because a thousand tiny unresolved positions are not the same thing as a tenth of
        the fund missing. A fund&rsquo;s own cash line counts against its coverage.
      </p>
      <p>Three bands decide what a fund page shows:</p>
      <div className="table-wrap">
        <table className="table">
          <caption>What a fund&rsquo;s coverage decides</caption>
          <thead>
            <tr>
              <th scope="col">Coverage</th>
              <th scope="col">What the page shows</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>70% or more</td>
              <td>Full metrics, with the coverage figure stated beside them.</td>
            </tr>
            <tr>
              <td>60% to 70%</td>
              <td>
                Metrics labelled partial, with the coverage figure stated — an
                approximation of the whole fund, not a measurement of it.
              </td>
            </tr>
            <tr>
              <td>Below 60%</td>
              <td>
                The holdings that were matched, and no concentration metrics — the page
                says the fund is not covered.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        The thresholds are a product decision, not a statistical claim. Below 60%, a
        concentration figure would describe the part of the portfolio that could be read
        rather than the portfolio itself, and a reader would have no way to tell the
        difference. The headline number also blends asset classes with different ceilings
        — a debt row resolves only when its issuer is a corporate issuer, and cash never
        does — so the release measures coverage inside each class as well, which is the
        only version two funds can be compared on.
      </p>
      <h3 id="identified">Identified, and attributed</h3>
      <p>
        A position can be known at two depths, and the site prints both numbers rather
        than letting one stand for the other. It is <em>identified</em> when we know which
        security it is: the filing carries a public identifier for the row, or it matches
        a security we already hold. It is <em>attributed</em> when we know which company
        or entity the position belongs to — the stricter test, and the one the coverage
        figure above, the bands, and every metric computed from them measure.
      </p>
      <p>
        The identified share is therefore always the larger of the two: a Treasury bill, a
        repo, or a registered fund is a security with an identifier and no operating
        company behind it, so it can be identified and never attributed. That is why the
        two are labelled in words wherever they appear — a fund can honestly read
        &ldquo;99.5% of weight identified&rdquo; beside &ldquo;88.6% attributed to
        companies&rdquo;, and the second figure is the one the concentration numbers
        depend on. Neither share is a claim about data quality, and neither promises a
        level: they are the two shares the release measures, printed side by side so that
        the identified one cannot be read as company coverage.
      </p>

      <h2 id="dates">The three dates</h2>
      <p>
        Every number here carries three dates, and the site keeps them apart. The{" "}
        <Term name="reporting-period">reporting period</Term> is the quarter-end the
        holdings describe: a date in the filing, not today. The{" "}
        <Term name="filed-date">filed date</Term> is when EDGAR received the filing. The{" "}
        <Term name="age">age</Term> is the distance between them, in days.
      </p>
      <p>
        Holdings are quarterly, so a portfolio on this site typically describes a date{" "}
        <strong>60 to 150 days</strong> in the past. Nothing here is called
        &ldquo;updated&rdquo;: the site shows the age of what it displays rather than
        hiding it, and a portfolio whose funds filed on different days shows the oldest
        period and the longest gap.
      </p>

      <h2 id="concentration">Concentration</h2>
      <p>Three figures, computed once from the summed company rows:</p>
      <ul>
        <li>
          <Term name="hhi">HHI</Term> — the sum of the squared company weights in the
          ledger, printed to four decimal places. 0 is money spread evenly across many
          companies; 1 is money that is all in one.
        </li>
        <li>
          <Term name="effective-number">Effective number of companies</Term> — 1 ÷ HHI,
          printed to one decimal: how many equal-sized companies would spread the money
          the same way.
        </li>
        <li>
          <Term name="top-10">Top 10</Term> — the ten largest companies added together, as
          a share of the whole portfolio.
        </li>
      </ul>
      <p>
        They are never computed per fund and then averaged: an average of fund indexes is
        not the index of the portfolio. When a fund in the portfolio covers less than 60%
        of its weight, the figures are withheld rather than computed over the part that
        resolved.
      </p>

      <h2 id="effective-holdings">Effective holdings</h2>
      <p>
        <Term name="effective-holdings">Effective holdings</Term> answers a question a sum
        of squares makes hard to hear: how many equal-sized holdings would spread this
        money the way the mix actually spreads it? The answer comes as a pair.{" "}
        <Term name="core">Core</Term> counts mostly the largest positions, so a few big
        names pull it down fast; <Term name="broad">Broad</Term> counts every company,
        giving the small ones partial credit. Two counts rather than one, because a long
        tail can fairly be counted in more than one way, and the distance between the two
        answers is worth printing beside them.
      </p>
      <p>
        Both counts are computed after the <Term name="look-through">look-through</Term>,
        from the merged company weights — a company held through three funds is one
        company, with one weight, not three entries. The input is exactly the summed row
        the ledger prints: each company&rsquo;s weight is the sum of its contributions
        from every fund and every direct stock in the mix, so the pair describes the mix a
        reader holds rather than an average of the funds inside it. That is the reason the
        look-through exists, and the reason these two figures are not computed per fund
        and averaged.
      </p>
      <p>
        Four kinds of row are never a company and never enter the count: cash the reader
        adds to the portfolio, a fund&rsquo;s own cash lines, money-market sweeps, and
        derivatives. None of them has an issuer behind it, so counting one would credit
        the mix with a holding that is not there. Unresolved fund holdings are excluded
        for a different reason: a position that could not be matched to a company is never
        treated as one company, because doing so would invent an identity and hide the
        gap. It stays unmatched weight, and the coverage rule stated above says what that
        does to the pair. A negative weight — a short — is excluded too, and the exclusion
        is flagged beside the figures rather than applied in silence: a short is a real
        exposure, and leaving it in the shares would let it shrink every other share and
        flatter both counts.
      </p>
      <p>
        The arithmetic starts from the shares. Let w_i be a company&rsquo;s merged weight
        and <em>T</em> the sum of those weights — the company weight in the mix, with the
        rows above already removed — so that s_i = w_i / T and the shares sum to 1. N is
        the number of companies included, and it is the ceiling both counts approach.
      </p>
      <p className="mono">
        Core = 1 / HHI, with HHI = Σ s_i² · Broad = exp(H), with H = −Σ s_i ln s_i over
        s_i &gt; 0
      </p>
      <p>
        The pair is bounded by construction: 1 ≤ Core ≤ Broad ≤ N, and all three are equal
        only when every included weight is equal. Core cannot fall below one, because the
        shares sum to one and their squares cannot exceed one; Broad cannot fall below
        Core, because the exponential gives a long tail more weight than the squares do;
        and N is the ceiling, which only an even spread across every company reaches. A
        mix with one large position and a long tail of small ones therefore shows a low
        Core, a higher Broad, and a wide gap between the two.
      </p>
      <p>
        Coverage qualifies the pair exactly as it qualifies every other concentration
        figure: <em>T</em> ÷ (<em>T</em> + unmatched weight), against the same bands. At
        70% or more the pair prints plainly; from 60% to 70% it is labelled partial; below
        60% both counts are withheld. The withheld case is not a zero and not an estimate:
        a count computed over a minority of the money would describe that minority, and a
        reader would have no way to see the difference. The unmatched weight in that
        denominator is company-like money the release could not name; cash, sweeps and
        derivatives are outside both terms, because they were never going to be a company.
      </p>
      <p>
        Merging is also what keeps the pair honest about overlap. Treat each fund&rsquo;s
        contribution as its own holding and a company held by three funds counts three
        times: computed that way, both counts come out at or above the merged pair, and
        the gap between the two answers is exactly what merging removes. The pair printed
        is the merged one, because the mix is what a reader holds; a fund&rsquo;s own
        count is a different question, and the site does not add the two together.
      </p>
      <p>
        The unmatched weight is the one part of the mix the pair cannot count, and the
        range that leaves belongs to the evidence layer rather than to the printed pair:
        counted once, the unmatched weight is one more holding, and counted as the M equal
        holdings those unresolved positions could be, it is M of them. Both ends are
        computed over the resolved company weight plus the unmatched weight, so they
        describe what the mix would look like if the unread money were as evenly spread as
        each case assumes. Below 60% coverage the range is withheld along with the pair —
        the same rule, applied to every evidence figure that depends on them — because all
        of them rest on the same incomplete denominator.
      </p>
      <p>
        One arithmetic rule is worth stating because it cannot be seen on screen: the
        inputs are unrounded float64 throughout, the terms of each sum are added in
        ascending order, and 0 · ln 0 is taken as 0. Rounded inputs, summed in the order a
        reader typed their holdings, would let the same mix produce different figures on
        two visits; adding the smallest term first makes the result independent of the
        order the portfolio was entered, and a zero share contributes nothing rather than
        a limit that is never used.
      </p>
      <p>
        The limits of the pair are part of its definition. It is a count of holdings, so
        it ignores how companies move together: two mixes with the same Core and Broad can
        move in very different ways, because the arithmetic treats every company as
        independent of every other. It is not a verdict on a mix, and no threshold on this
        site turns Core or Broad into advice — a low count describes a mix that rests on a
        few names, and that is the whole claim.
      </p>

      <h2 id="overlap">Overlap</h2>
      <p>
        <Term name="overlap">Overlap</Term> compares two portfolios company by company:
        for each company, the smaller of its two weights, added up — a fraction of
        portfolio value held in the same companies on both sides. It is symmetric, and it
        is not a count of shared tickers: two mixes can share no fund and still hold most
        of the same companies.
      </p>
      <p>
        Both sides are aggregated with the same rules as the ledger, so an unmapped
        holding is disclosed on each side rather than redistributed. By construction,
        overlap plus the weight only the first portfolio holds equals its resolved weight;
        the compare page states that check, and a portfolio that does not account for
        itself gets no overlap figure.
      </p>

      <h2 id="markets">Market tiers</h2>
      <p>
        The left edge of a ledger row answers a narrower question than it looks like it
        does: is this company American, developed outside the United States, or emerging?
        The country comes from the filings; the market does not. The site follows the{" "}
        <Term name="market-tier">MSCI-aligned country classification</Term> as of 5
        November 2026, because most of the funds it looks through are MSCI-benchmarked —
        iShares, Avantis and DFA — and Vanguard is the FTSE exception. The FTSE Russell
        view is one click away, and every label says which convention it is using.
      </p>
      <p>
        The data carries five tiers — developed, emerging, frontier, standalone and
        unclassified — and the bar draws three segments. Developed is developed ex-US;
        everything else is emerging. Frontier and standalone therefore fold into emerging,
        which is why a market can change tier without changing a number.
      </p>

      <h3 id="markets-divergence">Where the two conventions disagree</h3>
      <p>
        Nine markets land in a different tier depending on the publisher, and three more
        are listed because a change is pending or has just happened. Only Korea, Poland
        and Greece change the three-segment bar; the other six change a label in the
        country table and no number, because frontier and standalone fold into emerging.
        Every other country maps the same way under both once FTSE&rsquo;s advanced and
        secondary emerging tiers are collapsed into one emerging tier.
      </p>
      <div className="table-wrap">
        <table className="table">
          <caption>Markets the two conventions sort differently</caption>
          <thead>
            <tr>
              <th scope="col">Market</th>
              <th scope="col">FTSE Russell</th>
              <th scope="col">MSCI</th>
              <th scope="col">Pending change</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>South Korea</td>
              <td>Developed</td>
              <td>Emerging</td>
              <td>
                None. MSCI kept Korea off its developed-market watch list in June 2026;
                the earliest realistic move is 2028 or later.
              </td>
            </tr>
            <tr>
              <td>Poland</td>
              <td>Developed</td>
              <td>Emerging</td>
              <td>None.</td>
            </tr>
            <tr>
              <td>Greece</td>
              <td>Developed</td>
              <td>Emerging</td>
              <td>
                MSCI moves it to developed at the May 2027 Index Review, effective 1 June
                2027.
              </td>
            </tr>
            <tr>
              <td>Indonesia</td>
              <td>Emerging</td>
              <td>Emerging</td>
              <td>
                MSCI is consulting on standalone status; the decision is due on or before
                30 June 2027.
              </td>
            </tr>
            <tr>
              <td>Peru</td>
              <td>Frontier</td>
              <td>Emerging</td>
              <td>None.</td>
            </tr>
            <tr>
              <td>Vietnam</td>
              <td>Emerging</td>
              <td>Frontier</td>
              <td>Not on MSCI&rsquo;s emerging-market watch list.</td>
            </tr>
            <tr>
              <td>Romania</td>
              <td>Emerging</td>
              <td>Frontier</td>
              <td>None.</td>
            </tr>
            <tr>
              <td>Iceland</td>
              <td>Emerging</td>
              <td>Frontier</td>
              <td>None.</td>
            </tr>
            <tr>
              <td>Bulgaria</td>
              <td>Frontier</td>
              <td>Standalone</td>
              <td>
                MSCI moves it to frontier at the May 2027 Index Review, effective 1 June
                2027.
              </td>
            </tr>
            <tr>
              <td>Argentina</td>
              <td>Not in FTSE&rsquo;s scheme</td>
              <td>Standalone</td>
              <td>None.</td>
            </tr>
            <tr>
              <td>Nigeria</td>
              <td>Frontier</td>
              <td>Frontier</td>
              <td>Same tier; listed because FTSE added it in September 2026.</td>
            </tr>
            <tr>
              <td>Turkey</td>
              <td>Emerging</td>
              <td>Emerging</td>
              <td>
                MSCI may consult on its treatment; the index has been frozen since October
                2026.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        The table is this site&rsquo;s own transcription, written to each
        publisher&rsquo;s published criteria and checked against its announcements, with
        the version date kept beside it. No MSCI or FTSE Russell document, table,
        constituent list or data file is reproduced here, and neither publisher has
        reviewed, approved or endorsed this site. UnpackFund is not affiliated with,
        endorsed by, or licensed by MSCI or FTSE Russell; the names identify the standard
        and nothing more.
      </p>

      <h3 id="markets-rules">The three segments, and the rules that place a domicile</h3>
      <p>
        <strong>Three buckets, and no fourth.</strong> A reader compares this split
        against an issuer&rsquo;s own factsheet, and &ldquo;no market tier&rdquo; is a
        question the page could not answer rather than an answer. So a domicile the
        provider does not classify is placed by one of the rules below, and the Markets
        bar draws exactly three segments:
      </p>
      <ul>
        <li>
          <strong>An offshore holding domicile is the United States.</strong> Bermuda, the
          Cayman Islands, the British Virgin Islands, Jersey, Guernsey, the Isle of Man,
          the Marshall Islands, Panama, the Bahamas, Gibraltar and Monaco are where a
          company is <em>registered</em>, not where it trades. Most of the weight in these
          domiciles is an American operating business listed in New York — Carnival, Arch
          Capital, RenaissanceRe, Everest, NCL, Genpact, Axalta — and both publishers
          reach the same place from the other direction, classifying those companies by
          country of risk. This is the largest single correction the convention makes: on
          the 4 November 2026 release these domiciles were 1.44% of gross weight.
        </li>
        <li>
          <strong>Puerto Rico is the United States</strong>, because it is a United States
          territory.
        </li>
        <li>
          <strong>Luxembourg is developed ex-US under MSCI.</strong> MSCI has no
          Luxembourg market and classifies Luxembourg-incorporated issuers by where they
          operate, so the domicile stands in for a developed European market; the override
          table corrects the ones where that is wrong.
        </li>
        <li>
          <strong>Everything that is not developed is emerging.</strong> Frontier,
          standalone and unclassified all fold in — Kazakhstan, Morocco, Nigeria,
          Mauritius, Kenya, Sri Lanka, Bangladesh, Pakistan, Bahrain, Oman, Jordan,
          Tunisia, Botswana, Ghana, Papua New Guinea, the Faroe Islands, Russia
          (suspended) and Liechtenstein — and so does a market the provider does not
          classify at all. A three-segment view has no fourth place for them, and frontier
          is closer to emerging than to either of the other two.
        </li>
      </ul>
      <p>
        The country is a domicile and not a measure of where a company earns its money,
        and the offshore rule is the one place where that gap is large enough to see. A
        Cayman-incorporated company can earn almost everything it makes in China, and the
        rule above still places it in the United States. That is right for the majority of
        the weight in those domiciles and wrong for a named minority: Tencent, NetEase,
        PDD, JD.com, Baidu, Trip.com, Meituan, Xiaomi, Kuaishou, WH Group, XPeng and their
        peers are all Cayman-incorporated, and they belong in emerging markets. On the 5
        November 2026 release that minority is about 0.44% of gross weight, and it is why
        an emerging-markets fund can show a United States segment at all.
      </p>
      <p>
        The correction is a country-of-risk assignment for the companies where the
        publisher&rsquo;s answer is well established and the weight is material, held in
        an override table the operator can extend. The release publishes how much weight
        the overrides moved, so what remains is a number rather than a claim.
        GLEIF&rsquo;s headquarters address is not a substitute: it returns Bermuda for
        Arch Capital and Dublin for Experian.
      </p>
      <p>
        <strong>The European frontier is no longer developed ex-US.</strong> Under FTSE
        this site placed nine European frontier markets — Bulgaria, Croatia, Cyprus,
        Estonia, Latvia, Lithuania, Malta, Slovakia and Slovenia — in developed ex-US by a
        rule of its own, because they are in the single market and the IMF calls them
        advanced economies. Under MSCI the publisher&rsquo;s answer ships: four of them
        are frontier, four have no MSCI market at all, and Bulgaria is standalone, and
        every one of those folds into emerging. The FTSE view still places them in
        developed ex-US, so the toggle shows the difference rather than hiding it.
      </p>

      <h3 id="country-decision">How a country is decided</h3>
      <p>
        In two steps, and the second one only runs when the first cannot answer. First the
        filings: every fund that holds the company reports a country of residence for it,
        and the country is published when one answer holds at least 80% of the traced
        value across at least two independent filings. That is a consensus over{" "}
        <em>holders</em>, so it fails for a company only one fund reports, and for a
        company whose holders genuinely disagree.
      </p>
      <p>
        Second, for a company the filings cannot place, its own record, asked in three
        steps: the jurisdiction on its legal-entity identifier from GLEIF; failing that,
        the state or country of incorporation on its EDGAR record; and failing that — the
        summary field is blank for a foreign private issuer — the same field on the
        company&rsquo;s own annual report cover page, which is where the company states
        it. No answer ever overrides a country the filings agreed on, and a company no
        record places gets no country rather than a guess. On the 5 November 2026 release
        the filings alone placed 10,193 of 12,900 companies, GLEIF placed a further 1,611,
        EDGAR 865 and the cover page 87, and 144 were left with no country at all.
      </p>
      <p>
        All three sources are also asked about companies the vote did decide, and that
        agreement is published beside the counts. On the same release, GLEIF agreed with
        the published country on 5,962 of the 6,009 companies both answers covered
        (99.22%), EDGAR on 336 of the 342 (98.25%), and the cover page on 333 of the 340
        (97.94%). A build is refused if GLEIF falls below 97%, EDGAR below 95%, or the
        cover page below 95%: the floors sit two to three points under the measured rates,
        which leaves room for the exceptions already understood — a Cayman or Bermuda
        holdco whose filing gives the listing venue, a dual-domiciled name — and none for
        a wrong code table.
      </p>
      <h3 id="country-contested">When the vote cannot decide</h3>
      <p>
        A company the vote refuses is not left out of the Markets bar. The release
        publishes a <strong>second, weaker answer</strong> beside the first: the country
        holding the largest share of the money in the company, published when one country
        holds at least 40% of the traced value across at least two filings. It is a
        different question with its own stated bar, and it is never merged into the
        decided map — the company tag still says the vote declined to place it, and only
        the Markets bar reads the second answer. On the 5 November 2026 release it placed
        55 of the 144 companies the vote refused, carrying 0.47% of the weight the bar
        draws; the rest have no plurality to place them by.
      </p>
      <p>
        A position that resolved to no company at all — a security the identity ladder
        could not name — is placed by the country its own filing states for the position.
        That is the only country evidence such a row has, and it is published on the row
        itself rather than inferred from a name, a ticker or an identifier prefix. Cash
        and derivative lines are never placed: they have no market.
      </p>
      <p>
        So a row is marked, not blank, in exactly one case: a{" "}
        <strong>dashed grey edge</strong> where no country could be established at all.
        The two-letter code beside the company name is the same information in text, so
        the colour is reinforcement and a monochrome print loses nothing.
      </p>

      <h2 id="limits">What is not known</h2>
      <p>Three limits are printed rather than hidden.</p>
      <ul>
        <li>
          Holdings are quarterly and old: a portfolio describes a date 60 to 150 days in
          the past, and nothing here is live.
        </li>
        <li>
          Coverage is incomplete: the share of weight that could not be attributed to a
          company is stated beside the coverage figure, split into positions that could
          not be identified and cash or derivatives that have no company.
        </li>
        <li>
          A fund that covers less than 60% of its weight has its concentration withheld,
          and a wrapper whose sleeves could not be flattened is shown as the funds it
          holds rather than as the companies underneath.
        </li>
      </ul>
      <p>
        Nothing on this site predicts anything. It does not show returns, prices, expense
        ratios or performance rankings, it does not rank funds, and it does not tell
        anyone what to buy. It shows what funds hold, how concentrated that is, and how
        much of it could be read. It is not investment advice.
      </p>

      <h2 id="benchmark">The benchmark: VT</h2>
      <p>
        Every portfolio is compared against one fixed fund, VT — the Vanguard Total World
        Stock ETF — and where the comparison is drawn, the column is the{" "}
        <Term name="benchmark-weight">benchmark weight</Term>: each company&rsquo;s share
        of VT&rsquo;s own portfolio, read from its N-PORT filing. That weight has nothing
        to do with how much of the reader&rsquo;s portfolio is in VT, which is usually
        none of it.
      </p>
      <p>
        VT is not configurable. A benchmark a reader could pick is a comparison that can
        be made to flatter a portfolio, and the point of a fixed one is that it cannot be
        chosen after the answer is known. When a release publishes no benchmark, the
        column is absent rather than filled with zeros, because a zero would claim VT
        holds none of these companies.
      </p>

      <h2 id="corrections">Corrections</h2>
      <p>
        If a number here disagrees with a fund&rsquo;s own filing, the filing is right.
        Write to {CONTACT_EMAIL} with the fund and the date, and I will correct the
        pipeline and note the correction.
      </p>

      <h2 id="attribution">Source attribution</h2>
      <p>
        Source: SEC EDGAR — Form N-PORT filings, submission records, and the company and
        fund ticker files — and the GLEIF golden copy (CC0) for legal-entity identity and
        jurisdiction. No SEC seal or logo is used, and neither the SEC nor GLEIF has
        reviewed, approved, or endorsed this site. {LEGAL_ENTITY} operates UnpackFund.
      </p>
    </ReadingLayout>
  );
}
