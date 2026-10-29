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

# 2. The secret/large-file pre-commit guard.
git config --local core.hooksPath scripts/git-hooks
echo "git-setup: core.hooksPath -> scripts/git-hooks"

# 3. Prove the credential path is actually fast, rather than assuming it.
start=$(date +%s)
if printf 'protocol=https\nhost=github.com\n\n' | perl -e 'alarm 10; exec @ARGV' gh auth git-credential get >/dev/null 2>&1; then
  echo "git-setup: credential check ok ($(($(date +%s) - start))s)"
else
  echo "git-setup: credential check FAILED — gh could not return a credential." >&2
  exit 1
fi

echo "git-setup: done. Read AGENTS.md for the commit loop."
