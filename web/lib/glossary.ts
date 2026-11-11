/**
 * The site's vocabulary, in one place.
 *
 * Three surfaces read this module and nothing else defines a term:
 *
 * - `<Term name="coverage">coverage</Term>` in prose — the dotted underline and
 *   its popover (`components/prose/Term.tsx`);
 * - `/glossary/` — every term, alphabetical, one anchor each (`#coverage`), so a
 *   popover's "read the full definition" link and a shared link land on the same
 *   place;
 * - the test that keeps the two honest (`glossary.test.ts`: unique ids, a
 *   definition on every term, alphabetical order, and every `<Term name>` on the
 *   site resolving to a term here).
 *
 * **The definitions are checked against the code, not against how the words are
 * usually used.** `lookthrough-math-and-qa` §1 owns the formulas and
 * `web/lib/aggregate.ts` implements them; where a plain-English word and the
 * implementation disagree, the implementation wins and this file is the bug. A
 * definition that reads well and describes a different denominator is worse than
 * no definition, because it is a claim about somebody's money.
 *
 * Ids are anchors: `#coverage` must not move once a page links to it. Adding a
 * term is appending to the alphabetical list; renaming an id is a redirect that
 * this static site does not have.
 */

/** One word the site uses in a way a reader deserves to have explained. */
export interface GlossaryTerm {
  /** Stable anchor on `/glossary/`: `#coverage`. Kebab-case, never renamed. */
  id: string;
  /** The word as it is printed in prose. */
  label: string;
  /**
   * The popover's text: one or two sentences. Long enough to be worth opening,
   * short enough to read without moving the page.
   */
  short: string;
  /** The full entry: one or two plain paragraphs. No formulas beyond the one. */
  definition: string;
  /**
   * The line for a reader who wants the name of the thing: the formula, or the
   * statistical term the plain definition is a gloss on. Optional, because most of
   * the site's words have no such line; `/glossary/` prints it under the entry in
   * the page's smallest type, so it is available without being the first thing a
   * reader meets.
   */
  expert?: string;
  /** Where a reader meets the word, so the definition can be found from there. */
  appears: string;
}

/**
 * Every term, alphabetical by `label`. The order is asserted by a test rather
 * than sorted at runtime: the file is the source of truth, and a diff that moves
 * a term should show it.
 */
