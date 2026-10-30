#!/usr/bin/env bash
# session-worktree.sh — one git worktree per concurrent agent session.
#
# Why this exists: 2-4 DeepSeek Harness sessions share this checkout, so they
# share one working tree, one git index and one web/out. On 2026-10-30 a build in
# the shared tree would have shipped another session's uncommitted UI work; one
# session's `pnpm build` also wipes the export another session just produced.
# A worktree gives each session its own checkout of the same repository: same
# .git (one history, one object store), its own index, its own web/out.
#
# Usage:
#   session-worktree.sh create <name> [--branch <branch>|--at <commit>]
#   session-worktree.sh list
#   session-worktree.sh remove <name> [--force]
#
# Worktrees live at <workspace>/.work/wt-<name> — inside the workspace, outside
# the repo, and git-ignored from both directions. The trunk clone
# (<workspace>/unpackfund) stays the canonical checkout on `main`.
#
# What `create` does, and why:
#   * `git worktree add` at the requested commit, on its own branch.
#   * HARD-LINKS node_modules and web/node_modules from the trunk. A symlinked
#     node_modules is refused by pnpm (ERR_PNPM_UNSAFE_MODULES_DIR), and a
#     reinstall would cost minutes and a fresh store; hard links are the only
#     option that keeps pnpm, `next`, and vitest working with no install.
#   * HARD-LINKS .venv (falls back to a symlink — Python tolerates both). The
#     venv holds no editable install, so `cd pipeline && ../.venv/pipeline/bin/
#     python -m ...` resolves to the worktree's own pipeline package.
#   * Does NOT copy .env. Secrets stay in exactly one file; the worktree reads
#     them through UNPACKFUND_ENV_FILE (honoured by pipeline/pipeline/paths.py).
#
# What it deliberately does not do: `pnpm install`, `git fetch`, or any write
# outside <workspace>. Never run `pnpm install` inside a worktree — it would
# replace the hard-linked tree with a fresh one from an empty .pnpm-store.
#
# Playbook: docs/08-operations/2026-10-30-multi-session-playbook.md

set -euo pipefail

# The workspace is a hard boundary (workspace AGENTS.md, "Filesystem scope").
# Every path this script touches is derived from here and checked against it.
BOUNDARY="/Users/mitchell.layton/Personal-AI-Sandbox"

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -P "$SCRIPT_DIR/.." && pwd -P)"
WORKSPACE="$(cd -P "$REPO_ROOT/.." && pwd -P)"
WORK_ROOT="$WORKSPACE/.work"

