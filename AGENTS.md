# Agent instructions — UnpackFund repo

This file governs agents working in **this repository**. Project-wide rules
(docs layout, secrets policy, filesystem boundary, web-search governance) live in
the workspace `AGENTS.md` one level up; they apply here too.

**Canonical local clone:** `Personal-AI-Sandbox/unpackfund` (this repo).
Do not create a second working copy; do not work from `.work/`.

## Git authority

- Agents may **commit and push directly to `main`**, and may push feature
  branches. No pull request is required.
- **Never `git push --force` or `--force-with-lease` to `main`.** History on
  `main` is public and Workers Builds deploys from it.
- **Never delete or rename `main`.**
- To undo something already pushed, **add a new commit** (`git revert`). Do not
  rewrite history.
- Never `git reset --hard` a branch that has unpushed work from someone else, and
  never `git clean -xdf` without checking `git status` first.

## The commit loop

Run from the repo root. Always non-interactive — a git command that wants input
hangs forever in an agent shell:

```bash
git fetch origin
git status --short                      # read before you change anything
git add -A                              # stages tracked + new files, respects .gitignore
git diff --cached --stat                # confirm the change is the one you intended
git commit --no-edit -m "type(scope): summary"
git push origin main
```

Push with a timeout so a network stall fails loudly instead of hanging:

```bash
GIT_TERMINAL_PROMPT=0 perl -e 'alarm 90; exec @ARGV' git push origin main
```

`GIT_TERMINAL_PROMPT=0` is mandatory. Credentials resolve through the macOS
keychain; never paste a token into a command, a remote URL, or chat.

## Commit messages

`type(scope): summary` — `add`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`.
Imperative mood, present tense, no trailing period, ≤72 characters in the subject.
Body (optional) explains *why*, wrapped at 72.

**Every agent-authored commit ends with a trailer:**

```
Agent: <name or model-id>
```

so agent work is distinguishable from the operator's in `git log`.

## Hard rules — do not break these

- **Never commit secrets.** `.env`, `.env.*` (except `.env.example`), tokens,
  keys, certificates, and account identifiers stay out of the repo. The staged
  `check:secrets` guard (below) enforces this; never bypass it with `--no-verify`.
- **One logical change per commit.** Do not mix formatting churn with behaviour.
- **Never hand-edit generated artifacts.** They are git-ignored and rebuilt from
  source (see `xray-project-conventions` invariant I5).
- **Verify before you push.** A commit that claims to work must have a command
  and exit code behind it in the same session.
- **Do not amend or rebase commits that are already pushed** to `main`.

## Optional local guard

```bash
git config core.hooksPath scripts/git-hooks   # enable once per clone
```

The pre-commit hook blocks staged `.env` files and obvious secret patterns. It is
a safety net for accidental staging, not a substitute for the rules above.

## Status of this file

Added 2026-10-28 to give agents a working git surface for this repo. It is a
plain-language rule file, not a build artifact; keep it current when the workflow
changes.
