/**
 * The style-benchmark registry: which benchmark a fund is compared against, and what
 * that benchmark is made of.
 *
 * Proof of concept (2026-11-10) for `equity-style-benchmark-plan.md`, rebuilt from the
 * operator's membership research of the same day. Everything below is *their* list; the
 * code's job is to hold it in a shape that can be checked.
 *
 * The membership rule changed with that research, and it is enforced by a test rather
 * than by this comment:
 *
 * > **3 or more independent passive index families → index blend** (one ETF per family).
 * > **Fewer than 3 → peer composite** of every implementation that qualifies: passive,
 * > active and alternatively weighted alike.
 *
 * The legend is the operator's too: `member` is ★, `optional` is ◐ (a dividend,
 * fundamental, cash-flow-yield or shareholder-yield weighting, or a value-adjacent
 * mandate — included only when the optional flag is on), `clone` is = (the same index as
 * a ★, so it is *classified* but never counted twice), `alt` is Alt (a passive fund from
 * an index family the blend does not use — classified, not a member), and `excluded` is ✗
 * with the reason, kept in the record so the same question is not re-researched.
 *
 * Two POC shortcuts remain, unchanged from the first build:
 *
 * 1. **The benchmark weights are computed in the browser** from the member funds'
 *    published look-through vectors, equal-weighted, instead of being built offline into
 *    R2 artifacts (§7). Same arithmetic, same inputs, different place — a class artifact
 *    would be a release object, and this POC may not write one.
 * 2. **Funds are keyed by ticker, not by N-PORT series id** (§4b). Tagging by ticker is
 *    the one thing a real build must change, because a ticker is a lookup key, not
 *    identity.
 */

export type StyleFamily = "size" | "value" | "momentum";
export type StyleRegion = "US" | "INTL" | "EM";
export type StyleKind = "index_blend" | "peer_composite" | "single_etf";

/**
 * The index family a member belongs to. The *passive* families are what the 3-family rule
 * counts: two funds tracking the same family are one family however many share classes
 * they have, which is also why a clone never adds a family.
 */
export type IndexFamily =
  | "morningstar"
  | "s&p"
  | "russell"
  | "msci"
  | "ftse"
  | "dow-jones"
  | "dimensional"
  | "avantis"
  | "jpmorgan"
  | "vanguard"
  | "fidelity"
  | "dorsey-wright"
  | "alpha-architect"
  | "wisdomtree"
  | "rafi"
  | "gmo"
  | "sei"
  | "marketdesk"
  | "strive"
  | "goldman"
  | "other";

/** The families the 3-family rule counts: a published passive index. */
export const PASSIVE_FAMILIES: ReadonlySet<IndexFamily> = new Set([
  "morningstar",
  "s&p",
  "russell",
  "msci",
  "ftse",
  "dow-jones",
]);

export type MemberStatus = "member" | "optional" | "clone" | "alt" | "excluded";

export interface StyleMember {
  ticker: string;
  family: IndexFamily;
  status: MemberStatus;
  /** Rough AUM snapshot in USD millions, where the research gave a figure. */
  aumUsdM?: number;
  /** For a clone: the ★ it duplicates. For an exclusion: why. */
  note?: string;
  cloneOf?: string;
}

export interface StyleClass {
  id: string;
  family: StyleFamily;
  region: StyleRegion;
  display: string;
  kind: StyleKind;
  /**
   * The region purity a *fund* must clear to be compared against this class, as a
   * fraction of its placed look-through weight (§3 rule 2). The hard check in §5b.
   */
  purity: number;
  /** ★ members, ◐ optional members, = clones, Alt classifications, ✗ exclusions. */
  members: StyleMember[];
  /**
   * Tickers a reader may hold that belong in this class without being members: the
   * plan's "Evaluated against" line. Classifying them is what makes the column appear for
   * the funds the feature exists to evaluate (AVUV, AVIV, DFEV …).
   */
  evaluated: string[];
}

/** Region-purity thresholds from §3: 95% US, 90% developed ex-US, 90% EM. */
const US_PURITY = 0.95;
const INTL_PURITY = 0.9;
const EM_PURITY = 0.9;

/** ★ — a member of the benchmark. */
function m(ticker: string, family: IndexFamily, aumUsdM?: number): StyleMember {
  return {
    ticker,
    family,
    status: "member",
    ...(aumUsdM === undefined ? {} : { aumUsdM }),
  };
}

