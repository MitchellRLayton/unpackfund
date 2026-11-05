"""Flatten a fund-of-funds to the companies it ultimately owns (ADR-0013).

A registered fund that holds other registered funds is a portfolio of portfolios. Its
own filing names the sleeves and their weights and says nothing about the companies —
those exist one level down, inside funds we already publish from the same period end.
So the look-through is not a data problem, it is a join plus a weighted sum:

    w(i) = Σ_k W_k · w(i, k)

with `W_k` the parent's weight in sleeve `k` and `w(i, k)` company `i`'s weight inside
it. That is the same identity `weights` and the ledger already use; nothing new is
computed here except the case where a sleeve is itself a wrapper, which is the same
operation applied again.

**The join key is the target's own `seriesLei`.** Every N-PORT carries it in
`genInfo/seriesLei` (present in 30,757 of 30,757 cached filings, measured 2026-11-01)
and a parent's holding row carries the sleeve's LEI in `<lei>`. Matching is equality,
not inference. Measured over 62,804 non-cash fund rows: the LEI resolves 52.6% of
fund-row weight, the share-class ticker 35.8%, either 68.3%, and **32.5% of the weight
resolves by LEI and by nothing else** — a name-and-ticker ladder cannot see it. A name
is not a key: AVGV files "Avantis US Large Cap Value ETF" against our published
"Avantis U.S. Large Cap Value ETF", so 3 of its 6 edges fail an exact-name join.

**Depth is capped, and the cap is a published fact.** One hop covers the measured
population (AVGV's six sleeves are all terminal — each files zero fund rows). Three
bounds the walk against a chain nobody has measured yet. Anything left at the cap, or
unresolved, stays in the vector as a labelled `fund` row and is counted in
`unresolved_fund_bp`: never dropped, never renormalised over the companies that did
resolve. A cycle and a self-holding terminate for the same reason the cap does — they
are the same rule (`path` membership) and neither depends on the data being well
behaved.

Everything here is deterministic: floats accumulate in a fixed order and are converted
to integer basis points once, by `weights.allocate_bp`, so two builds on the same
filings produce identical bytes (invariant I5).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Mapping, Sequence

from . import classify, identifiers, weights

BP_PER_UNIT = weights.BP_PER_UNIT

#: How many fund→fund hops a vector may be expanded through. One hop is what the
#: measured population needs; three is a bound, not an ambition. Counted as hops, so
#: a root expands at ``MAX_DEPTH``, its sleeve at ``MAX_DEPTH - 1``, and the fund that
#: has none left keeps its own fund rows labelled.
MAX_DEPTH = 3

#: Publish the flattened vector only when enough of NAV arrives through fund edges to
#: change what a reader sees. Below this, `components` still names the sleeves (cheap,
#: a handful of rows) but the composed vector is not shipped: it would duplicate a
#: child's holdings to move coverage by a point or two, and 6,000 funds' worth of that
#: is the difference between a release that uploads in an hour and one that does not.
MIN_LOOKTHROUGH_BP = 500

#: The largest composed vector that is published. A wrapper's flatten is a copy of its
#: sleeves' portfolios, so its size is the *sum of fund documents we already publish*,
#: and the measured population makes that fatal: 1,120 funds hold ≥5% in funds and
#: composing all of them adds **7.5 million rows / ~1.2 GB**, four times the entire
#: current release, because a target-date fund's twelve sleeves hold tens of thousands
#: of positions between them.
#:
#: So the vector is published only when it fits, at ~162 bytes a row — 6,000 rows is
#: about 1 MB, under the 2 MB artifact ceiling and about 150 kB gzipped, roughly what
#: the largest equity funds already cost. **A fund that does not fit is not truncated**:
#: it publishes `components` and no `lookthrough`, so there is no vector whose weights
#: are quietly understated, and no reader has to know which funds were shortened. A
#: fund page for a target-date fund then shows the sleeves it holds, which is the more
#: useful answer anyway.
MAX_LOOKTHROUGH_ROWS = 6_000

#: Residual fund weight, in basis points of NAV, at which a partially flattened fund is
#: labelled as such. Below it the leftover is rounding, and a warning that fires on every
#: fund teaches a reader to ignore warnings.
MIN_UNRESOLVED_WARNING_BP = 100

RUNG_LEI = "series_lei"
RUNG_SYMBOL = "share_class_symbol"
#: The one label ``components[].asset_cat`` carries that is not an N-PORT category.
SLEEVE_MIXED = "mixed"
RUNG_NONE = ""


@dataclass(frozen=True)
class FundEdge:
    """One parent→sleeve position, with the identifiers that can resolve it."""

    weight_bp: int
    name: str
    ticker: str | None = None
    lei: str | None = None
    isin: str | None = None


@dataclass(frozen=True)
class FundInput:
    """The minimum a fund has to expose to be composed into a parent."""

    ticker: str
    as_of: str
    holdings: tuple[weights.FundHolding, ...]
    series_lei: str | None = None
    name: str = ""


def edges_of(vector: weights.WeightVector) -> list[FundEdge]:
    """The fund positions in a weight vector, in publication order."""
    return [
        FundEdge(
            weight_bp=row.weight_bp,
            name=identifiers.public_name(row.name),
            ticker=row.ticker,
            lei=row.lei,
            isin=row.isin,
        )
        for row in vector.holdings
        if row.asset_cat == classify.FUND
    ]


@dataclass
class EdgeIndex:
    """What a fund row's identifiers can be matched against.

    Two exact keys and nothing else. `by_lei` is the target's own filed `seriesLei`,
    which is an equality; `by_symbol` is a share-class ticker that the release already
    publishes as a class of a known fund (`aliases.json` is the same map). A name is
    deliberately absent: an exact name match resolves fewer edges than either key and
    the ones it resolves are the ones most likely to be wrong (two funds can share a
    name; a trust name resolves to no series at all).
    """

    by_lei: dict[str, str] = field(default_factory=dict)
    by_symbol: dict[str, str] = field(default_factory=dict)
    names: dict[str, str] = field(default_factory=dict)

    @classmethod
    def build(
        cls,
        funds: Mapping[str, FundInput],
        aliases: Mapping[str, str] | None = None,
    ) -> "EdgeIndex":
        by_lei: dict[str, str] = {}
        for fund in funds.values():
            lei = (fund.series_lei or "").strip().upper()
            if lei:
                by_lei.setdefault(lei, fund.ticker)
        by_symbol = {ticker.upper(): ticker for ticker in funds}
        for symbol, ticker in (aliases or {}).items():
            if ticker in funds:
                by_symbol.setdefault(symbol.upper(), ticker)
        names = {ticker: fund.name for ticker, fund in funds.items() if fund.name}
        return cls(by_lei=by_lei, by_symbol=by_symbol, names=names)

    def resolve(self, edge: FundEdge) -> tuple[str | None, str]:
        """The published ticker this edge names, and which key named it.

        LEI first: it identifies the *series*, while a symbol identifies a share class
        and can be absent (46.7% of fund rows carry one) or ambiguous. A self-edge is
        refused by the caller, not here — this function answers "who is this", and
        "this is me" is a fact about the position, not about the identifier.
        """
        lei = (edge.lei or "").strip().upper()
        if lei and lei in self.by_lei:
            return self.by_lei[lei], RUNG_LEI
        for symbol in (edge.ticker, edge.isin):
            token = (symbol or "").strip().upper()
            if token and token in self.by_symbol:
                return self.by_symbol[token], RUNG_SYMBOL
        return None, RUNG_NONE


@dataclass
class _Rows:
    """A fund's vector after expansion, in basis points of *that fund's* NAV."""

    #: ``key → {"company_id", "name", "ticker", "asset_cat", "weight"}``; weight is a
    #: float here and becomes an integer exactly once, at the root.
    rows: dict[tuple, dict] = field(default_factory=dict)
    #: Fund weight still sitting in `rows` as a `fund` row: unresolved, beyond the cap,
    #: or a cycle. Always ≤ the fund's own fund weight, and never redistributed.
    fund_left: float = 0.0
    #: Hops actually used below this fund. 0 = no edge was expanded.
    depth: int = 0
    #: Largest date difference between this fund and a sleeve it was expanded through.
    skew_days: int = 0

    def add(self, key: tuple, row: dict, weight: float) -> None:
        existing = self.rows.get(key)
        if existing is None:
            self.rows[key] = {**row, "weight": weight}
        else:
            existing["weight"] += weight


@dataclass
class Composed:
    """One fund, flattened.

    The flattened vector is meant to **become** the fund's ``holdings``, not to sit
    beside them. One vector, one number: the ledger, the reverse index, the fund page,
    the CSV export and the validator all read ``holdings``, and a second composed copy
    would be a second implementation of the same weight with no rule for which one
    wins. The sleeve view is not lost — it is ``components``, which is what a reader
    wanting "what funds does this hold" is actually asking for.
    """

    holdings: list[dict]
    coverage_pct: float
    metrics: dict[str, float | None]
    components: list[dict]
    depth: int
    fund_bp: int
    resolved_fund_bp: int
    unresolved_fund_bp: int
    as_of_skew_days: int
    total_bp: int
    refusals: dict[str, int] = field(default_factory=dict)

    def as_lookthrough(self) -> dict:
        """The provenance object. Key order is the contract's, not insertion luck."""
        return {
            "depth": self.depth,
            "fund_bp": self.fund_bp,
            "resolved_fund_bp": self.resolved_fund_bp,
            "unresolved_fund_bp": self.unresolved_fund_bp,
            "as_of_skew_days": self.as_of_skew_days,
            "holdings_bp": self.total_bp,
            "refused": dict(sorted(self.refusals.items())),
        }


