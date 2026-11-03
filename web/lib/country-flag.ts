/**
 * The country's flag, derived from its two-letter code.
 *
 * A flag emoji is not an image and not a font we ship. It is the two letters of the
 * ISO 3166-1 code, each replaced by its "regional indicator" symbol (U+1F1E6 plus the
 * letter's offset), and the platform's emoji font decides what that pair looks like:
 * macOS, iOS and Android draw a flag; Windows' Segoe UI Emoji has no flag glyphs and
 * draws the two boxed letters instead, which is why a Windows tag reads `US US` — the
 * flag degrades to the code sitting beside it.
 *
 * That is why this is a *derivation* and not data: every code the release publishes
 * gets its flag for free, including codes that arrive tomorrow, and there is no table
 * to keep current, no fetch, and nothing to add to the pipeline.
 *
 * The flag is **decoration**, and the code beside it is the fact (operator's choice,
 * 2026-11-02: show both, "even with the awkward screen reader behavior"). So the tag
 * sets the glyph `aria-hidden` and prints the code as text: a sighted reader gets the
 * flag, a screen reader hears `US` exactly as it did before the flag existed, and a
 * monochrome print still carries the code.
 */

const REGIONAL_INDICATOR_A = 0x1f1e6;
const LETTER_A = "A".charCodeAt(0);

/**
 * `US` → `🇺🇸`. Anything that is not two ASCII letters returns `""` — no glyph, rather
 * than a pair of stray symbols, because a malformed code is a data defect and the tag
 * should print the code alone rather than invent a country.
 */
export function flagEmoji(code: string): string {
  if (!/^[A-Za-z]{2}$/.test(code)) return "";
  return String.fromCodePoint(
    ...[...code.toUpperCase()].map(
      (letter) => REGIONAL_INDICATOR_A + letter.charCodeAt(0) - LETTER_A,
    ),
  );
}
