/**
 * Fund and issuer names become display text here, and nowhere else.
 *
 * The catalogue publishes the strings as the filings write them, and a filing is
 * written in the registrant's preferred shout: `VANGUARD INDEX FUNDS`, `SPDR S&P 500
 * ETF TRUST`, beside `iShares Trust`. Printed straight into the directory, that reads
 * as two data sets rather than one list — the same fact ("a trust's name") cased two
 * ways — so one module owns the transform and the tests pin the edge cases.
 *
 * It is a rule, not a style function, because the exceptions are facts about the
 * industry and about trademarks rather than taste:
 *
 * - **A name that already mixes cases is returned whole, not word by word.** A
 *   filing writes a name either entirely in capitals (`VANGUARD INDEX FUNDS`) or in
 *   the registrant's own casing (`iShares Trust`), and the second is a presentation
 *   we do not own: re-casing it word by word turns `EA Series Trust` into `Ea Series
 *   Trust` and `DWS RREEF Real Assets Fund` into `Dws RREEF…`, damaging short marks
 *   (`EA`, `DWS`, `JPM`) that no fixed acronym list can enumerate. Only a string that
 *   is entirely upper case is normalised.
 * - **An all-caps word becomes title case unless it is an acronym.** `ETF`, `REIT`,
 *   `MLP`, `SPDR` and the share-class numerals `II`/`III`/`IV` are names, so
 *   `Vanguard Total Bond Market Etf` would be wrong in a way a reader notices.
 * - **`&` and `.` are meaning, not punctuation.** `S&P` and `U.S.` fold to `S&p` and
 *   `U.s.` under a naive title case, and those are trademarks and initialisms rather
 *   than words, so a word carrying either is left exactly as filed.
 * - **Numbers are left alone** (`VANGUARD 500 INDEX FUND` → `Vanguard 500 Index Fund`);
 *   a figure is not a word and has no case.
 * - **A hyphen or slash starts a new word** (`LARGE-CAP` → `Large-Cap`,
 *   `EQUITY/DEBT` → `Equity/Debt`), because the second half of a compound is a word
 *   rather than a suffix.
 * - **Nothing inside parentheses is touched.** A share-class marker such as
 *   `State Street(R) SPDR(R)` must survive byte for byte, parenthesised registrations
 *   and class labels are not prose, and a section reference in parentheses is not
 *   ours to re-case.
 *
 * This module deliberately reads no other field: display text must not become a
 * classification. The `etf` label next to a name is a name test with its own module
 * (`classify.looks_like_etf`, ADR-0007 C3) and never comes from here.
 */

/**
 * Words that stay upper case because they are acronyms rather than words.
 *
 * Deliberately a closed list: every entry is a term a fund name may legitimately
 * carry in caps, and an open-ended "looks like an initialism" heuristic would keep
 * `FUNDS` or `TRUST` upper. The numerals are here because a share class reads as
 * `Class II`, not `Class Ii`.
 */
const ACRONYMS = new Set([
  "ADR",
  "AI",
  "BDC",
  "ESG",
  "ETF",
  "ETFS",
  "II",
  "III",
  "IV",
  "MLP",
  "REIT",
  "SPDR",
  "USD",
]);

/** One upper-case word (no spaces, no parentheses) title-cased under the rules above. */
function titleCaseWord(word: string): string {
  const core = word.replace(/^[^A-Za-z]+/, "").replace(/[^A-Za-z]+$/, "");
  if (!core) return word;
  if (core.includes("&") || core.includes(".")) return word;
  if (/\d/.test(core)) return word;
  if (ACRONYMS.has(core)) return word;
  const titled = core.charAt(0).toUpperCase() + core.slice(1).toLowerCase();
  return word.replace(core, titled);
}

/** A hyphen or a slash separates two words, and each half is cased on its own. */
function titleCaseCompound(token: string): string {
  return token
    .split(/([-/])/)
    .map((part, index) => (index % 2 === 1 ? part : titleCaseWord(part)))
    .join("");
}

/** A run of text with no parentheses in it: every whitespace-separated word is cased. */
function titleCaseRun(run: string): string {
  return run.replace(/[^\s]+/g, titleCaseCompound);
}

/**
 * A filing's name as display text: `VANGUARD INDEX FUNDS` → `Vanguard Index Funds`,
 * `iShares Trust` unchanged.
 *
 * The whole string is the unit, not the word: presence of one lower-case letter means
 * the registrant chose a casing, and the function returns the name untouched (see the
 * header). The scan below therefore runs only on an all-caps string, and it tracks
 * parenthesis depth rather than splitting on a regex so a parenthesised run that
 * contains a hyphen, a slash or spaces still comes out exactly as filed:
 * `FUND (THE TRUST)` → `Fund (THE TRUST)`, `(R)` untouched.
 */
export function displayName(raw: string): string {
  const text = raw ?? "";
  if (/[a-z]/.test(text)) return text;
  let output = "";
  let plain = "";
  let depth = 0;
  for (const char of text) {
    if (char === "(") {
      if (depth === 0) {
        output += titleCaseRun(plain);
        plain = "";
      }
      depth += 1;
      output += char;
      continue;
    }
    if (char === ")" && depth > 0) {
      depth -= 1;
      output += char;
      continue;
    }
    if (depth > 0) output += char;
    else plain += char;
  }
  return output + titleCaseRun(plain);
}