/** ◐ — an optional member: included only when the optional flag is on. */
function opt(
  ticker: string,
  family: IndexFamily,
  aumUsdM?: number,
  note?: string,
): StyleMember {
  return {
    ticker,
    family,
    status: "optional",
    ...(aumUsdM === undefined ? {} : { aumUsdM }),
    ...(note === undefined ? {} : { note }),
  };
}

/** = — a clone of a ★: the same index under another wrapper. Classified, never counted. */
function clone(ticker: string, of: string, family: IndexFamily): StyleMember {
  return { ticker, family, status: "clone", cloneOf: of };
}

/** Alt — a passive fund from an index family the blend does not use. Classified only. */
function alt(
  ticker: string,
  family: IndexFamily,
  aumUsdM?: number,
  note?: string,
): StyleMember {
  return {
    ticker,
    family,
    status: "alt",
    ...(aumUsdM === undefined ? {} : { aumUsdM }),
    ...(note === undefined ? {} : { note }),
  };
}

/** ✗ — excluded from the class, with the reason kept in the record. */
function no(ticker: string, family: IndexFamily, why: string): StyleMember {
  return { ticker, family, status: "excluded", note: why };
}

/**
 * The classes, from the operator's research of 2026-11-10.
 *
 * Absent on purpose, because no benchmark can be built from what qualifies (§2e, and the
 * research's "Still can't build"): Intl Mid Caps, Intl Mid Cap Value, Intl SMID Momentum,
 * and US momentum funds under $50M.
 */
