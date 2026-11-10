/**
 * The style-benchmark registry: which benchmark a fund is compared against, and what
 * that benchmark is made of.
 *
 * Proof of concept (2026-11-10) for `equity-style-benchmark-plan.md` §2 and §4. Two
 * deliberate differences from the plan, both so the POC ships without touching
 * production data or the pipeline:
 *
 * 1. **The benchmark weights are computed in the browser** from the member funds'
 *    published look-through vectors, equal-weighted, instead of being built offline into
 *    R2 artifacts (§7). Same arithmetic, same inputs, different place — a class artifact
 *    would be a release object, and this POC may not write one.
 * 2. **Funds are keyed by ticker, not by N-PORT series id** (§4b keys by `S000…`). The
 *    release publishes the ticker on every fund document; the series id is in the
 *    filing, not in the app's contract. Tagging by ticker is the POC's shortcut and the
 *    one thing a real build must change, because a ticker is a lookup key, not identity.
 *
 * Everything else is the plan: the class table, the index-blend versus peer-composite
 * distinction, the membership notes, and the gate's rules in §6 order.
 */

export type StyleFamily = "size" | "value" | "momentum";
export type StyleRegion = "US" | "INTL" | "EM";
export type StyleKind = "index_blend" | "peer_composite" | "single_etf";

export interface StyleClass {
  /** `US_SCV`, `INTL_MOM`, … — the key a fund is tagged with. */
  id: string;
  family: StyleFamily;
  region: StyleRegion;
  display: string;
  kind: StyleKind;
  /** The member ETFs, equal-weighted. Peer composites list their qualifying funds. */
  members: string[];
  /**
   * The region purity a *fund* must clear to be compared against this class, as a
   * fraction of its look-through weight (§3 rule 2). The hard check in §5b.
   */
  purity: number;
}

/** Region-purity thresholds from §3: 95% US, 90% developed ex-US, 90% EM. */
const US_PURITY = 0.95;
const INTL_PURITY = 0.9;
const EM_PURITY = 0.9;

/**
 * The classes from §2b–§2d, as written. Classes the plan defers (`EM_VALUE`) or rejects
 * (`INTL_MID`, `EM_MOM`, …) are absent on purpose: a class with no qualifying member is
 * a class that fails closed, and listing it would just move the failure later.
 */
export const STYLE_CLASSES: StyleClass[] = [
  // -- United States ---------------------------------------------------------
  {
    id: "US_LARGE",
    family: "size",
    region: "US",
    display: "US Large Caps",
    kind: "index_blend",
    members: ["VV", "VOO", "IWB"],
    purity: US_PURITY,
  },
  {
    id: "US_LARGE_VALUE",
    family: "value",
    region: "US",
    display: "US Large Cap Value",
    kind: "index_blend",
    members: ["VTV", "IVE", "IWD"],
    purity: US_PURITY,
  },
  {
    id: "US_MID",
    family: "size",
    region: "US",
    display: "US Mid Caps",
    kind: "index_blend",
    members: ["VO", "IJH", "IWR"],
    purity: US_PURITY,
  },
  {
    id: "US_MID_VALUE",
    family: "value",
    region: "US",
    display: "US Mid Cap Value",
    kind: "index_blend",
    members: ["VOE", "IJJ", "IWS"],
    purity: US_PURITY,
  },
  {
    id: "US_SMALL",
    family: "size",
    region: "US",
    display: "US Small Caps",
    kind: "index_blend",
    members: ["VB", "IJR", "IWM"],
    purity: US_PURITY,
  },
  {
    id: "US_SCV",
    family: "value",
    region: "US",
    display: "US Small Cap Value",
    kind: "index_blend",
    members: ["VBR", "IJS", "IWN"],
    purity: US_PURITY,
  },
  {
    id: "US_MOM_LARGE",
    family: "momentum",
    region: "US",
    display: "US Momentum (Large/All-cap)",
    kind: "peer_composite",
    members: ["MTUM", "SPMO", "JMOM", "PDP", "VFMO"],
    purity: US_PURITY,
  },
  {
    id: "US_MOM_SMID",
    family: "momentum",
    region: "US",
    display: "US SMID Momentum",
    kind: "peer_composite",
    members: ["XMMO", "XSMO", "DWAS"],
    purity: US_PURITY,
  },

  // -- International developed ----------------------------------------------
  {
    id: "INTL_DEV",
    family: "size",
    region: "INTL",
    display: "Intl Developed (Large/All-cap)",
    kind: "index_blend",
    members: ["IDEV", "VEA", "SPDW"],
    purity: INTL_PURITY,
  },
  {
    id: "INTL_LARGE_VALUE",
    family: "value",
    region: "INTL",
    display: "Intl Large Cap Value",
    kind: "single_etf",
    members: ["EFV"],
    purity: INTL_PURITY,
  },
  {
    id: "INTL_SMALL",
    family: "size",
    region: "INTL",
    display: "Intl Small Caps",
    kind: "index_blend",
    members: ["SCZ", "SCHC", "GWX"],
    purity: INTL_PURITY,
  },
  {
    id: "INTL_SCV",
    family: "value",
    region: "INTL",
    display: "Intl Small Cap Value",
    kind: "peer_composite",
    members: ["AVDV", "DISV", "ISVL"],
    purity: INTL_PURITY,
  },
  {
    id: "INTL_MOM",
    family: "momentum",
    region: "INTL",
    display: "Intl Momentum",
    kind: "peer_composite",
    members: ["IMTM", "IDMO", "PIZ", "IMOM"],
    purity: INTL_PURITY,
  },

  // -- Emerging markets ------------------------------------------------------
  {
    id: "EM",
    family: "size",
    region: "EM",
    display: "Emerging Markets",
    kind: "single_etf",
    members: ["IEMG"],
    purity: EM_PURITY,
  },
  {
    id: "EM_SMALL",
    family: "size",
    region: "EM",
    display: "EM Small Caps",
    kind: "single_etf",
    members: ["EEMS"],
    purity: EM_PURITY,
  },
];