class Composer:
    """Expand fund edges across a release, once, with cycles and depth bounded."""

    def __init__(self, funds: Mapping[str, FundInput], index: EdgeIndex) -> None:
        self.funds = funds
        self.index = index
        self._edge_cache: dict[str, list[tuple[FundEdge, str | None, str]]] = {}
        self._flat_cache: dict[tuple[str, int], _Rows] = {}
        self._cycles = 0
        #: Counted, not hidden: a release reports how many edges each refusal met.
        self.counts: dict[str, int] = {}

    def _count(self, name: str, by: int = 1) -> None:
        self.counts[name] = self.counts.get(name, 0) + by

    def edges(self, ticker: str) -> list[tuple[FundEdge, str | None, str]]:
        """This fund's fund positions, each with its resolved target."""
        cached = self._edge_cache.get(ticker)
        if cached is not None:
            return cached
        fund = self.funds.get(ticker)
        resolved: list[tuple[FundEdge, str | None, str]] = []
        if fund is not None:
            for row in fund.holdings:
                if row.asset_cat != classify.FUND:
                    continue
                edge = FundEdge(
                    weight_bp=row.weight_bp,
                    name=identifiers.public_name(row.name),
                    ticker=row.ticker,
                    lei=row.lei,
                    isin=row.isin,
                )
                target, rung = self.index.resolve(edge)
                resolved.append((edge, target, rung))
        self._edge_cache[ticker] = resolved
        return resolved

    def _flat(self, ticker: str, remaining: int, path: frozenset[str]) -> _Rows:
        """One fund's vector with its fund edges expanded ``remaining`` hops deep."""
        key = (ticker, remaining)
        cached = self._flat_cache.get(key)
        if cached is not None:
            return cached
        # The only use of ``path`` is cycle detection, so a subtree that refused no
        # cycle produced the same answer it would produce from any other path — which
        # is exactly when it is safe to memoise. A subtree that *did* meet a cycle is
        # recomputed, because its answer depends on where the walk started.
        cycles_before = self._cycles
        fund = self.funds.get(ticker)
        out = _Rows()
        if fund is None:
            self._count("missing_fund")
            return out
        for row in fund.holdings:
            if row.asset_cat != classify.FUND:
                out.add(
                    (row.company_id,)
                    if row.company_id
                    else ("row", identifiers.public_name(row.name).upper(), row.asset_cat),
                    {
                        "company_id": row.company_id,
                        "name": row.name,
                        "ticker": row.ticker,
                        "asset_cat": row.asset_cat,
                        # Carried so a composed row keeps the filing's own country for
                        # a position no company was named for. Without it a flattened
                        # wrapper loses the only country evidence its unmatched rows
                        # have, and the Markets bar draws them as weight with no market.
                        "country": row.country,
                    },
                    float(row.weight_bp),
                )
                continue
            edge = FundEdge(
                weight_bp=row.weight_bp,
                name=row.name,
                ticker=row.ticker,
                lei=row.lei,
                isin=row.isin,
            )
            target, _rung = self.index.resolve(edge)
            weight = float(row.weight_bp)
            refusal = self._refusal(ticker, target, remaining, path)
            if refusal is not None:
                self._count(refusal)
                if refusal == "cycle":
                    self._cycles += 1
                out.add(
                    ("fund", refusal, (edge.lei or edge.isin or edge.name).upper()),
                    {
                        "company_id": None,
                        "name": self.index.names.get(target or "", "") or edge.name,
                        "ticker": target,
                        "asset_cat": classify.FUND,
                        # A sleeve we resolved but chose not to expand keeps its
                        # ticker: unlike an as-filed symbol on an unmapped row, this
                        # one names a fund we publish, so it is a fact we can vouch for.
                        "resolved": target is not None,
                        # The filing's country for this fund position is the *fund's*
                        # domicile, not a market exposure. It is carried because the
                        # row is otherwise unplaceable, and the Markets bar states that
                        # a sleeve it could not open is placed by its own domicile.
                        "country": row.country,
                    },
                    weight,
                )
                out.fund_left += weight
                continue
            assert target is not None
            child = self._flat(target, remaining - 1, path | {ticker})
            scale = weight / BP_PER_UNIT
            for child_key, child_row in child.rows.items():
                out.add(child_key, child_row, scale * child_row["weight"])
            out.fund_left += scale * child.fund_left
            out.depth = max(out.depth, child.depth + 1)
            child_fund = self.funds.get(target)
            if child_fund is not None:
                out.skew_days = max(
                    out.skew_days,
                    child.skew_days,
                    _days(child_fund.as_of, fund.as_of),
                )
        if self._cycles == cycles_before:
            self._flat_cache[key] = out
        return out

    def _refusal(
        self, parent: str, target: str | None, remaining: int, path: frozenset[str]
    ) -> str | None:
        """Why this edge stops here, or ``None`` when it is expandable.

        Every branch is a published count on the release, because "we could not look
        through this" is information and "we quietly stopped" is not. Order matters:
        an unresolved identifier is a different fact from a chain that hit the cap.
        """
        if target is None:
            return "unresolved"
        if target == parent or target in path:
            return "cycle"
        if remaining <= 0:
            return "depth"
        return None

    def skip_reason(self, composed: "Composed") -> str | None:
        """Why this fund's vector is not flattened, or ``None`` when it is.

        Two refusals, and they are different facts. ``immaterial`` means the fund is
        mostly companies already, so the flatten buys a point of coverage for a copy of
        a sleeve's whole portfolio. ``too_large`` means the flatten is right and the
        vector does not fit the release; the sleeves are still published. Counting
        them separately is what makes the second one fixable later (a lazy per-fund
        object, a wider ceiling) instead of an unexplained gap.
        """
        if composed.resolved_fund_bp < MIN_LOOKTHROUGH_BP:
            return "immaterial"
        if len(composed.holdings) > MAX_LOOKTHROUGH_ROWS:
            return "too_large"
        return None

    def wants_lookthrough(self, composed: "Composed") -> bool:
        """Whether the flattened vector replaces the filed one."""
        return self.skip_reason(composed) is None


    def compose(self, ticker: str) -> Composed:
        """The flattened vector for one fund, in integer basis points."""
        fund = self.funds.get(ticker)
        if fund is None:
            raise KeyError(ticker)
        # The memo holds every flattened sleeve's rows. Across a release that is the
        # whole corpus several times over — measured at 7.5M rows for the wrappers we
        # compose, which is gigabytes of dicts — so it is cleared per root and only
        # pays for a sleeve that appears twice *within* one fund (two share classes of
        # the same fund, or the same child on two rungs of a chain). Re-flattening is
        # ~10 s for the whole release, which is the cheaper half of that trade.
        self._flat_cache.clear()
        flat = self._flat(ticker, MAX_DEPTH, frozenset())
        ordered = sorted(
            flat.rows.values(),
            key=lambda row: (-row["weight"], identifiers.public_name(row["name"]).upper()),
        )
        # ``allocate_bp`` takes **fractions** and returns basis points; the composed
        # weights are already basis points of the parent's NAV, so they are divided
        # back first. Getting this backwards multiplies every weight by 10,000 and
        # still produces a vector that sums consistently — the failure mode is a fund
        # that looks 100× more concentrated than it is, not a crash.
        bp = weights.allocate_bp([row["weight"] / BP_PER_UNIT for row in ordered])
        holdings = [
            {
                "company_id": row["company_id"],
                "name": identifiers.public_name(row["name"]),
                "ticker": (
                    row["ticker"]
                    if row["company_id"] or row.get("resolved")
                    else None
                ),
                "asset_cat": row["asset_cat"],
                "weight_bp": weight,
                # Same rule as ``artifact.holding_row``: the filing's country is
                # published only where no company was named, so a composed document
                # and a filed one carry the field in the same place and for the same
                # reason. ``published_row`` inserts ``identified`` after ``weight_bp``,
                # which keeps the key order identical to the filed vector's.
                **(
                    {"filed_country": row["country"]}
                    if row.get("country") and not row["company_id"]
                    else {}
                ),
            }
            for row, weight in zip(ordered, bp)
            # A composition of 5,000 holdings across six sleeves produces a long tail
            # of rows that round to nothing. They cannot move a sum, and keeping them
            # would make a flattened wrapper's document several times larger for a set
            # of rows every one of which reads "0.00%".
            if weight
        ]
        holdings.sort(
            key=lambda row: (-row["weight_bp"], row["name"].upper())
        )
        total = sum(row["weight_bp"] for row in holdings)
        gross = sum(abs(row["weight_bp"]) for row in holdings)
        mapped = sum(abs(row["weight_bp"]) for row in holdings if row["company_id"])
        coverage = round(100 * mapped / gross, 1) if gross else 0.0

        as_holdings = [
            weights.FundHolding(
                company_id=row["company_id"],
                name=row["name"],
                ticker=row["ticker"],
                asset_cat=row["asset_cat"],
                weight_bp=row["weight_bp"],
                is_company_exposure=row["asset_cat"] in classify.COMPANY_CATEGORIES,
                country=row.get("filed_country"),
            )
            for row in holdings
        ]

        edges = self.edges(ticker)
        fund_bp = sum(edge.weight_bp for edge, _, _ in edges)
        resolved_bp = sum(
            edge.weight_bp for edge, target, _ in edges if target in self.funds
        )
        # Every sleeve, merged onto the fund it resolves to, because the sleeve view has
        # to add up to ``fund_bp`` or the provenance describes a different fund than the
        # one published. Three cases that a naive list gets wrong:
        #
        # * a fund that holds two share classes of one sleeve is one sleeve, and the
        #   composition already merges them into one row, so the components merge too;
        # * a **short** position in a fund is a real sleeve (BRMSX is long 1,398 bp of
        #   ETFs and short 688 bp of SPY) and dropping it would make the sum disagree
        #   with ``fund_bp`` by exactly the short;
        # * an unresolved sleeve cannot be merged by ticker, so each row stands alone
        #   and keeps the name the filing gave it.
        merged: dict[str, dict] = {}
        largest: dict[str, int] = {}
        for position, (edge, target, rung) in enumerate(edges):
            key = target or f"unresolved:{position}"
            row = merged.get(key)
            if row is None:
                child = self.funds.get(target) if target else None
                merged[key] = {
                    "ticker": target,
                    "name": self.index.names.get(target or "") or edge.name,
                    "weight_bp": edge.weight_bp,
                    "coverage_pct": _coverage(tuple(child.holdings)) if child else None,
                    # What the sleeve *is*, from its own published split (ADR-0016 §4):
                    # a page can then group 60% equity sleeves / 39% bond sleeves instead
                    # of making a reader add seven rows up. `None` for a sleeve we could
                    # not resolve — we do not know what it holds, so we do not label it.
                    "asset_cat": _sleeve_label(tuple(child.holdings)) if child else None,
                    "resolved_by": rung or None,
                }
                largest[key] = abs(edge.weight_bp)
                continue
            row["weight_bp"] += edge.weight_bp
            # Two share classes of one sleeve can arrive by different rungs. The row
            # names the rung that carried the larger position, which is the one a reader
            # checking the match would have checked.
            if abs(edge.weight_bp) > largest[key]:
                largest[key] = abs(edge.weight_bp)
                row["resolved_by"] = rung or None
        # A sleeve whose as-filed weight rounds to 0 bp contributes nothing to the sum, so
        # dropping it keeps the identity `Σ components == fund_bp` exactly. 98 funds in
        # the first full build held a 0 bp sleeve, and a 0.00% row is noise beside the
        # real sleeves it sits between.
        components = [row for row in merged.values() if row["weight_bp"]]
        components.sort(key=lambda row: (-row["weight_bp"], row["name"].upper()))

        # Fund weight still unexpanded, in this fund's own basis points. Read from the
        # flatten rather than from the edges: the two differ exactly when a sleeve is
        # itself a wrapper whose own wrapper could not be resolved, and that case is
        # the one a reader must not have to infer.
        unresolved_bp = round(flat.fund_left)
        # Per-fund refusals describe *this fund's own* edges only. Anything deeper is
        # counted on the release (`Composer.counts`): a walk that was memoised from
        # another parent did no fresh work here, so a per-fund depth/cycle count would
        # describe the cache rather than the fund.
        refusals = {"unresolved": 0, "self": 0}
        for _edge, target, _rung in edges:
            if target is None:
                refusals["unresolved"] += 1
            elif target == ticker:
                refusals["self"] += 1
        refusals = {name: count for name, count in refusals.items() if count}
        return Composed(
            holdings=holdings,
            coverage_pct=coverage,
            metrics=weights.metrics(as_holdings),
            components=components,
            depth=flat.depth,
            fund_bp=fund_bp,
            resolved_fund_bp=resolved_bp,
            unresolved_fund_bp=unresolved_bp,
            as_of_skew_days=flat.skew_days,
            total_bp=total,
            refusals=refusals,
        )