export const STYLE_CLASSES: StyleClass[] = [
  {
    id: "US_LARGE",
    family: "size",
    region: "US",
    display: "US Large Caps",
    kind: "index_blend",
    purity: US_PURITY,
    members: [
      m("VV", "morningstar"),
      m("VOO", "s&p"),
      m("IWB", "russell", 49_000),
      clone("IVV", "VOO", "s&p"),
      clone("SPY", "VOO", "s&p"),
      clone("SPYM", "VOO", "s&p"),
      clone("VONE", "IWB", "russell"),
      no("MGC", "morningstar", "same family, narrower"),
      alt("SCHX", "dow-jones", 65_000),
      alt("BBUS", "morningstar", 9_600),
      alt("ILCB", "morningstar", 1_300),
    ],
    evaluated: ["FNDX", "DFUS", "DLCU", "PRF", "AVLC"],
  },
  {
    id: "US_LARGE_VALUE",
    family: "value",
    region: "US",
    display: "US Large Cap Value",
    kind: "index_blend",
    purity: US_PURITY,
    members: [
      m("VTV", "morningstar", 262_000),
      m("IVE", "s&p", 49_000),
      m("IWD", "russell", 82_000),
      clone("SPYV", "IVE", "s&p"),
      clone("VOOV", "IVE", "s&p"),
      clone("VONV", "IWD", "russell"),
      clone("GVUS", "IWD", "russell"),
      no("MGV", "morningstar", "same family, narrower"),
      no("IWX", "russell", "same family, narrower"),
      no("IUSV", "s&p", "S&P 900, broader than IVE"),
      alt("SCHV", "dow-jones", 15_200),
      alt("ILCV", "morningstar", 1_300),
      alt("STXV", "strive", 75),
    ],
    evaluated: [
      "AVLV",
      "COWZ",
      "DFUV",
      "VLUE",
      "JAVA",
      "DFLV",
      "FELV",
      "WTV",
      "NULV",
      "BKDV",
      "DSTL",
      "PWV",
      "RPV",
      "SEIV",
      "FVAL",
      "FTA",
      "JVAL",
      "VFVA",
      "VLU",
      "QVAL",
      "LSVD",
      "EVUS",
      "BLCV",
      "GVLU",
      "QUVU",
      "FLCV",
      "ASLV",
      "FBCV",
      "VALQ",
      "CGVV",
      "TALV",
      "BAMV",
      "GMOV",
      "PRXV",
      "MAVF",
      "CAMX",
      "DHLX",
    ],
  },
  {
    id: "US_MID",
    family: "size",
    region: "US",
    display: "US Mid Caps",
    kind: "index_blend",
    purity: US_PURITY,
    members: [
      m("VO", "morningstar", 226_000),
      m("IJH", "s&p", 123_000),
      m("IWR", "russell", 56_000),
      clone("MDY", "IJH", "s&p"),
      clone("SPMD", "IJH", "s&p"),
      clone("IVOO", "IJH", "s&p"),
      alt("SCHM", "dow-jones", 14_600),
      alt("BBMC", "morningstar", 2_100),
      alt("IMCB", "morningstar", 1_700),
    ],
    evaluated: ["FMDE", "JHMM", "XMHQ", "FLQM", "FNX", "RWK", "AVMC"],
  },
  {
    id: "US_MID_VALUE",
    family: "value",
    region: "US",
    display: "US Mid Cap Value",
    kind: "index_blend",
    purity: US_PURITY,
    members: [
      m("VOE", "morningstar", 39_000),
      m("IJJ", "s&p", 8_400),
      m("IWS", "russell", 15_000),
      clone("MDYV", "IJJ", "s&p"),
      clone("IVOV", "IJJ", "s&p"),
      alt("IMCV", "morningstar", 1_200),
    ],
    evaluated: ["AVMV", "NUMV", "RFV", "FNK", "BSMC"],
  },
  {
    id: "US_SMALL",
    family: "size",
    region: "US",
    display: "US Small Caps",
    kind: "index_blend",
    purity: US_PURITY,
    members: [
      m("VB", "morningstar", 77_000),
      m("IJR", "s&p", 104_000),
      m("IWM", "russell", 75_000),
      clone("SPSM", "IJR", "s&p"),
      clone("VIOO", "IJR", "s&p"),
      clone("SLY", "IJR", "s&p"),
      clone("VTWO", "IWM", "russell"),
      clone("RSSL", "IWM", "russell"),
      alt("SCHA", "dow-jones", 22_000),
      alt("BBSC", "morningstar", 741),
      alt("ISCB", "morningstar", 274),
    ],
    evaluated: [
      "DFAS",
      "FNDA",
      "FESM",
      "SMLF",
      "AVSC",
      "PSC",
      "DES",
      "RWJ",
      "FYX",
      "GSSC",
      "JHSC",
      "EES",
      "JPSE",
      "XSHQ",
    ],
  },
  {
    id: "US_SCV",
    family: "value",
    region: "US",
    display: "US Small Cap Value",
    kind: "index_blend",
    purity: US_PURITY,
    members: [
      m("VBR", "morningstar", 50_000),
      m("IJS", "s&p", 7_600),
      m("IWN", "russell", 13_900),
      clone("SLYV", "IJS", "s&p"),
      clone("VIOV", "IJS", "s&p"),
      clone("VTWV", "IWN", "russell"),
      alt("ISCV", "morningstar", 687),
    ],
    evaluated: [
      "AVUV",
      "DFSV",
      "DFAT",
      "CALF",
      "BSVO",
      "OSCV",
      "RZV",
      "TCV",
      "FYT",
      "SVAL",
    ],
  },
  {
    id: "US_MOM_LARGE",
    family: "momentum",
    region: "US",
    display: "US Momentum (Large/All-cap)",
    kind: "peer_composite",
    purity: US_PURITY,
    members: [
      m("SPMO", "s&p", 22_200),
      m("MTUM", "msci", 19_000),
      m("JMOM", "jpmorgan", 2_700),
      m("VFMO", "vanguard", 1_900),
      m("SEIM", "sei", 1_600),
      m("PDP", "dorsey-wright", 1_450),
      m("FDMO", "fidelity", 870),
      m("FMTM", "marketdesk", 266),
      m("MMTM", "s&p", 127),
      no("BEMO", "other", "options overlay: a hedged-equity fund, not a momentum fund"),
      no("JOET", "other", "quality plus momentum"),
      no("VAMO", "other", "value plus momentum"),
      no("SPVM", "other", "value plus momentum"),
      no("ULVM", "other", "value plus momentum"),
    ],
    evaluated: ["ONEO", "AMOM", "MFMO"],
  },
  {
    id: "US_MOM_SMID",
    family: "momentum",
    region: "US",
    display: "US SMID Momentum",
    kind: "peer_composite",
    purity: US_PURITY,
    members: [
      m("XMMO", "s&p", 7_000),
      m("XSMO", "s&p", 2_800),
      m("QMOM", "alpha-architect", 421),
      m("DWAS", "dorsey-wright", 390),
    ],
    evaluated: [],
  },
  {
    id: "INTL_DEV",
    family: "size",
    region: "INTL",
    display: "Intl Developed (Large/All-cap)",
    kind: "index_blend",
    purity: INTL_PURITY,
    members: [
      m("IDEV", "msci", 33_500),
      m("VEA", "ftse", 240_000),
      m("SPDW", "s&p", 40_800),
      alt("IEFA", "msci", 189_000, "EAFE: no Canada, not a clone"),
      alt("EFA", "msci", 76_000, "EAFE: no Canada, not a clone"),
      alt("SCHF", "ftse", 67_000),
      alt("BBIN", "jpmorgan", 6_500),
      alt("GSID", "goldman", 972),
    ],
    evaluated: ["FNDF", "AVDE", "DFAI", "DFIC", "FENI", "JIRE", "DIHP", "GSIE", "INTF"],
  },
  {
    id: "INTL_LARGE_VALUE",
    family: "value",
    region: "INTL",
    display: "Intl Large Cap Value",
    kind: "peer_composite",
    purity: INTL_PURITY,
    members: [
      m("EFV", "msci", 30_500),
      m("DFIV", "dimensional", 22_100),
      m("IVLU", "msci", 4_500),
      m("AVIV", "avantis", 2_050),
      m("GMOI", "gmo", 703),
      m("FIVA", "fidelity", 632),
      m("IVAL", "alpha-architect", 231),
      opt("FNDF", "rafi", 24_500),
      opt("PXF", "rafi", 2_900),
      opt("ICOW", "other", 1_800, "free-cash-flow yield"),
      opt("FYLD", "other", 754, "shareholder yield"),
      opt("JDVI", "other", 808, "active value, check developed share"),
      opt("BAIV", "other", 200, "active value, check developed share"),
      opt("ICPY", "other", 83, "small active value"),
      opt("DSTX", "other", 74, "rules-based value"),
      opt("AIVI", "other", 58, "rules-based value"),
      no("JIVE", "jpmorgan", "holds emerging markets too: fails the 90% developed test"),
    ],
    evaluated: [],
  },
  {
    id: "INTL_SMALL",
    family: "size",
    region: "INTL",
    display: "Intl Small Caps",
    kind: "index_blend",
    purity: INTL_PURITY,
    members: [m("SCZ", "msci", 12_700), m("SCHC", "ftse", 5_500), m("GWX", "s&p", 900)],
    evaluated: ["DFIS", "ISCF", "AVDS", "ASCI"],
  },
  {
    id: "INTL_SCV",
    family: "value",
    region: "INTL",
    display: "Intl Small Cap Value",
    kind: "peer_composite",
    purity: INTL_PURITY,
    members: [
      m("AVDV", "avantis", 20_000),
      m("DISV", "dimensional", 5_200),
      m("ISVL", "msci", 322),
      opt("FNDC", "rafi", 3_200),
      opt("DLS", "wisdomtree", 1_000, "dividend-weighted"),
      opt("PDN", "rafi", 346),
      opt("DXIV", "dimensional", 235, "all-cap, tilted"),
    ],
    evaluated: [],
  },
  {
    id: "INTL_MOM",
    family: "momentum",
    region: "INTL",
    display: "Intl Momentum",
    kind: "peer_composite",
    purity: INTL_PURITY,
    members: [
      m("IDMO", "s&p", 4_200),
      m("IMTM", "msci", 4_200),
      m("PIZ", "dorsey-wright", 613),
      m("IMOM", "alpha-architect", 136),
    ],
    evaluated: [],
  },
  {
    id: "EM",
    family: "size",
    region: "EM",
    display: "Emerging Markets",
    kind: "single_etf",
    purity: EM_PURITY,
    members: [
      m("IEMG", "msci", 153_000),
      alt("EEM", "msci", 29_600),
      alt("BBEM", "jpmorgan", 868, "check Korea treatment"),
      alt("GSEE", "goldman", 125, "check Korea treatment"),
      no("VWO", "ftse", "treats Korea as developed"),
      no("SCHE", "ftse", "treats Korea as developed"),
      no("SPEM", "s&p", "treats Korea as developed"),
    ],
    evaluated: ["AVEM", "DFAE", "DFEM", "EMGF", "JEMA", "GEM", "JHEM", "FDEM"],
  },
  {
    id: "EM_SMALL",
    family: "size",
    region: "EM",
    display: "EM Small Caps",
    kind: "peer_composite",
    purity: EM_PURITY,
    members: [
      m("EEMS", "msci", 400),
      m("EWX", "s&p", 650),
      m("AVEE", "avantis", 134),
      m("DGS", "wisdomtree", 1_650),
      opt("FEMS", "other", 194, "AlphaDEX"),
    ],
    evaluated: [],
  },
  {
    id: "EM_VALUE",
    family: "value",
    region: "EM",
    display: "EM Value",
    kind: "peer_composite",
    purity: EM_PURITY,
    members: [
      m("DFEV", "dimensional", 2_200),
      m("AVES", "avantis", 1_500),
      opt("FNDE", "rafi", 10_400),
      opt("PXH", "rafi", 2_000),
      opt("EYLD", "other", 885, "shareholder yield"),
      opt("ECOW", "other", 210, "free-cash-flow yield"),
    ],
    evaluated: [],
  },
  {
    id: "EM_MOM",
    family: "momentum",
    region: "EM",
    display: "EM Momentum",
    kind: "peer_composite",
    purity: EM_PURITY,
    members: [
      m("PIE", "dorsey-wright", 243),
      // $14–57M depending on the source: below the $50M floor on one reading. Kept on the
      // operator's override, flagged so the next review sees the disagreement.
      m("EEMO", "s&p", 35),
    ],
    evaluated: [],
  },
];

