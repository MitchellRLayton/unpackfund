# Agent instructions — UnpackFund repo

This file governs agents working in **this repository**. Project-wide rules
(docs layout, secrets policy, filesystem boundary, web-search governance) live in
the workspace `AGENTS.md` one level up; they apply here too.

**Canonical local clone:** `Personal-AI-Sandbox/unpackfund` (this repo).
Do not create a second working copy; do not work from `.work/`.

**Multiple concurrent sessions:** work in a worktree — see
`docs/08-operations/2026-10-30-multi-session-playbook.md`. The single-session rules above apply when you are
the only session running. (Added 2026-10-30: `.work/wt-*` is a worktree of the same `.git`, not a second working
copy; the older prohibition was written when one session owned the tree.)

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

`GIT_TERMINAL_PROMPT=0` is mandatory. Never paste a token into a command, a
remote URL, or chat.

### Credentials: run the setup step once per clone

`git push` here can appear to hang. Traced on 2026-10-28: the push itself is
fine, but `git-credential-osxkeychain get` intermittently blocks for 30 s or
more (one trace showed **35.6 s** stopped inside it). Under a plain `git push`
that looks exactly like a network hang, which is how a "push is broken" belief
started.

Route git auth through the `gh` CLI instead, which answers in ~0.2 s and reads
the same token:

```bash
scripts/git-setup.sh          # or do it by hand:
git config --local credential.helper ""                  # clear inherited osxkeychain
git config --local --add credential.helper '!gh auth git-credential'
```

This is **repo-local** (`.git/config`), so it is not cloned — run
`scripts/git-setup.sh` once after every fresh clone. If a push ever stalls,
re-run the trace before assuming the network:

```bash
GIT_TERMINAL_PROMPT=0 GIT_TRACE=1 GIT_TRACE_PERFORMANCE=1 \
  perl -e 'alarm 30; exec @ARGV' git push origin main 2>&1 | grep -E 'credential|main ->'
```

A multi-second `git credential-… get` line confirms the helper, not the network.
Do not "fix" a stalled push by switching to the GitHub Git Data API; if the
helper is the problem, fix the helper.

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
