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
/**
 * The operator, as a natural person. A revocable trust is not a separate legal
 * person and gives no liability protection — the grantor is the trustee and the
 * beneficiary — so naming it here would add a confusing third name to a policy
 * about a personal site without changing what it means. If the operator later
 * forms an LLC, this becomes the LLC and nothing else changes.
 */
export const LEGAL_ENTITY = "Mitchell Layton";

/** Governing law for the terms. The operator's state of residence, most likely. */
export const JURISDICTION = "California";

/**
 * Where corrections, privacy requests, and complaints go. A dedicated address,
 * not the SEC contact `data@unpackfund.com`.
 *
 * Changed 2026-10-30 from the operator's personal address to the site's own
 * duck.com alias, at the operator's instruction. Deliberately one constant: five
 * pages name a contact address, and a correction that reached only the page the
 * operator happened to be looking at would leave the personal address published
 * on the other four. `legal.test.ts` fails if any page hard-codes an address
 * instead of reading this one.
 */
export const CONTACT_EMAIL = "unfetteredaccess@duck.com";

/**
 * The day the wide release is promoted to unpackfund.com, not the day it was
 * drafted. Set 2026-10-30, the promotion date; the pre-flight gate (P15) exists
 * so a promotion cannot ship a policy still dated to a draft.
 */
export const EFFECTIVE_DATE = "October 30, 2026";

/** Bumped by hand when the method changes; the page and the copy must move together. */
export const METHODOLOGY_VERSION = "1.0.0";

/**
 * Version of the copy above, for the change history in the footer of each page.
 *
 * 1.1.0 (2026-10-30): the public contact address moved to the site's own alias,
 * and the methodology gained its paragraph on positions that have no company
 * (cash, derivatives, and unresolved non-US issuers). The method itself did not
 * change, so `METHODOLOGY_VERSION` stays at 1.0.0.
 */
export const LEGAL_COPY_VERSION = "1.1.0";
