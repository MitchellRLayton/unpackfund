/**
 * The four things only the operator can decide.
 *
 * Everything legal on this site reads from here, so a placeholder can never be
 * filled in one page and forgotten in another. Until a value is supplied the
 * literal bracket text renders on the page — deliberately ugly, because a
 * privacy policy that says `[LEGAL_ENTITY]` is a visible defect rather than a
 * silent one.
 *
 * Pre-flight gate before promoting to production: this must print 0.
 *
 *   grep -rn '\[LEGAL_ENTITY\]\|\[JURISDICTION\]\|\[CONTACT_EMAIL\]\|\[EFFECTIVE_DATE\]' \
 *     web/app web/lib | wc -l
 *
 * See docs/07-legal/2026-10-30-privacy-disclaimer-methodology-draft.md §1.
 */
export const LEGAL_ENTITY = "[LEGAL_ENTITY]";

/** Governing law for the terms. The operator's state of residence, most likely. */
export const JURISDICTION = "[JURISDICTION]";

/**
 * Where corrections, privacy requests, and complaints go. A dedicated address,
 * not the SEC contact `data@unpackfund.com`.
 */
export const CONTACT_EMAIL = "[CONTACT_EMAIL]";

/** The day the wide release is promoted to unpackfund.com, not the day it was drafted. */
export const EFFECTIVE_DATE = "[EFFECTIVE_DATE]";

/** Bumped by hand when the method changes; the page and the copy must move together. */
export const METHODOLOGY_VERSION = "1.0.0";

/** Version of the copy above, for the change history in the footer of each page. */
export const LEGAL_COPY_VERSION = "1.0.0";
