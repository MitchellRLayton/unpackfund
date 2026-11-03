/**
 * The country mark: a flag where the platform draws one, the two-letter code where it
 * does not.
 *
 * A flag emoji is not an image and not a font we ship. It is the two letters of the
 * ISO 3166-1 code, each replaced by its "regional indicator" symbol (U+1F1E6 plus the
 * letter's offset), and the platform's emoji font decides what that pair looks like:
 * macOS, iOS and Android draw a flag; Windows' Segoe UI Emoji has no flag glyphs and
 * draws the two boxed letters instead — which is exactly the code, so the fallback is
 * the thing the tag printed before the flag existed (operator's choice, 2026-11-02:
 * "🇺🇸 on Mac; US on Windows — degrades to exactly the code").
 *
 * That is why this is a *derivation* and not data: every code the release publishes
 * gets its mark for free, including codes that arrive tomorrow, and there is no table
 * to keep current, no fetch, and nothing to add to the pipeline.
 *
 * The accessible name is the country's name, never the glyph. `role="img"` plus
 * `aria-label` on the span means a screen reader says "United States" once, instead of
 * announcing a flag and then a code; `Intl.DisplayNames` supplies the names from the
 * browser's own CLDR data, so that costs nothing either.
 */

const REGIONAL_INDICATOR_A = 0x1f1e6;
const LETTER_A = "A".charCodeAt(0);

/**
 * `US` → `🇺🇸`. Anything that is not two ASCII letters returns `""` — no mark, rather
 * than a pair of stray symbols, because a malformed code is a data defect and the tag
 * should disappear rather than invent a country.
 */
export function flagEmoji(code: string): string {
  if (!/^[A-Za-z]{2}$/.test(code)) return "";
  return String.fromCodePoint(
    ...[...code.toUpperCase()].map(
      (letter) => REGIONAL_INDICATOR_A + letter.charCodeAt(0) - LETTER_A,
    ),
  );
}

let displayNames: Intl.DisplayNames | null | undefined;
let unknownRegion: string | undefined;

/**
 * `US` → `United States`; the code itself when the browser has no name for it (an
 * unknown region, or an engine without `Intl.DisplayNames`). The code is a worse label
 * than the name but a better one than nothing, and it is what the tag used to show.
 *
 * CLDR does not answer an unknown region with the input — it answers "Unknown Region"
 * — so the sentinel is read from the same table rather than hard-coded, and a code the
 * table does not know falls back to the code instead of to a phrase that names nothing.
 */
export function countryName(code: string): string {
  const upper = code.toUpperCase();
  if (displayNames === undefined) {
    try {
      displayNames = new Intl.DisplayNames(["en"], { type: "region" });
      unknownRegion = displayNames.of("ZZ");
    } catch {
      displayNames = null;
    }
  }
  const name = displayNames?.of(upper);
  return name && name !== upper && name !== unknownRegion ? name : upper;
}
