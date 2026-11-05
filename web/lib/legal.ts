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
export const EFFECTIVE_DATE = "November 4, 2026";

/**
 * Bumped by hand when the method changes; the page and the copy must move together.
 *
 * 1.1.0 (2026-11-02): the ledger's left edge now carries a market classification —
 * developed ex-US against emerging — as well as the domicile it always carried, and the
 * page gained the section that says which convention is being followed and where other
 * publishers disagree with it.
 *
 * 1.2.0 (2026-11-02): a country is now decided in two steps rather than one. Where the
 * holders' filings cannot agree, the company's own registry record is asked — GLEIF
 * jurisdiction, then EDGAR's state of incorporation — and a company neither record
 * places keeps a neutral edge instead of none. The page states both steps and the two
 * new sources.
 *
 * 1.3.0 (2026-11-03): the page gained the effective-holdings section — Core and Broad, the
 * pair of equal-sized-holdings counts, with their shares, their formulas, the invariant
 * between them, the coverage rule that withholds them, the overlap the merge removes, and
 * what the pair does not say about how companies move together.
 *
 * 1.4.0 (2026-11-05): the default country classification moved from FTSE Russell to MSCI,
 * because that is what the funds this site looks through mostly benchmark to. The page now
 * names the convention and its vintage, tabulates the markets where the two publishers
 * disagree, states that only three of them move the three-segment bar (the rest change a
 * label, because frontier and standalone fold into emerging), and says that the table is
 * authored to the published criteria rather than copied from either publisher. FTSE remains
 * selectable, and the page says so.
 */
export const METHODOLOGY_VERSION = "1.4.0";

/**
 * Version of the copy above, for the change history in the footer of each page.
 *
 * 1.1.0 (2026-10-30): the public contact address moved to the site's own alias,
 * and the methodology gained its paragraph on positions that have no company
 * (cash, derivatives, and unresolved non-US issuers). The method itself did not
 * change, so `METHODOLOGY_VERSION` stays at 1.0.0.
 *
 * 1.2.0 (2026-11-02): the methodology explains the developed/emerging split, the
 * convention behind it, and the licence position — the table is ours, no FTSE
 * document is reproduced, and none of the three publishers has endorsed the site.
 *
 * 1.3.0 (2026-11-02): the source attribution names GLEIF as well as EDGAR, because the
 * site now reads a jurisdiction out of the GLEIF golden copy (CC0) rather than only
 * using it for entity identity, and the methodology says a company with no place at all
 * is marked rather than left blank.
 *
 * 1.4.0 (2026-11-03): the privacy policy's storage paragraph describes what the
 * first-visit film actually writes — a session mark and the local date of the last
 * play, where it previously said the site wrote nothing to local storage. A date
 * replaced the earlier rolling timestamp, which is less data and a plainer sentence.
 * No new collection, no new third party; the policy is being made true again.
 *
 * 1.5.0 (2026-11-04): the first-visit film was removed, and the two storage marks it
 * needed went with it. The policy's storage paragraph described those two values; it now
 * says the site writes nothing to localStorage or sessionStorage, which is true again.
 */
export const LEGAL_COPY_VERSION = "1.5.0";