die() { printf 'session-worktree: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }

inside_boundary() {
  case "$1" in
    "$BOUNDARY"/*) return 0 ;;
    *) return 1 ;;
  esac
}

require_boundary() {
  inside_boundary "$1" || die "refusing to touch $1 — outside the workspace boundary $BOUNDARY"
}

require_repo() {
  git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1 ||
    die "not a git repository: $REPO_ROOT"
}

# <name> becomes a directory name and a branch name, so keep it boring.
valid_name() {
  case "$1" in
    "" | *[!a-z0-9-]*) return 1 ;;
    [!a-z]*) return 1 ;;
  esac
  [ "${#1}" -le 32 ]
}

worktree_registered() {
  git -C "$REPO_ROOT" worktree list --porcelain |
    grep -Fxq "worktree $1"
}

now_short() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

usage() {
  cat <<'EOF'
session-worktree.sh — one git worktree per concurrent agent session

Usage:
  session-worktree.sh create <name> [--branch <branch>|--at <commit>]
  session-worktree.sh list
  session-worktree.sh remove <name> [--force]

  create <name>          create <workspace>/.work/wt-<name>
                         <name> is the session name; a leading "wt-" is optional and
                         not doubled — create smoke and create wt-smoke are the same
                         default branch: feat/<name>, based on origin/main
                         (falls back to the trunk's HEAD when origin/main is absent)
  --branch <branch>      use <branch>; created if it does not exist yet,
                         checked out if it does
  --at <commit>          detached HEAD at <commit> — for building or promoting
                         a release from a known commit, never from a moving tree
  list                   name, HEAD, branch, dirty state, for every worktree
  remove <name>          delete the worktree; refuses if it has uncommitted
                         changes unless --force. The branch is kept.

Nothing outside /Users/mitchell.layton/Personal-AI-Sandbox is ever read or written.
EOF
}

# ---------------------------------------------------------------- create

link_deps() {
  # $1 source (trunk), $2 dest (worktree), $3 label, $4 allow_symlink_fallback
  _src="$1"; _dst="$2"; _label="$3"; _fallback="${4:-0}"
  if [ ! -e "$_src" ]; then
    say "  skip  $_label (absent in the trunk)"
    return 0
  fi
  if [ -e "$_dst" ]; then
    die "  $_dst already exists — the worktree is not clean; remove it and retry"
  fi
  if cp -al "$_src" "$_dst" 2>/dev/null; then
    say "  link  $_label (hard links)"
    return 0
  fi
  if [ "$_fallback" = "1" ]; then
    ln -s "$_src" "$_dst"
    say "  link  $_label (symlink — hard links unavailable on this filesystem)"
    return 0
  fi
  die "could not hard-link $_label: yes (cp -al failed). pnpm refuses a symlinked
    node_modules (ERR_PNPM_UNSAFE_MODULES_DIR), so this worktree cannot be used
    as-is. Check that the trunk and $WORK_ROOT are on one filesystem."
}

cmd_create() {
  name="${1:-}"
  [ -n "$name" ] || die "create needs a name: session-worktree.sh create <name>"
  shift
  valid_name "$name" ||
    die "invalid name '$name' — use lowercase letters, digits and '-', 1-32 chars"
  # The directory is always .work/wt-<session>; typing the "wt-" is allowed so
  # that "create wt-smoke" and "create smoke" land on the same path.
  ssn="${name#wt-}"
  valid_name "$ssn" || die "invalid name '$name' — nothing left after the 'wt-' prefix"

  branch=""
  at=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --branch)
        [ "$#" -ge 2 ] || die "--branch needs a value"
        branch="$2"; shift 2 ;;
      --at)
        [ "$#" -ge 2 ] || die "--at needs a value"
        at="$2"; shift 2 ;;
      *) die "unknown option: $1" ;;
    esac
  done

  [ -z "$branch" ] || [ -z "$at" ] || die "--branch and --at are mutually exclusive"

  require_repo
  require_boundary "$WORK_ROOT"
  WT="$WORK_ROOT/wt-$ssn"
  require_boundary "$WT"

  [ ! -e "$WT" ] || die "$WT already exists (use 'list', or 'remove $ssn')"
  ! worktree_registered "$WT" || die "$WT is a registered worktree but missing on disk — run: git -C $REPO_ROOT worktree prune"

  [ -d "$REPO_ROOT/node_modules" ] ||
    die "the trunk has no node_modules — run 'pnpm install' in $REPO_ROOT first"
  [ -d "$REPO_ROOT/.venv" ] ||
    die "the trunk has no .venv — pipeline scripts and 'pnpm verify' need it"

  created_branch=0
  base=""
  if [ -n "$at" ]; then
    base="$(git -C "$REPO_ROOT" rev-parse --verify --quiet "$at^{commit}")" ||
      die "--at $at does not resolve to a commit in this repository"
  else
    if [ -n "$branch" ]; then
      git check-ref-format --branch "$branch" >/dev/null 2>&1 ||
        die "invalid branch name: $branch"
    else
      branch="feat/$ssn"
    fi
    if git -C "$REPO_ROOT" rev-parse --verify --quiet "refs/heads/$branch" >/dev/null; then
      base="$(git -C "$REPO_ROOT" rev-parse --verify "$branch^{commit}")"
      exists="existing branch"
    else
      if git -C "$REPO_ROOT" rev-parse --verify --quiet "refs/remotes/origin/main" >/dev/null; then
        base="$(git -C "$REPO_ROOT" rev-parse --verify "refs/remotes/origin/main^{commit}")"
      else
        base="$(git -C "$REPO_ROOT" rev-parse --verify "HEAD^{commit}")"
      fi
      exists="new branch"
      created_branch=1
    fi
  fi

  mkdir -p "$WORK_ROOT"

  # Roll back a half-built worktree rather than leaving a trap behind.
  cleanup_failed() {
    say "session-worktree: create failed — rolling back"
    [ -d "$WT" ] && git -C "$REPO_ROOT" worktree remove --force "$WT" >/dev/null 2>&1 || true
    if [ "$created_branch" = "1" ] && [ -n "${branch:-}" ]; then
      git -C "$REPO_ROOT" branch -D "$branch" >/dev/null 2>&1 || true
    fi
    rm -f "$WORK_ROOT/wt-$ssn.sh"
  }
  trap cleanup_failed ERR

  say "creating $WT"
  if [ -n "$at" ]; then
    git -C "$REPO_ROOT" worktree add --detach "$WT" "$base" >/dev/null
    say "  head  detached at $(git -C "$WT" rev-parse --short HEAD)"
  elif [ "$created_branch" = "1" ]; then
    git -C "$REPO_ROOT" worktree add -b "$branch" "$WT" "$base" >/dev/null
    say "  head  $branch at $(git -C "$WT" rev-parse --short HEAD)"
  else
    git -C "$REPO_ROOT" worktree add "$WT" "$branch" >/dev/null
    say "  head  $branch (existing) at $(git -C "$WT" rev-parse --short HEAD)"
  fi

  link_deps "$REPO_ROOT/node_modules" "$WT/node_modules" "node_modules" 0
  link_deps "$REPO_ROOT/web/node_modules" "$WT/web/node_modules" "web/node_modules" 0
  link_deps "$REPO_ROOT/.venv" "$WT/.venv" ".venv" 1

  trap - ERR

  # A sourceable snippet, kept OUTSIDE the worktree so the tree stays clean for
  # `git status` and for the "deploy from a clean worktree" rule.
  ENV_SNIPPET="$WORK_ROOT/wt-$ssn.sh"
  cat >"$ENV_SNIPPET" <<EOF
# generated by scripts/session-worktree.sh for session "$name" — paths only, no secrets
export UNPACKFUND_ENV_FILE="$WORKSPACE/.env"
export HOME="$WORK_ROOT/home"
export npm_config_cache="$WORK_ROOT/npm-cache"
export PATH="$REPO_ROOT/.local/bin:\$PATH"
cd "$WT"
EOF
  chmod 600 "$ENV_SNIPPET"

  cat <<EOF

worktree ready: $WT

next commands (copy them as a block):
  cd $WT
  export UNPACKFUND_ENV_FILE=$WORKSPACE/.env
  export HOME=$WORK_ROOT/home
  export npm_config_cache=$WORK_ROOT/npm-cache
  export PATH=$REPO_ROOT/.local/bin:\$PATH    # pnpm shim: git-ignored, only in the trunk
  pnpm verify

or, equivalently:  . $ENV_SNIPPET

notes
  * .env was NOT copied. UNPACKFUND_ENV_FILE is how the pipeline finds the one
    workspace copy (pipeline/pipeline/paths.py). Do not copy it into $WT.
  * HOME and npm_config_cache live under $WORK_ROOT because the sandbox blocks
    ~/Library/Preferences; wrangler and corepack both need them writable.
  * Never run 'pnpm install' here: it would rebuild node_modules from an empty
    .pnpm-store and detach it from the trunk. Add dependencies in the trunk.
  * Read published release bundles from the trunk by absolute path, e.g.
      pnpm pages:funds --release $REPO_ROOT/artifacts/universe-c/releases/<id>
  * Removing it later: session-worktree.sh remove $ssn
EOF
}

# ---------------------------------------------------------------- list

cmd_list() {
  require_repo
  printf '%-20s %-9s %-26s %s\n' "NAME" "HEAD" "BRANCH" "STATE"
  git -C "$REPO_ROOT" worktree list --porcelain | {
    cur_path=""; cur_head=""; cur_ref=""; cur_detached=0
    flush() {
      [ -n "$cur_path" ] || return 0
      if [ "$cur_path" = "$REPO_ROOT" ]; then
        cur_name="(trunk)"
      else
        cur_name="${cur_path##*/}"
      fi
      cur_head="$(printf '%s' "$cur_head" | cut -c1-8)"
      if [ "$cur_detached" = "1" ]; then
        cur_branch="(detached)"
      else
        cur_branch="${cur_ref#refs/heads/}"
      fi
      if [ -d "$cur_path" ]; then
        n="$(git -C "$cur_path" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
        if [ "${n:-0}" = "0" ]; then cur_state="clean"; else cur_state="$n uncommitted"; fi
      else
        cur_state="missing on disk (prune)"
      fi
      printf '%-20s %-9s %-26s %s\n' "$cur_name" "$cur_head" "$cur_branch" "$cur_state"
    }
    while IFS= read -r line; do
      case "$line" in
        "worktree "*) flush; cur_path="${line#worktree }"; cur_head=""; cur_ref=""; cur_detached=0 ;;
        "HEAD "*) cur_head="${line#HEAD }" ;;
        "branch "*) cur_ref="${line#branch }" ;;
        "detached") cur_detached=1 ;;
      esac
    done
    flush
  }
  say ""
  say "worktrees live in $WORK_ROOT; the trunk clone at $REPO_ROOT is canonical."
}

