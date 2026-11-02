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
  branches. No human approval is required to merge.
- **A merge to `main` can publish production.** `deploy-site.yml` deploys on any
  push to `main` that touches `web/**`, `pipeline/**`, `package.json`,
  `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.nvmrc`, `wrangler.prod.jsonc` or its
  own workflow file. Land those through a **pull request** (§Landing work), so the
  diff, the evidence and the session that produced it are recorded before the
  merge. Everything else — docs, scripts, this file — may be pushed directly.
- **Never `git push --force` or `--force-with-lease` to `main`.** History on
  `main` is public and Workers Builds deploys from it.
- **Never delete or rename `main`.**
- To undo something already pushed, **add a new commit**. Do not rewrite history.
  `git revert` writes its commit without the trailers, so `pre-push` will refuse it:
  use `git revert -n <sha>` and then `scripts/session-provenance.sh commit -m "Revert …"`.
- Never `git reset --hard` a branch that has unpushed work from someone else, and
  never `git clean -xdf` without checking `git status` first.

## Landing work — three tiers

Which path a change takes is decided by what it touches, not by how large it feels.
The tier is computed for you: `scripts/session-provenance.sh pr` prints
`Touches a deploy path` or `Does not touch a deploy path` and lists the files.

| Tier | Change touches | How it lands |
|---|---|---|
| **Deploy** | any path in `deploy-site.yml`'s `paths:` list (`web/**`, `pipeline/**`, `package.json`, the lockfiles, `.nvmrc`, `wrangler.prod.jsonc`, `deploy-site.yml`) | **Pull request**, merged with a merge commit. Merging publishes `unpackfund.com`, so the production-deploy escalation rule still applies (workspace `AGENTS.md`, Autonomy) |
| **Repo, no deploy** | `scripts/`, `AGENTS.md`, `README.md`, `.gitignore`, the other workflows | Direct push to `main` when you are the only session; a PR is optional |
| **Workspace** | `docs/`, `.dsh/`, `.work/` | Nothing to commit — `docs/` is outside the repo. Record it in the day file |

**Merge with `--merge`, not `--squash`.** A merge commit keeps the branch's
messages and their provenance trailers. A squash collapses them into one
unattributed commit on `main`; if you must squash, paste the PR body's provenance
block into the squash message.

## Commit provenance

Several sessions run at once, each in its own worktree (workspace `AGENTS.md` →
multi-session playbook). A commit must say which one produced it, so the history
answers *"who changed this, and from where?"* without asking anybody.

**Every commit ends with three trailers** — merge commits excepted, because git or
GitHub writes their message:

```
Session: alpha
Worktree: .work/wt-alpha
Agent: DSH deepseek-failover (lead)
```

| Trailer | Answers | Value |
|---|---|---|
| `Session` | whose workstream | the session name; the same `<name>` in `wt-<name>` |
| `Worktree` | which workspace it was written in | `.work/wt-<name>`, or `unpackfund` for the trunk |
| `Agent` | which agent instance | the label recorded at registration |

An optional fourth, `Task: <one line>`, names the task when the commit is part of a
larger one.

**Write them with the wrapper, never by hand:**

```bash
scripts/session-provenance.sh commit -m "fix(web): one-line summary" -m "<why>"
```

The hooks enforce the block. `commit-msg` refuses a commit without it, and
`pre-push` refuses to publish one. Commits **committed** before 2026-11-02T00:00:00Z are
exempt so work already in flight is not retroactively blocked — the committer date, which
means a rebase refreshes it and a rebased old commit is enforced. `--no-verify` is
not an escape hatch. The `.work/sessions/<name>.conf` registry holds what git
cannot — the agent label, the task, the start time — and `session-worktree.sh create`
writes it for you.

### Answering the questions

| Question | Command |
|---|---|
| Who am I in this worktree? | `scripts/session-provenance.sh whoami` |
| Who wrote this commit? | `git log -1 --format='%(trailers)'` |
| What is in flight, and who owns it? | `scripts/session-provenance.sh board` |
| Which commits cannot be attributed? | `scripts/session-provenance.sh check` |
| Who has touched this file? | `scripts/session-provenance.sh blame <path>` |
| What is live right now? | `scripts/session-provenance.sh board` — last `deploy-site` run against `origin/main` |
| Open the pull request | `scripts/session-provenance.sh pr --evidence "pnpm verify exit 0"` |

Model and rationale: `docs/08-operations/2026-11-01-cross-session-provenance.md`.

## The commit loop

Run from the repo root. Always non-interactive — a git command that wants input
hangs forever in an agent shell:

```bash
git fetch origin
git status --short                      # read before you change anything
git add -A                              # stages tracked + new files, respects .gitignore
git diff --cached --stat                # confirm the change is the one you intended
scripts/session-provenance.sh commit -m "type(scope): summary"
git push origin <branch>                # feature branch, or main for a Tier 2 change
```

`scripts/session-provenance.sh commit` is `git commit` plus the provenance trailers
(§Commit provenance); a bare `git commit -m` is refused by the `commit-msg` hook.

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

**Every commit ends with the three provenance trailers** — `Session`, `Worktree`,
`Agent` — so agent work is distinguishable from the operator's in `git log` and
attributable to one session and one worktree. The contract, the wrapper and the
enforcement are in §Commit provenance above; do not hand-write the block.

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

## Hooks

```bash
scripts/git-setup.sh          # enable once per clone (sets core.hooksPath)
```

Three hooks live in `scripts/git-hooks/`, and all three are part of the workflow,
not optional extras:

| Hook | Refuses |
|---|---|
| `pre-commit` | staged `.env` files, credential-shaped strings, files over 5 MiB |
| `commit-msg` | a commit without the `Session`/`Worktree`/`Agent` trailers, or one that names another worktree's session |
| `pre-push` | publishing a commit *committed* after 2026-11-02T00:00:00Z that has no trailers, or one whose `Session` and `Worktree` disagree — the second lock, for commits made with `--no-verify` |

They are a safety net for the rules above, and `--no-verify` is never the way past
them: fix the commit, not the hook.

`git-setup.sh` sets `core.hooksPath` to this clone's **absolute** `scripts/git-hooks/`
when the tree it runs from contains all three hooks — then every worktree of the clone runs
that one copy, whatever its own tree says. When a hook is missing from the tree it runs
from, it leaves the path **relative** and prints which ones: an absolute path aimed at a
tree without the hooks would disable enforcement everywhere instead of in one place, and
just as quietly. A branch that edits a hook therefore tests against the canonical copy, not
its own; run the edited one explicitly:

```bash
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath \
  GIT_CONFIG_VALUE_0="$PWD/scripts/git-hooks" git commit -m "…"
```

## Status of this file

Added 2026-10-28 to give agents a working git surface for this repo; updated
2026-11-01 with the commit-provenance contract and the three landing tiers. It is a
plain-language rule file, not a build artifact; keep it current when the workflow
changes.
