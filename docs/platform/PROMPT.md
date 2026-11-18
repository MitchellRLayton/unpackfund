# UnpackFund — platform work brief for dsh (scoped)

This brief comes with `platform-spec.yaml`. Commit it to `docs/platform/platform-spec.yaml`. The YAML is the typed source of truth for owner decisions, data contracts, tasks, exact UI strings, fixtures and acceptance checks. This brief sets the rules, the process and the gates. When the two disagree, the YAML wins on **what to build** and this brief wins on **how to work**.

The scope is exactly four workstreams. Build nothing outside them.

| WS | What |
|---|---|
| WS-A | **Stock-only basis.** Every number is computed on the stocks inside the funds. Bonds and cash are left out. Money market funds are accepted as holdings and left out. |
| WS-B | **Accounts.** Optional account names on holdings, plus a filter that shows one account at a time. |
| WS-C | **Expense ratios.** Taken from the prospectus first, with the shareholder report as the fallback. |
| WS-D | **Holdings dates.** One portfolio-level date-range line, plus a warning on funds whose filing is unusually old. |

UnpackFund is for equity-only or equity-heavy portfolios. When a choice is unclear, choose the one that serves a stock investor, and record it under "Ambiguities".

---

## 0. Operating mode

- **Web search: 0 searches, 0 fetches.** The one exception is EDGAR downloads by the data pipeline in WS-A (the money market list) and WS-C. They must follow H9.
- Do not edit `AGENTS.md`.
- Use one branch per workstream: `wsa-stock-basis`, `wsb-accounts`, `wsc-expense-ratios`, `wsd-dates`.
- Put the task ID in every commit message, e.g. `wsa(T-A.3): renormalize fund weights to stock share`.
- Work in gated phases. Phase 0 covers all four workstreams. **STOP at every gate** and write the report (§7). Never start the next phase without written owner approval.
- When something is ambiguous, take the conservative reading (build less).

---

## 1. Already built — do not rebuild

- share-class and ADR merging
- recursive fund-of-funds look-through
- paste-a-list
- the benchmark picker
- per-company contribution bars
- the per-fund date chip (WS-D adds to it; it does not replace it)

---

## 2. Types

```ts
type Workstream = "WS-0" | "WS-A" | "WS-B" | "WS-C" | "WS-D";
type TaskKind = "INVESTIGATE" | "BACKEND" | "FRONTEND" | "CONTENT" | "TEST";
type Approval = "PRE_APPROVED" | "OWNER_REQUIRED";
// OWNER_REQUIRED: do not implement. Prepare what `prepare` asks for, list it under "Needs your decision", and wait.
type NumberImpact = "NONE" | "NEW_NUMBERS_ONLY" | "CHANGES_EXISTING_NUMBERS";
// NONE                     → fixture CSV exports byte-identical to baseline.
// NEW_NUMBERS_ONLY         → existing CSV columns byte-identical; new columns or files allowed.
// CHANGES_EXISTING_NUMBERS → shadow first (H3), then a before/after table, then owner approval.

interface Task {
  id: string; ws: Workstream; phase: string; kind: TaskKind; title: string;
  approval: Approval; number_impact: NumberImpact; depends_on?: string[];
  spec: string;
  ui_strings?: Record<string, string>; // verbatim (H5)
  acceptance: string[];                // report each as PASS/FAIL with evidence
  prepare?: string;
}
```

---

## 3. Hard constraints