export const GLOSSARY_TERMS = [
  {
    id: "age",
    label: "Age",
    short:
      "The gap between the end of a fund's reporting period and the day the SEC received the filing. Holdings are quarterly, so a figure here is usually 60 to 150 days old.",
    definition:
      "A filing carries two dates, and the age is the distance between them: the reporting period, which is the quarter-end the holdings describe, and the filed date, which is the day EDGAR received the form. The release stores it as lag_days and the site prints it rather than an “updated” stamp, because nothing here updates between filings. A fund's holdings are typically 60 to 150 days old by the time they are published; the freshness strip shows the longest such gap among the funds in the portfolio.",
    appears: "The freshness strip on the X-Ray, every fund row, and each fund page.",
  },
  {
    id: "basis-point",
    label: "Basis point",
    short:
      "One hundredth of a percentage point: 100 basis points make 1%. Weights are stored as whole basis points and printed as two decimals of a percent.",
    definition:
      "A fund files each position as a value and a percentage of its net assets, and the release stores that percentage as a whole number of basis points (273 bp is 2.73%) so no stored value carries a conversion error. On screen a weight gets two decimal places of a percent, because a third would be precision the filing does not have; a sentence rounds to one, because a sentence is read rather than compared. 100 basis points make 1 percentage point and 10,000 make 100%.",
    appears: "Every weight the site prints: the ledger, the directory and fund pages.",
  },
  {
    id: "benchmark-weight",
    label: "Benchmark weight",
    short:
      "A company's share of the benchmark fund's own portfolio — the fund's holding, not yours. The bracketed figure beside it is your weight minus the fund's, in percentage points.",
    definition:
      "Every portfolio is compared against one published fund at a time — VT (Vanguard Total World Stock ETF) unless you pick another — and the comparison shows each company's weight inside that fund's own filing. The picker offers VT, VTI, VOO, IDEV and IEMG: the whole world, the US total market, the S&P 500, developed ex-US and emerging markets, so a book can be read against the market it is actually in. The choice changes which comparison you are reading, never the meaning of the number: the weight is read from that fund's N-PORT and has nothing to do with how much of your portfolio is in it, which is usually none. Every surface names the fund — the column heading, the caption, the active-share line and the exported file — because a comparison that does not say what it is against is a number without provenance. A row with no weight means the benchmark's traced holdings do not include the company; the caption prints how much of the benchmark's own weight could be traced, so the reader can see what the comparison is against. The bracketed figure is your weight minus the benchmark's in percentage points — an aid to reading, never a score.",
    appears:
      "The Companies lens benchmark columns, the active-share line, and the methodology section on the benchmark.",
  },
  {
    id: "broad",
    label: "Broad",
    short:
      "Counts every company, giving small ones partial credit. Core is always at or below Broad. A wide gap means a few large positions dominate a long tail.",
    definition:
      "Counts every company, giving small ones partial credit. It is the less sensitive of the two counts: every company contributes, so a mix of many small positions reads as the many holdings it is, and one very large position moves it less than it moves Core. Core is always at or below Broad. A wide gap means a few large positions dominate a long tail.",
    expert: "exp(Shannon entropy); Hill number of order 1.",
    appears:
      "Beside Core in the answer strip, the Companies lens summary block and the Funds lens columns, and the methodology section on effective holdings.",
  },
  {
    id: "cash-line",
    label: "Cash line",
    short:
      "A position a fund files as cash. It has no company behind it by definition, so it is not a matching failure — but it does count against that fund's coverage.",
    definition:
      "A fund's N-PORT can carry cash and cash-equivalent rows. That money is part of the fund, and part of yours, so it dilutes concentration rather than being dropped; but it is not a company, so it is never reported as a mapping failure either. Because a fund's coverage is measured over every row it files, its cash line lowers its coverage, and the freshness strip's “Not traced” note names cash and derivatives for that reason. Cash you hold yourself is a different thing: it is not inside any fund, so it sits outside the coverage ratio altogether and the strip gives it a cell of its own.",
    appears:
      "The “What is not traced” section of the X-Ray, the coverage chips and the Data quality lens.",
  },
  {
    id: "company",
    label: "Company",
    short:
      "One issuer, counted once. Every holding that resolves to the same company is summed into one row — two share classes of an issuer are one company.",
    definition:
      "The ledger is a list of companies, not of positions. Each holding is matched to an identity — an SEC CIK for a US operating company, or a GLEIF legal-entity id for an issuer that files no N-PORT — and every holding of that identity is summed into a single row. A stock you hold directly lands on the same row as any fund's holding of it. A holding whose identity cannot be established is not spread across the companies that did resolve: it stays unmapped, and it is counted and disclosed separately.",
    appears:
      "Every table on the site: the X-Ray ledger, the company directory, fund pages, and the compare page.",
  },
  {
    id: "core",
    label: "Core",
    short:
      "Counts mostly your largest positions, so a few big names pull it down fast. Core is always at or below Broad. A wide gap means a few large positions dominate a long tail.",
    definition:
      "Counts mostly your largest positions, so a few big names pull it down fast. It is the stricter of the two counts: squaring a share rewards size twice, so the largest positions decide most of the answer while the tail barely moves it. Core is always at or below Broad. A wide gap means a few large positions dominate a long tail.",
    expert: "1/HHI (inverse Simpson index; Hill number of order 2).",
    appears:
      "Beside Broad in the answer strip, the Companies lens summary block and the Funds lens columns, and the methodology section on effective holdings.",
  },
  {
    id: "coverage",
    label: "Coverage",
    short:
      "The share of weight that could be attributed to a company. At 70% or more a fund reports full metrics, 60–70% is partial, and below 60% the site withholds concentration.",
    definition:
      "Coverage is measured by weight, never by counting rows: 100 × (weight with a company) ÷ (gross weight of every position the fund files). Gross, not net: both sides of a short count, so a fund that holds 100% long and 50% short is measured against 150% of its net assets and the ratio cannot exceed 100%. The fund's own cash line counts against it. The headline figure blends asset classes with different ceilings — a debt row only resolves when its issuer is a corporate issuer, and cash never does — so coverage is also measured inside each class, which is the only version that can be compared between two funds. For a whole portfolio the same ratio is applied to each fund's share of it and to any stock you hold directly, with cash you hold yourself outside both numerator and denominator. Coverage is printed beside every fund and beside every figure it qualifies, and concentration metrics are withheld below 60%.",
    appears:
      "The coverage chip beside each fund in the portfolio, the freshness strip, fund pages and the Data quality lens.",
  },
  {
    id: "direct-holding",
    label: "Direct holding",
    short:
      "A stock you add yourself, by symbol and amount, rather than through a fund. It is counted once, at the weight you gave it, and merges into any fund's holding of the same company.",
    definition:
      "The portfolio can hold a stock directly as well as funds. A direct holding is resolved to the same company identity the funds use, given the weight you entered, and added to that company's row: a company held both directly and through a fund is one line, at the sum of the two. It counts toward coverage and concentration exactly as a fund's holdings do. In percentage mode, amounts that do not add up to 100% leave an unallocated remainder, which is reported as unallocated weight instead of being treated as cash or spread over the other entries; in dollar mode the amounts are the whole, and each weight is its amount divided by their sum.",
    appears:
      "The portfolio builder, and the X-Ray ledger, where a row you hold directly is shaded.",
  },
  {
    id: "effective-holdings",
    label: "Effective holdings",
    short:
      "How many equal-sized holdings your mix acts like. It measures how evenly your money is spread across companies, not risk: it ignores how companies move together.",
    definition:
      "How many equal-sized holdings your mix acts like. It measures how evenly your money is spread across companies, not risk: it ignores how companies move together. It is printed as two counts, Core and Broad, because a long tail can fairly be counted in more than one way: mostly by the largest positions, or company by company. Both are computed after look-through merging, from the same company rows as the rest of the ledger, so a company held through three funds is one company and the pair describes the mix rather than an average of the funds inside it.",
    appears:
      "The answer strip, the Companies lens summary block and the Funds lens columns, and the methodology section on effective holdings.",
  },
  {
    id: "effective-number",
    label: "Effective number of companies",
    short:
      "How many equal-sized companies would spread your money the same way: 1 ÷ HHI. Shown to one decimal place.",
    definition:
      "Concentration reads more easily as a count than as a sum of squares. The effective number is 1 ÷ HHI: a portfolio whose hundreds of companies include three at 10% each has an effective number near 30 rather than near 500, which is the question the figure answers. It is computed from the same summed company weights as the HHI, not per fund and then averaged, so the two numbers cannot disagree.",
    appears: "The concentration figures on the X-Ray and on every fund page.",
  },
  {
    id: "filed-date",
    label: "Filed date",
    short:
      "The day the SEC received a fund's filing. It is printed beside the reporting period it describes, and never called “updated”.",
    definition:
      "The filed date is when EDGAR accepted the filing. It is stored as filed_at and each fund page links the filing it came from. A filing date is a fact about paperwork, not about the market, so the site shows it beside the reporting period instead of as an “updated” stamp; a portfolio whose funds filed on different days shows the oldest period and the longest gap rather than an average of them.",
    appears:
      "The freshness strip, every fund row in the portfolio, and each fund page's source line.",
  },
  {
    id: "fund",
    label: "Fund",
    short:
      "One published portfolio, identified by CIK and series rather than by ticker — the share classes that hold the same portfolio are one fund here.",
    definition:
      "A fund here is one portfolio with one holdings document, not one ticker. A registered investment company files a series per portfolio, and the same portfolio is often sold under many share classes, so the site publishes one page and one set of holdings per portfolio and maps each share-class ticker to it. Identity comes from the CIK and series id in the filings; a ticker is only how a reader looks the fund up, because tickers are reused and renamed.",
    appears:
      "The fund directory, every fund page, and the portfolio builder's suggestions.",
  },
  {
    id: "hhi",
    label: "HHI",
    short:
      "The sum of the squares of each company's weight. Zero means spread evenly, one means all in a single company; shown to four decimal places.",
    definition:
      "The Herfindahl–Hirschman index of the ledger: each company's weight, as a fraction of the whole portfolio, squared and then summed. The site prints it to four decimal places so two portfolios can be compared digit for digit, and its scale is the usual one — 0 for money spread evenly across many companies, 1 for money that is all in one. It is computed once from the summed company weights; an average of the funds' own indexes would be a different and wrong number, because concentration does not add up across a portfolio that way.",
    appears: "The “Concentration” figure on the X-Ray and on every fund page.",
  },
  {
    id: "look-through",
    label: "Look-through",
    short:
      "Following a fund down to the companies it holds: your direct weight plus, for each fund, your weight in that fund times the company's weight inside it.",
    definition:
      "Look-through is the arithmetic that turns a list of funds into a list of companies. For a company i, your weight is w(i) = w_direct(i) + Σₖ Wₖ · w(i,k): your own direct weight in the company, plus, for each fund k, your portfolio weight in that fund (Wₖ) multiplied by the company's weight inside that fund (w(i,k)). Every weight is a fraction of its own whole — Wₖ of your portfolio, w(i,k) of the fund's net assets — and the products are added, never renormalised. A fund that holds other registered funds is followed through them, up to three hops, but only when that is worth publishing: the flattened vector replaces the as-filed one when at least 5% of the fund's net assets arrives through fund edges and the result fits in 6,000 rows. Below either bound the page names the funds the wrapper holds and claims no view inside them, so a fund is never quietly truncated. What cannot be resolved stays in the uncovered share.",
    appears:
      "The X-Ray ledger; the compare page applies the same arithmetic to both sides.",
  },
  {
    id: "market-tier",
    label: "Market tier",
    short:
      "Which market a company's domicile belongs to: the United States, international developed ex-US, or emerging markets. Three buckets, and the country code is always printed beside it.",
    definition:
      "The left edge of a ledger row is coloured by the market its country belongs to: blue for the United States, one shade of ochre for international developed markets outside it, a deeper ochre for emerging markets. The site follows the MSCI-aligned country classification as of 5 November 2026, written as its own table, because most of the funds it looks through are MSCI-benchmarked; the FTSE Russell view is one click away. The data carries five tiers — developed, emerging, frontier, standalone and unclassified — and the bar draws three segments: developed is developed ex-US, and everything else is emerging, so frontier and standalone fold in. A domicile the provider does not classify is placed by a stated rule: an offshore holding domicile such as Bermuda or the Cayman Islands is the United States, because most of the weight there is an American business listed in New York (the methodology page names the minority this gets wrong, and an override table corrects it), and Puerto Rico is the United States because it is a United States territory. The publishers disagree about nine markets, so the country code is printed beside the colour and the methodology page carries the table.",
    appears: "The left edge of every ledger row, the Markets lens and each fund page.",
  },
  {
    id: "n-port",
    label: "N-PORT",
    short:
      "Form N-PORT: the quarterly holdings report a US registered fund files with the SEC. Every weight on the site starts from one.",
    definition:
      "Form N-PORT is the filing in which a registered fund lists its positions at the end of a quarter, each with a value and a share of the fund's net assets. It is where every holding and every weight on this site begins: EDGAR's submission records supply the filing dates, and EDGAR's fund ticker file maps a symbol to a CIK and a series. A filing describes one date. It is not a live position list, and its numbers are reproduced as filed rather than corrected.",
    appears: "Everywhere a source is named: the methodology and each fund page.",
  },
  {
    id: "overlap",
    label: "Overlap",
    short:
      "The share of value two portfolios hold in the same companies: for each company, the smaller of its two weights, added up.",
    definition:
      "Overlap compares two portfolios company by company: overlap = Σᵢ min(w(i,A), w(i,B)), a fraction of portfolio value held in the same companies on both sides. It is symmetric, and it is not a count of shared tickers — two mixes can share no fund and still hold 90% of the same companies. Both sides are aggregated with the same rules as the ledger, so an unmapped holding is disclosed on each side rather than redistributed. By construction, overlap plus the weight only A holds equals A's resolved weight, and the compare page states that arithmetic check; a portfolio that does not account for itself gets no overlap figure.",
    appears: "The compare page, and the Overlap lens on the X-Ray.",
  },
  {
    id: "reporting-period",
    label: "Reporting period",
    short:
      "The quarter-end a fund's holdings describe — a date in the filing, not today. Every number here is dated to one.",
    definition:
      "The reporting period is the date the holdings describe: the end of the quarter a fund's N-PORT covers, stored as as_of. It is not a build date and not today, and the site never substitutes one for the other. A portfolio assembled from funds with different quarter-ends shows the oldest of them in the freshness strip, so the date on screen is the date of the oldest number on screen.",
    appears: "The freshness strip, every fund row, and each fund page's header.",
  },
  {
    id: "share-class",
    label: "Share class",
    short:
      "One of several tickers that buy the same fund portfolio, with its own fees and minimums. Every class of a portfolio shares one holdings document here.",
    definition:
      "A fund is one portfolio; a share class is a way to buy it, with its own ticker, fees and minimum (VOO, VFIAX and VFINX are three classes of one portfolio). The release publishes one document per portfolio and a map from each share-class ticker to it, so typing any class finds the same holdings. What differs between classes — fees, minimums — is not shown anywhere on the site, because the holdings are the same and the site does not report fees.",
    appears:
      "The portfolio builder when a typed ticker turns out to be a share class, and the fund directory's search.",
  },
  {
    id: "top-10",
    label: "Top 10",
    short:
      "The combined weight of the ten largest companies in the ledger — a share of your whole portfolio, not of any one fund.",
    definition:
      "The ten largest companies by portfolio weight, added together and printed as a share of the whole portfolio. It is computed from the summed company weights after look-through, so a company held through three funds counts once, and it uses the same rows and the same rules as the table it sits above. With no positive weight in the ledger there is nothing to add up, and the figure is withheld rather than printed as zero.",
    appears: "The concentration figures on the X-Ray and on every fund page.",
  },
  {
    id: "unallocated-weight",
    label: "Unallocated weight",
    short:
      "Weight in a percentage-entered portfolio that no entry accounts for. It is reported as unallocated, never turned into cash or spread over the other holdings.",
    definition:
      "In percentage mode the entries have to add up to 100% before they describe a whole portfolio, and a set that adds to less leaves a remainder. The builder prints that remainder as unallocated weight: calling it cash would invent a holding nobody entered, and dividing it across the other rows would invent weights. Dollar mode has no unallocated weight at all, because the amounts are the whole and each weight is its amount divided by their sum. Unallocated weight is not unmapped weight: the first is a gap in what the reader entered, the second a gap in what could be identified inside a fund.",
    appears: "The portfolio builder's allocation line, and the freshness strip.",
  },
  {
    id: "unmapped-weight",
    label: "Unmapped weight",
    short:
      "Weight in positions that could not be matched to a company. It is counted and disclosed, and never spread across the companies that did resolve.",
    definition:
      "Unmapped weight is the part of a fund's weight whose positions have no company identity: a foreign issuer with no SEC ticker and no usable legal-entity identifier, a trust or partnership name that cannot be corroborated, or cash and derivatives, which have no company by definition. It is counted, split by cause and printed — never dropped, never back-filled from another source, and never divided across the companies that did resolve, because that is exactly how a fund with 40% of its weight explained comes to look average. The X-Ray separates the two causes, because a holding that could not be identified and a cash line are different facts about a fund.",
    appears:
      "The “What is not traced” section of the X-Ray, the coverage chips and the Data quality lens.",
  },
] as const satisfies readonly GlossaryTerm[];

