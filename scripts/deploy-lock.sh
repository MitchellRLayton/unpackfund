#!/usr/bin/env bash
# deploy-lock.sh — one deploy at a time across concurrent agent sessions.
#
# Why this exists: two sessions deploying at once is last-writer-wins on the live
# site. In one afternoon the live Worker was deployed twice and the production
# release pointer moved once, from a checkout another session was also writing to.
# Deploys have to be serialized by a record both sessions can see.
#
# The lock is a file: <workspace>/.work/deploy.lock — one JSON line.
# It is ADVISORY. A session that ignores it can still run `npx wrangler deploy`.
# The point is that ignoring it becomes a deliberate act: acquire, or break with a
# reason, or you are running an undocumented production change.
#
# Covers (must hold the lock): pnpm deploy:prod, pipeline.release promote
# --allow-live, npx wrangler rollback, wrangler versions/deployments writes.
# Does not cover: preview deploys (`deploy:preview`, the unpackfund-preview
# Worker), which move no live traffic.
#
# Usage:
#   deploy-lock.sh acquire --session <name> [--ttl <minutes>] [--target prod|preview]
#   deploy-lock.sh status
#   deploy-lock.sh release --session <name>
#   deploy-lock.sh break   --session <name> --reason "<why>" [--force]
#
# Exit codes: 0 ok · 2 held by another session · 3 held by this session ·
#             4 stale lock in the way · 5 you are not the holder · 6 no lock held
#
# Playbook: docs/08-operations/2026-10-30-multi-session-playbook.md

set -euo pipefail

BOUNDARY="/Users/mitchell.layton/Personal-AI-Sandbox"

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# The lock must be the same file for every session, and sessions run in
# worktrees of this same repository (.work/wt-*). Resolving the root from the
# script's own location therefore finds the *worktree* when run from one, which
# wrote .work/.work/deploy.lock -- a second lock no trunk session could see, on
# exactly the worktree-plus-lock combination the playbook recommends. Ask git for
# the shared git directory instead: it is per-repository, not per-worktree.
_common="$(git -C "$SCRIPT_DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
if [ -n "$_common" ]; then
  REPO_ROOT="$(cd -P "$(dirname "$_common")" && pwd -P)"
else
  REPO_ROOT="$(cd -P "$SCRIPT_DIR/.." && pwd -P)"
fi
WORKSPACE="$(cd -P "$REPO_ROOT/.." && pwd -P)"
WORK_ROOT="$WORKSPACE/.work"
LOCK="$WORK_ROOT/deploy.lock"

DEFAULT_TTL_MIN=45
MIN_TTL_MIN=5
MAX_TTL_MIN=240