/** Fast lookup for the gate and the caption. */
export const STYLE_CLASS_BY_ID: ReadonlyMap<string, StyleClass> = new Map(
  STYLE_CLASSES.map((styleClass) => [styleClass.id, styleClass]),
);

/** The ★ members — what a composite is built from. Clones and Alt never count. */
export function membersOf(styleClass: StyleClass): StyleMember[] {
  return styleClass.members.filter((member) => member.status === "member");
}

/** ◐ — the members the optional flag adds. */
export function optionalMembersOf(styleClass: StyleClass): StyleMember[] {
  return styleClass.members.filter((member) => member.status === "optional");
}

/** §2a: how many independent passive index families a class's ★ members cover. */
export function passiveFamilyCount(styleClass: StyleClass): number {
  const families = new Set(
    membersOf(styleClass)
      .filter((member) => PASSIVE_FAMILIES.has(member.family))
      .map((member) => member.family),
  );
  return families.size;
}

/**
 * The class's benchmark members, in the order the caption lists them: ★ first, then ◐ when
 * the optional flag is on. `optional` is the POC's switch for ◐ members (§2a) — a class
 * with them off is the plan's default, and the difference is visible in the caption.
 */
export function benchmarkMembers(
  styleClass: StyleClass,
  includeOptional = false,
): StyleMember[] {
  return includeOptional
    ? [...membersOf(styleClass), ...optionalMembersOf(styleClass)]
    : membersOf(styleClass);
}