#: A sleeve is ``mixed`` when both equity and debt are at least this share of it.
#: 20% is the same threshold the release uses to call a fund balanced, so "mixed" and
#: "balanced fund" mean the same thing rather than two things a reader must reconcile.
MIXED_FLOOR_BP = 2_000


def _sleeve_label(holdings: Sequence[weights.FundHolding]) -> str | None:
    """One word for what a sleeve holds, from its own published split.

    The rule is stated once here and gated in ``validate``: equity and debt both at or
    above :data:`MIXED_FLOOR_BP` of the sleeve's gross makes it ``mixed``; otherwise the
    sleeve is its largest class. Nothing is inferred from the sleeve's name or from its
    own category label — its vector already says it exactly.
    """
    if not holdings:
        return None
    rows = [(row.asset_cat, row.weight_bp, False) for row in holdings]
    totals = weights.category_totals(rows)
    gross = sum(abs(weight) for weight in totals.values())
    if gross <= 0:
        return None
    equity = abs(totals.get(classify.EQUITY, 0))
    debt = abs(totals.get(classify.DEBT, 0))
    if equity >= MIXED_FLOOR_BP and debt >= MIXED_FLOOR_BP:
        return SLEEVE_MIXED
    dominant = max(totals.items(), key=lambda item: abs(item[1]))
    return dominant[0] if dominant[1] else None


def _coverage(holdings: Sequence[weights.FundHolding]) -> float:
    """A published fund's own coverage, recomputed from its vector."""
    gross = sum(abs(row.weight_bp) for row in holdings)
    if gross <= 0:
        return 0.0
    mapped = sum(abs(row.weight_bp) for row in holdings if row.company_id)
    return round(100 * mapped / gross, 1)


def _days(later: str, earlier: str) -> int:
    from datetime import date

    try:
        return abs((date.fromisoformat(later) - date.fromisoformat(earlier)).days)
    except (TypeError, ValueError):
        return 0