# ---------------------------------------------------------------- remove

cmd_remove() {
  name="${1:-}"
  [ -n "$name" ] || die "remove needs a name: session-worktree.sh remove <name>"
  shift
  force=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --force) force=1; shift ;;
      *) die "unknown option: $1" ;;
    esac
  done

  require_repo
  require_boundary "$WORK_ROOT"
  ssn="${name#wt-}"

  WT=""
  for candidate in "$WORK_ROOT/wt-$ssn" "$WORK_ROOT/$name"; do
    require_boundary "$candidate"
    if worktree_registered "$candidate"; then WT="$candidate"; break; fi
  done
  [ -n "$WT" ] || die "no registered worktree for '$name' (looked for $WORK_ROOT/wt-$ssn) — see 'list'"

  # Three belts: never the trunk, never outside the workspace, never '/' etc.
  [ "$WT" != "$REPO_ROOT" ] || die "refusing to remove the trunk clone"
  require_boundary "$WT"
  case "$WT" in
    "$WORK_ROOT"/*) : ;;
    *) die "refusing: $WT is not under $WORK_ROOT" ;;
  esac

  wt_branch=""
  if [ -d "$WT" ]; then
    wt_branch="$(git -C "$WT" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
    n="$(git -C "$WT" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
    if [ "${n:-0}" != "0" ] && [ "$force" -ne 1 ]; then
      say "refusing: $WT has $n uncommitted change(s):" >&2
      git -C "$WT" status --short >&2 || true
      die "commit and push the work first, or pass --force to discard it"
    fi
    git -C "$REPO_ROOT" worktree remove --force "$WT" >/dev/null ||
      die "git worktree remove failed for $WT"
  else
    say "  $WT was already gone; pruning the registration"
  fi

  git -C "$REPO_ROOT" worktree prune >/dev/null 2>&1 || true
  for candidate in "$WORK_ROOT/wt-$ssn.sh" "$WORK_ROOT/$name.sh"; do
    require_boundary "$candidate"
    rm -f "$candidate"
  done

  say "removed $WT"
  if [ -n "$wt_branch" ] && [ "$wt_branch" != "HEAD" ]; then
    say "branch $wt_branch was kept — it is the session's record of work, not the directory"
  else
    say "it was a detached HEAD, so no branch was involved"
  fi
}

# ---------------------------------------------------------------- main

case "${1:-}" in
  create) shift; cmd_create "$@" ;;
  list) shift; cmd_list "$@" ;;
  remove) shift; cmd_remove "$@" ;;
  "" | -h | --help | help) usage ;;
  *) usage >&2; die "unknown command: $1" ;;
esac