export interface FundStyle {
  ticker: string;
  classId: string;
  /** True when this fund is a ★ member of its class's benchmark, not merely evaluated. */
  peerMember: boolean;
  source: "manual" | "lookthrough";
}

/**
 * Every ticker the registry can classify, derived from the classes so the two cannot
 * drift. Precedence when a ticker appears twice: ★ beats ◐ beats Alt beats evaluated —
 * *membership* is the stronger claim about what a fund is, and a fund that is a member of
 * one class and mentioned by another is a registry question, not a runtime one.
 */
function buildFundStyles(): FundStyle[] {
  const byTicker = new Map<
    string,
    { classId: string; rank: number; peerMember: boolean }
  >();
  const rankOf = { member: 0, optional: 1, alt: 2 } as const;

  const claim = (
    ticker: string,
    classId: string,
    rank: number,
    peerMember: boolean,
  ): void => {
    const existing = byTicker.get(ticker);
    if (existing && existing.rank <= rank) return;
    byTicker.set(ticker, { classId, rank, peerMember });
  };

  for (const styleClass of STYLE_CLASSES) {
    for (const member of styleClass.members) {
      if (member.status === "excluded") continue;
      const rank = rankOf[member.status as "member" | "optional" | "alt"];
      claim(member.ticker, styleClass.id, rank, member.status === "member");
    }
    for (const ticker of styleClass.evaluated) claim(ticker, styleClass.id, 3, false);
  }

  return [...byTicker.entries()]
    .map(([ticker, entry]) => ({
      ticker,
      classId: entry.classId,
      peerMember: entry.peerMember,
      source: "manual" as const,
    }))
    .sort((a, b) => a.ticker.localeCompare(b.ticker));
}

export const FUND_STYLES: FundStyle[] = buildFundStyles();

export const FUND_STYLE_BY_TICKER: ReadonlyMap<string, FundStyle> = new Map(
  FUND_STYLES.map((style) => [style.ticker, style]),
);

/** The class a ticker is compared against, or `null` when it is untagged. */
export function classOf(ticker: string): StyleClass | null {
  const style = FUND_STYLE_BY_TICKER.get(ticker.toUpperCase());
  return style ? (STYLE_CLASS_BY_ID.get(style.classId) ?? null) : null;
}