die() { printf 'deploy-lock: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }

inside_boundary() {
  case "$1" in "$BOUNDARY"/*) return 0 ;; *) return 1 ;; esac
}
require_boundary() {
  inside_boundary "$1" || die "refusing to touch $1 — outside the workspace boundary $BOUNDARY"
}

now_epoch() { date -u +%s; }
stamp() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

# Read one field out of the lock's single JSON line. No jq: only what we wrote.
field() { # $1 key
  tr -d '\n' <"$LOCK" 2>/dev/null |
    grep -o "\"$1\":\(\"[^\"]*\"\|[0-9]*\)" | head -1 |
    cut -d: -f2- | tr -d '"' || true
}

json_escape_check() { # $1 value, $2 label — we write hand-rolled JSON
  case "$1" in
    *'"'* | *'\'*) die "$2 must not contain a double quote or a backslash" ;;
  esac
}

lock_age() {
  started="$(field started_epoch)"
  ttl="$(field ttl_seconds)"
  [ -n "$started" ] && [ -n "$ttl" ] || { say "--"; return 0; }
  say "$(($(now_epoch) - started))s of ${ttl}s"
}

is_stale() {
  started="$(field started_epoch)"
  ttl="$(field ttl_seconds)"
  [ -n "$started" ] && [ -n "$ttl" ] || return 0 # unreadable lock = treat as stale
  [ "$(($(now_epoch) - started))" -gt "$ttl" ]
}

print_holder() {
  _session="$(field session)"
  _target="$(field target)"
  _where="$(field worktree)"
  _line="held by:  $_session ($_target)"
  [ -z "$_where" ] || _line="$_line in $_where"
  say "$_line"
  say "branch:   $(field branch) @ $(field commit)"
  say "started:  $(field started_at) — age $(lock_age), pid $(field pid)"
  if [ -n "$(field reason)" ]; then say "note:     $(field reason)"; fi
  return 0
}

# Everything about the caller we can observe instead of asking for it.
here_branch="unknown"
here_commit="unknown"
here_worktree="$PWD"
here_dirty=0
observe_caller() {
  if git -C "$PWD" rev-parse --git-dir >/dev/null 2>&1; then
    here_worktree="$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$PWD")"
    here_commit="$(git -C "$PWD" rev-parse --short HEAD 2>/dev/null || printf 'unknown')"
    here_branch="$(git -C "$PWD" rev-parse --abbrev-ref HEAD 2>/dev/null || printf 'unknown')"
    here_dirty="$(git -C "$PWD" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
  fi
  return 0
}

usage() {
  cat <<'EOF'
deploy-lock.sh — one deploy at a time across concurrent agent sessions

Usage:
  deploy-lock.sh acquire --session <name> [--ttl <minutes>] [--target prod|preview]
  deploy-lock.sh status
  deploy-lock.sh release --session <name>
  deploy-lock.sh break   --session <name> --reason "<why>" [--force]

  acquire   take the lock; refuses if another session holds a fresh one
  status    who holds it, how old, whether it is stale, whether the pid is alive
  release   give it back; only the holder may (--session must match)
  break     clear a stale lock; needs a reason and is recorded in a sibling file.
            Breaking a FRESH lock needs --force as well: that is a live deploy.

Covers: pnpm deploy:prod · pnpm release:promote --allow-live · wrangler rollback
Not covered: preview deploys to the unpackfund-preview Worker.
The lock is advisory — it stops accidents, not a session that decides to ignore it.
EOF
}

cmd_acquire() {
  session=""
  ttl_min="$DEFAULT_TTL_MIN"
  target="prod"
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --session) [ "$#" -ge 2 ] || die "--session needs a value"; session="$2"; shift 2 ;;
      --ttl) [ "$#" -ge 2 ] || die "--ttl needs a value"; ttl_min="$2"; shift 2 ;;
      --target) [ "$#" -ge 2 ] || die "--target needs a value"; target="$2"; shift 2 ;;
      *) die "unknown option: $1" ;;
    esac
  done
  [ -n "$session" ] || die "acquire needs --session <name>"
  json_escape_check "$session" "--session"
  case "$target" in prod | preview) : ;; *) die "--target must be 'prod' or 'preview'" ;; esac
  case "$ttl_min" in '' | *[!0-9]*) die "--ttl must be a whole number of minutes" ;; esac
  [ "$ttl_min" -ge "$MIN_TTL_MIN" ] || die "--ttl must be at least $MIN_TTL_MIN minutes"
  [ "$ttl_min" -le "$MAX_TTL_MIN" ] || die "--ttl must be at most $MAX_TTL_MIN minutes"

  require_boundary "$WORK_ROOT"
  mkdir -p "$WORK_ROOT"

  if [ -e "$LOCK" ]; then
    holder="$(field session)"
    if is_stale; then
      say "deploy-lock: a STALE lock is in the way:" >&2
      print_holder >&2
      say "deploy-lock: clear it deliberately: scripts/deploy-lock.sh break --session $session --reason \"<why>\"" >&2
      exit 4
    fi
    if [ "$holder" = "$session" ]; then
      say "deploy-lock: already held by this session ($session)" >&2
      print_holder >&2
      exit 3
    fi
    say "deploy-lock: held by another session:" >&2
    print_holder >&2
    say "deploy-lock: do not deploy. Wait, or coordinate with whoever owns '$holder'." >&2
    exit 2
  fi

  observe_caller
  tmp="$LOCK.tmp.$$"
  printf '{"session":"%s","target":"%s","branch":"%s","commit":"%s","pid":%s,"started_at":"%s","started_epoch":%s,"ttl_seconds":%s,"worktree":"%s"}\n' \
    "$session" "$target" "$here_branch" "$here_commit" "$$" "$(stamp)" "$(now_epoch)" \
    "$((ttl_min * 60))" "$here_worktree" >"$tmp"

  # ln is atomic and fails if the target exists: no window where two sessions win.
  if ! ln "$tmp" "$LOCK" 2>/dev/null; then
    rm -f "$tmp"
    say "deploy-lock: lost the race to another session:" >&2
    print_holder >&2
    exit 2
  fi
  rm -f "$tmp"

  say "lock acquired: $LOCK"
  print_holder
  [ "$ttl_min" -eq "$DEFAULT_TTL_MIN" ] ||
    say "ttl:      ${ttl_min}m (renew by releasing and re-acquiring)"

  warnings=""
  if [ "$here_dirty" != "0" ]; then
    warnings="${warnings}WARNING: $here_dirty uncommitted change(s) in $here_worktree.
         Deploy from a CLEAN worktree at a known commit (playbook section 6).
"
  fi
  if [ "$here_worktree" = "$REPO_ROOT" ]; then
    warnings="${warnings}WARNING: you are in the trunk clone, not a session worktree.
         The trunk is other sessions' shared working tree (playbook section 2).
"
  fi
  if [ -n "$warnings" ]; then
    say ""
    printf '%s' "$warnings" >&2
  fi
  say ""
  say "release it when the deploy and its verification are done:"
  say "  scripts/deploy-lock.sh release --session $session"
}

cmd_status() {
  if [ ! -e "$LOCK" ]; then
    say "deploy lock: FREE ($LOCK does not exist)"
    exit 6
  fi
  say "deploy lock: HELD  $LOCK"
  print_holder
  pid="$(field pid)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    say "pid:      $pid still running — but an agent's shells are short-lived, so this"
    say "          proves nothing either way. The TTL is the authority."
  else
    say "pid:      $pid not running — usually just means the shell that took the lock"
    say "          has exited. Do not break a fresh lock because of this; the TTL decides."
  fi
  if is_stale; then
    say "state:    STALE — older than its ttl. Clear it with 'break --reason ...'"
  else
    say "state:    fresh"
  fi
  say ""
  say "raw: $(tr -d '\n' <"$LOCK")"
}

cmd_release() {
  session=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --session) [ "$#" -ge 2 ] || die "--session needs a value"; session="$2"; shift 2 ;;
      *) die "unknown option: $1" ;;
    esac
  done
  [ -n "$session" ] || die "release needs --session <name>"
  require_boundary "$LOCK"
  [ -e "$LOCK" ] || { say "deploy-lock: no lock to release"; exit 6; }
  holder="$(field session)"
  if [ "$holder" != "$session" ]; then
    say "deploy-lock: refusing — the lock is held by '$holder', not '$session'" >&2
    print_holder >&2
    exit 5
  fi
  rm -f "$LOCK"
  say "deploy lock released by $session"
}

cmd_break() {
  session=""
  reason=""
  force=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --session) [ "$#" -ge 2 ] || die "--session needs a value"; session="$2"; shift 2 ;;
      --reason) [ "$#" -ge 2 ] || die "--reason needs a value"; reason="$2"; shift 2 ;;
      --force) force=1; shift ;;
      *) die "unknown option: $1" ;;
    esac
  done
  [ -n "$session" ] || die "break needs --session <name>"
  [ -n "$reason" ] || die "break needs --reason \"<why>\" — an unexplained break is how two live deploys happen"
  json_escape_check "$session" "--session"
  json_escape_check "$reason" "--reason"
  require_boundary "$LOCK"
  [ -e "$LOCK" ] || { say "deploy-lock: no lock to break"; exit 6; }
  if ! is_stale && [ "$force" -ne 1 ]; then
    say "deploy-lock: that lock is FRESH — a session may be mid-deploy right now:" >&2
    print_holder >&2
    die "if you are certain it is dead, re-run with --force and the reason"
  fi
  body="$(tr -d '\n' <"$LOCK")"
  body="${body%\}}"
  broken="$LOCK.broken-$(now_epoch)"
  printf '%s,"broken_by":"%s","broken_at":"%s","break_reason":"%s"}\n' \
    "$body" "$session" "$(stamp)" "$reason" >"$broken"
  rm -f "$LOCK"
  say "deploy lock broken by $session"
  say "reason recorded in $broken"
  say "acquire it yourself before you deploy: deploy-lock.sh acquire --session $session"
}

case "${1:-}" in
  acquire) shift; cmd_acquire "$@" ;;
  status) shift; cmd_status "$@" ;;
  release) shift; cmd_release "$@" ;;
  break) shift; cmd_break "$@" ;;
  "" | -h | --help | help) usage ;;
  *) usage >&2; die "unknown command: $1" ;;
esac
