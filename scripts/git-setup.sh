#!/bin/sh
# One-time per-clone setup for agent git work in this repo.
# Safe to re-run. Changes only this clone's .git/config.
#
# Why: `git-credential-osxkeychain get` intermittently blocks for 30 s or more
# (traced at 35.6 s on 2026-10-28), which makes a normal `git push` look like a
# network hang. The `gh` CLI answers in ~0.2 s using the same GitHub token.

set -eu

cd "$(dirname "$0")/.." || exit 1

echo "repo: $(pwd)"

# 1. Credentials: use gh instead of the flaky macOS keychain helper.
if ! command -v gh >/dev/null 2>&1; then
  echo "git-setup: gh CLI not found — install it or auth will fall back to keychain." >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "git-setup: gh is not authenticated. Run 'gh auth login' yourself;" >&2
  echo "           an agent must never run it or paste a token." >&2
  exit 1
fi

# credential.helper is multi-valued, so --replace-all is required to stay
# idempotent (a plain set fails: "cannot overwrite multiple values").
# The empty value clears the inherited helper list; gh is then the only helper.
git config --local --replace-all credential.helper ""
git config --local --add credential.helper '!gh auth git-credential'
echo "git-setup: credential.helper -> !gh auth git-credential"

# 2. The guards: secrets and large files (pre-commit), provenance trailers
#    (commit-msg), and the same trailers at the push boundary (pre-push).
#
# Which path, and why it is not a constant.
#
# A *relative* hooksPath is resolved inside whichever worktree is committing, so a
# worktree whose tree predates the hooks has no file there and git skips it in silence.
# An *absolute* one makes every worktree run this clone's copy — but only if this tree
# actually contains the hooks; point it at a tree that does not and you have replaced
# "some worktrees are unenforced" with "no worktree is enforced", which is worse and just
# as quiet.
#
# So: absolute when this tree can back it, relative otherwise, and say which and why.
# The canonical clone, not the directory this script happens to sit in: run from a
# worktree and `pwd` is a temporary path that disappears with the worktree, leaving
# core.hooksPath pointing at nothing — and git skips a hooks path that does not exist.
_canon="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/scripts/git-hooks"
_present=""
_missing=""
for _h in pre-commit commit-msg pre-push; do
  if [ -f "$_canon/$_h" ]; then _present="$_present $_h"; else _missing="$_missing $_h"; fi
done
if [ -z "$_missing" ]; then
  git config --local core.hooksPath "$_canon"
  echo "git-setup: core.hooksPath -> $_canon ($(echo $_present))"
  echo "git-setup: every worktree of this clone now runs these hooks, whatever its own tree says"
else
  git config --local core.hooksPath scripts/git-hooks
  echo "git-setup: core.hooksPath -> scripts/git-hooks ($(echo $_present))" >&2
  echo "git-setup: WARNING the canonical clone does not contain:$_missing" >&2
  echo "           Those hooks cannot run from this tree, and git says nothing when a hook is" >&2
  echo "           missing. Left relative on purpose, so a worktree that does have them still" >&2
  echo "           runs its own. Update this checkout (git checkout main && git pull) and" >&2
  echo "           re-run git-setup.sh to switch to the absolute path." >&2
fi

# 3. Prove the credential path is actually fast, rather than assuming it.
start=$(date +%s)
if printf 'protocol=https\nhost=github.com\n\n' | perl -e 'alarm 10; exec @ARGV' gh auth git-credential get >/dev/null 2>&1; then
  echo "git-setup: credential check ok ($(($(date +%s) - start))s)"
else
  echo "git-setup: credential check FAILED — gh could not return a credential." >&2
  exit 1
fi

echo "git-setup: done. Read AGENTS.md for the commit loop."