/** Fast lookup for the gate and the caption. */
export const STYLE_CLASS_BY_ID: ReadonlyMap<string, StyleClass> = new Map(
  STYLE_CLASSES.map((styleClass) => [styleClass.id, styleClass]),
);

/**
 * Funds tagged with the class they should be measured against (§4b).
 *
 * `peer_member` marks the funds that are *both* a member of the class's benchmark and
 * something a reader can hold — the distinction §8 depends on. A fund that is tagged but
 * not a member (AVUV under `US_SCV`) is exactly the case the feature exists for: it is
 * evaluated against a benchmark it is not part of.
 */
export interface FundStyle {
  ticker: string;
  classId: string;
  peerMember: boolean;
  /** How the class was decided, printed in the POC's diagnostics. */
  source: "manual" | "lookthrough";
}

function tag(
  ticker: string,
  classId: string,
  peerMember = false,
  source: FundStyle["source"] = "manual",
): FundStyle {
  return { ticker, classId, peerMember, source };
}

/** The POC's tag set: the ETFs the plan names, plus the funds it names as evaluated. */
export const FUND_STYLES: FundStyle[] = [
  // Size family — members of the index blends, and funds a reader might hold.
  tag("VV", "US_LARGE", true),
  tag("VOO", "US_LARGE", true),
  tag("IWB", "US_LARGE", true),
  tag("VO", "US_MID", true),
  tag("IJH", "US_MID", true),
  tag("IWR", "US_MID", true),
  tag("VB", "US_SMALL", true),
  tag("IJR", "US_SMALL", true),
  tag("IWM", "US_SMALL", true),
  tag("IDEV", "INTL_DEV", true),
  tag("VEA", "INTL_DEV", true),
  tag("SPDW", "INTL_DEV", true),
  tag("SCZ", "INTL_SMALL", true),
  tag("SCHC", "INTL_SMALL", true),
  tag("GWX", "INTL_SMALL", true),
  tag("IEMG", "EM", true),
  tag("EEMS", "EM_SMALL", true),

  // Value family.
  tag("VTV", "US_LARGE_VALUE", true),
  tag("IVE", "US_LARGE_VALUE", true),
  tag("IWD", "US_LARGE_VALUE", true),
  tag("VOE", "US_MID_VALUE", true),
  tag("IJJ", "US_MID_VALUE", true),
  tag("IWS", "US_MID_VALUE", true),
  tag("VBR", "US_SCV", true),
  tag("IJS", "US_SCV", true),
  tag("IWN", "US_SCV", true),
  tag("EFV", "INTL_LARGE_VALUE", true),
  tag("AVDV", "INTL_SCV", true),
  tag("DISV", "INTL_SCV", true),
  tag("ISVL", "INTL_SCV", true),
  // The funds the feature exists to evaluate: tagged, not members.
  tag("AVUV", "US_SCV"),
  tag("DFSV", "US_SCV"),
  tag("AVSC", "US_SCV"),
  tag("AVLV", "US_LARGE_VALUE"),
  tag("DFLV", "US_LARGE_VALUE"),

  // Momentum family.
  tag("MTUM", "US_MOM_LARGE", true),
  tag("SPMO", "US_MOM_LARGE", true),
  tag("JMOM", "US_MOM_LARGE", true),
  tag("PDP", "US_MOM_LARGE", true),
  tag("VFMO", "US_MOM_LARGE", true),
  tag("XMMO", "US_MOM_SMID", true),
  tag("XSMO", "US_MOM_SMID", true),
  tag("DWAS", "US_MOM_SMID", true),
  tag("IMTM", "INTL_MOM", true),
  tag("IDMO", "INTL_MOM", true),
  tag("PIZ", "INTL_MOM", true),
  tag("IMOM", "INTL_MOM", true),
];

export const FUND_STYLE_BY_TICKER: ReadonlyMap<string, FundStyle> = new Map(
  FUND_STYLES.map((style) => [style.ticker, style]),
);

/** The class a ticker is compared against, or `null` when it is untagged. */
export function classOf(ticker: string): StyleClass | null {
  const style = FUND_STYLE_BY_TICKER.get(ticker.toUpperCase());
  return style ? (STYLE_CLASS_BY_ID.get(style.classId) ?? null) : null;
}
