<!--
Prefer generating this PR:  scripts/session-provenance.sh pr
It fills the provenance block from the branch and the commit trailers, and computes
whether merging publishes production. This template is for a hand-written PR.

Merge with a merge commit (`gh pr merge --merge`), not a squash: squash discards the
branch's commit messages and the provenance trailers that travel with them.
-->

## What and why

_One or two sentences: what changes, and what problem it solves._

## Provenance

| | |
|---|---|
| Session | `` |
| Worktree | `` |
| Branch | `` |
| Agent | `` |

## Verification

_Command, exit code, and the line it printed. A claim without one is not evidence._

## Production impact

- [ ] Does not touch a deploy path — merging does not publish the site.
- [ ] Touches a deploy path (`web/**`, `pipeline/**`, `package.json`, `pnpm-lock.yaml`,
      `pnpm-workspace.yaml`, `.nvmrc`, `wrangler.prod.jsonc`,
      `.github/workflows/deploy-site.yml`) — **merging runs `deploy-site` and publishes
      `unpackfund.com`.** A production deploy is an escalation item (workspace
      `AGENTS.md`, Autonomy).

## Rollback

_`git revert <merge-sha>` on `main`, or the release id to promote back to._