- **H1.** The release data format is a public contract. Add fields and files only; never rename, remove or change the meaning of an existing field. Bump the release `schema_version` minor.
- **H2.** Every existing share link (`#v1.`, `#v2.`, `#v3.`, with `~lens`) decodes and renders as before. `#v4.` (WS-B) is additive. Portfolios with no accounts keep writing `#v3.`.
- **H3. Shadow first.** A `CHANGES_EXISTING_NUMBERS` task first publishes its new numbers as extra fields, with the UI unchanged. It then produces the before/after table in its `prepare` field and STOPS. The UI switches only after owner approval.
- **H4. Privacy.** Nothing new is stored server-side, in localStorage or in cookies. Portfolio and account data live only in the URL fragment. No analytics or third-party scripts.
- **H5.** Use `ui_strings` verbatim. `{PLACEHOLDERS}` bind to runtime values; never hardcode example values.
- **H6.** Methodology and footer must match the code. Ship each `methodology_additions` entry in the same phase as the change it describes. Bump the methodology version 1.5.0 → 1.6.0 once, at the WS-A switch.
- **H7.** Fund pages come from the Python generator and must work without React. New fund-page UI is HTML/CSS plus native `popover`, with at most 30 new lines in the existing inline script.
- **H8.** Coverage bands (70/60) stay unchanged. Only their denominator changes in WS-A.
- **H9. EDGAR fair access.** Declare a User-Agent with a contact email, stay under 10 requests/second, retry with backoff, and reuse the pipeline's existing EDGAR client.
- **H10.** Deploy only to the separate preview Worker (`unpackfund-nav-preview`). Never deploy to the shared nightly preview Worker or to production.
- **H11.** No new runtime dependencies. Dev dependencies are allowed if listed in the report.

---

## 4. Phase 0: investigate (no code changes)

Answer every `INV-*` in the spec with file:line evidence. Build every fixture and record its URL. Save baselines:

- CSV exports for FX-1 … FX-5, in `docs/platform/baseline/`.
- The release manifest and one fund document's schema (field names and types).

**STOP.**

---

## 5. Order and the copy-cleanup project

The order is WS-A, then WS-D, then WS-B, then WS-C. Backend phases (WS-A Phase A, WS-C Phase A) can start right after Phase 0. **Frontend phases wait until copy-cleanup iteration 2 is merged**, because both projects touch the Portfolio UI.

New UI strings already follow the copy rules: at most 25 words per paragraph, sentence case, dates as `Jun 30, 2026`, and notes only when they apply. Add new concepts to `copy-spec.yaml → concepts` and `glossary_entries` in the same commit.

---

## 6. Verification

- **Fixtures:** run each task's acceptance checks on the preview at 1440×900 and 390×844. Save screenshots to `docs/platform/{ws}/{phase}/`.
- **Number invariance:** re-export the FX-1 … FX-5 CSVs and check them against the `number_impact` rule.
- **Tests (CI):**
  - unit tests for the equity mapping, money market detection, paste parsing and expense-ratio source order
  - URL round trips: `#v3` stable, `#v4` round-trips, old `#v3` links unchanged
  - golden tests for `fixtures.golden_funds`
- **Accessibility:** axe-core on every changed state, with no new violations.

---

## 7. Report format (end of every phase)

```
# {WS} Phase {X} report

## Needs your decision
- {OD or task id}: {question}. Evidence: {table/link}. Options: {A/B}. Recommendation: {one}.

## Summary
- Preview URL / branch / commits:
- Release schema_version: {old} → {new}
- Methodology version: {old} → {new or unchanged}

## Tasks
| id | status (DONE / SKIPPED_OWNER / BLOCKED) | number_impact | files | acceptance (PASS n / FAIL n) |

## Acceptance detail
- {task id} / {check}: PASS|FAIL — {evidence}

## Number changes
{before/after table, or "None: CSV diffs empty for FX-1…FX-5"}

## Blocked
- {task id}: {reason} ({file:line})

## Ambiguities
- {what} → {reading taken}

Web: 0 searches, 0 fetches. EDGAR requests: {count}, max rate {r}/s.
```

---

## 8. Stop immediately and report if

- A `NONE` or `NEW_NUMBERS_ONLY` task changes an existing CSV.
- An old share link renders differently.
- A task needs a breaking release-schema change.
- The pipeline does not keep `assetCat` per position, and adding it means re-ingesting history. Report the cost estimate.