/** The id of a term in the registry. `Term` takes one of these, so a typo fails the typecheck. */
export type GlossaryTermId = (typeof GLOSSARY_TERMS)[number]["id"];

const BY_ID: ReadonlyMap<string, GlossaryTerm> = new Map(
  GLOSSARY_TERMS.map((term) => [term.id, term]),
);

/** The term behind an id, or `undefined` for a name that is not in the registry. */
export function glossaryTerm(id: string): GlossaryTerm | undefined {
  return BY_ID.get(id);
}

/** Where a term is defined. One implementation, so a link cannot be spelled two ways. */
export function glossaryHref(id: string): string {
  return `/glossary/#${id}`;
}

/** One letter of the glossary's index, with the terms whose labels start with it. */
export interface GlossaryLetter {
  /** The uppercase letter, as the page prints it. */
  letter: string;
  /** The anchor the letter's heading carries: `letter-a`. */
  id: string;
  /** The terms under it, already in registry (alphabetical) order. */
  terms: readonly GlossaryTerm[];
}

function letterId(letter: string): string {
  return `letter-${letter.toLowerCase()}`;
}

/**
 * The letter index, derived from the registry so a new term cannot be missing
 * from the page that lists everything. A letter with no terms is not present:
 * the page renders an A–Z strip from the alphabet and links only what exists.
 */
export const GLOSSARY_LETTERS: readonly GlossaryLetter[] = buildLetters();

function buildLetters(): GlossaryLetter[] {
  const groups = new Map<string, GlossaryTerm[]>();
  for (const term of GLOSSARY_TERMS) {
    const letter = term.label.slice(0, 1).toUpperCase();
    const bucket = groups.get(letter);
    if (bucket) bucket.push(term);
    else groups.set(letter, [term]);
  }
  return [...groups].map(([letter, terms]) => ({
    letter,
    id: letterId(letter),
    terms,
  }));
}

/**
 * A–Z, so the index can show the letters that carry nothing as plain text.
 *
 * The page links letters with a plain `#letter-a` rather than a helper here: the
 * strip is navigation inside one document, and taking a route back to the page
 * you are on to reach an anchor in it is how a jump becomes a reload.
 */
export const GLOSSARY_ALPHABET: readonly string[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(
  "",
);
