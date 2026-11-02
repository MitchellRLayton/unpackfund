#!/usr/bin/env bash
# session-provenance.sh — who made this commit, in which workspace, and did it reach production?
#
# Why this exists: several DeepSeek Harness sessions run at once, each in its own
# worktree (scripts/session-worktree.sh). Git records the author and the date; it does
# not record which *session* a commit came from, which worktree it was written in, or
# whether the branch it sits on has been merged and deployed. On 2026-11-01 the repo had
# eight worktrees, five branches, and zero PRs, and no commit in the history named a
# session — so "who changed this, and where from?" was unanswerable from git alone.
#
# This script makes that answerable, and makes it cheap enough to actually happen:
#
#   whoami    what identity this worktree resolves to, and the trailer block it would add
#   register  record a session (name, worktree, branch, agent, task) under .work/sessions/
#   commit    git commit, with the provenance trailers appended for you
#   check     verify commits carry the trailers; the same check the hooks enforce
#   log       the history with Session / Worktree columns
#   board     every branch: owner session, worktree, ahead/behind main, PR, dirty state
#   blame     who (which session) last touched a file, grouped by session
#   pr        open a pull request whose body carries the provenance and the deploy impact
#
# The trailers are the durable record: they live in the commit, travel with the clone,
# and are readable by `git log` without this script. The .work/sessions/ registry is the
# live, local record (agent label, task, start time) that git does not hold.
#
# Model: docs/08-operations/2026-11-01-cross-session-provenance.md
# Rules: unpackfund/AGENTS.md ("Commit provenance"), workspace AGENTS.md ("Git")
#
# Nothing outside /Users/mitchell.layton/Personal-AI-Sandbox is ever read or written.

set -euo pipefail

BOUNDARY="/Users/mitchell.layton/Personal-AI-Sandbox"

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# The repo root is derived from the *common* git dir, not from this script's location:
# in a linked worktree the script lives at .work/wt-<name>/scripts/, whose parent is
# not the workspace. `--git-common-dir` points at the trunk's .git from every worktree.
COMMON_DIR="$(git -C "$SCRIPT_DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
[ -n "$COMMON_DIR" ] || { printf 'session-provenance: %s is not inside a git repository\n' "$SCRIPT_DIR" >&2; exit 1; }
REPO_ROOT="$(cd -P "$(dirname "$COMMON_DIR")" && pwd -P)"
WORKSPACE="$(cd -P "$REPO_ROOT/.." && pwd -P)"
[ "$WORKSPACE" = "$BOUNDARY" ] ||
  { printf 'session-provenance: repo %s is not inside the workspace boundary %s\n' "$REPO_ROOT" "$BOUNDARY" >&2; exit 1; }
WORK_ROOT="$WORKSPACE/.work"
SESSIONS_DIR="$WORK_ROOT/sessions"
TMP_DIR="$WORK_ROOT/tmp"
US="$(printf '\037')"   # field separator for parsed git output; not IFS whitespace

# The deploy trigger, copied from .github/workflows/deploy-site.yml `on.push.paths`.
# A merge to main that matches this list publishes unpackfund.com. Keep the two in step:
# `check` prints a warning when they disagree.
DEPLOY_PATHS='^(web/|pipeline/)|^package\.json$|^pnpm-lock\.yaml$|^pnpm-workspace\.yaml$|^\.nvmrc$|^wrangler\.prod\.jsonc$|^\.github/workflows/deploy-site\.yml$'

# Trailer keys this project requires. `Agent` predates the rest (2026-10-28) and is kept
# so older tooling keeps working.
REQUIRED_TRAILERS="Session Worktree Agent"

# Commits authored before this instant are exempt from the pre-push check, so work that
# was already in flight when the rule landed is not retroactively blocked. The commit-msg
# hook has no such exemption: every new commit carries the trailers.
PROVENANCE_SINCE="2026-11-02T00:00:00Z"

die() { printf 'session-provenance: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }
warn() { printf 'session-provenance: warning: %s\n' "$*" >&2; }

inside_boundary() {
  case "$1" in
    "$BOUNDARY"/*) return 0 ;;
    *) return 1 ;;
  esac
}

require_boundary() {
  inside_boundary "$1" || die "refusing to touch $1 — outside the workspace boundary $BOUNDARY"
}

now_iso() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

require_repo() {
  git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1 || die "not a git repository: $REPO_ROOT"
}

# Absolute path of the worktree this command is running in (not necessarily the trunk).
toplevel() { git rev-parse --show-toplevel 2>/dev/null || die "not inside a git worktree"; }

# Relative form used in the Worktree trailer: "unpackfund" or ".work/wt-<name>".
worktree_rel() {
  _top="$(toplevel)"
  case "$_top" in
    "$WORKSPACE"/*) printf '%s' "${_top#"$WORKSPACE"/}" ;;
    *) die "worktree $_top is outside $WORKSPACE" ;;
  esac
}

valid_session_name() {
  case "$1" in
    "" | *[!a-z0-9-]*) return 1 ;;
    [!a-z0-9]*) return 1 ;;
  esac
  [ "${#1}" -le 32 ]
}

# ------------------------------------------------------------------ registry

session_file() { printf '%s/%s.conf' "$SESSIONS_DIR" "$1"; }

# Read one KEY=value line from a session file without sourcing it (no eval: a value
# containing $( ) must never run).
conf_get() {
  _file="$1" _key="$2"
  [ -f "$_file" ] || return 0
  sed -n "s/^${_key}=//p" "$_file" | head -1 |
    sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

conf_write() {
  _file="$1" _name="$2" _wt="$3" _branch="$4" _agent="$5" _task="$6" _status="$7"
  require_boundary "$SESSIONS_DIR"
  mkdir -p "$SESSIONS_DIR"
  {
    printf '# session provenance record — generated by scripts/session-provenance.sh\n'
    printf 'SESSION_NAME="%s"\n' "$_name"
    printf 'SESSION_WORKTREE="%s"\n' "$_wt"
    printf 'SESSION_BRANCH="%s"\n' "$_branch"
    printf 'SESSION_AGENT="%s"\n' "$_agent"
    printf 'SESSION_TASK="%s"\n' "$_task"
    printf 'SESSION_STATUS="%s"\n' "$_status"
    printf 'SESSION_UPDATED="%s"\n' "$(now_iso)"
  } >"$_file"
}

# The session registered for a given worktree path, if any.
session_for_worktree() {
  _want="$1"
  [ -d "$SESSIONS_DIR" ] || return 0
  for _f in "$SESSIONS_DIR"/*.conf; do
    [ -f "$_f" ] || continue
    [ "$(conf_get "$_f" SESSION_WORKTREE)" = "$_want" ] || continue
    [ "$(conf_get "$_f" SESSION_STATUS)" = "ended" ] && continue
    conf_get "$_f" SESSION_NAME
    return 0
  done
  return 0
}

# The branch a session says it owns (used by `board` when the worktree is gone).
session_for_branch() {
  _want="$1"
  [ -d "$SESSIONS_DIR" ] || return 0
  for _f in "$SESSIONS_DIR"/*.conf; do
    [ -f "$_f" ] || continue
    [ "$(conf_get "$_f" SESSION_BRANCH)" = "$_want" ] || continue
    conf_get "$_f" SESSION_NAME
    return 0
  done
  return 0
}

# ------------------------------------------------------------------ identity

# Sets: ID_SESSION ID_WORKTREE ID_BRANCH ID_AGENT ID_TASK
# Flags already parsed into OPT_SESSION / OPT_AGENT by the caller.
identity_resolve() {
  _top="$(toplevel)"
  _rel="$(worktree_rel)"
  ID_BRANCH="$(git -C "$_top" rev-parse --abbrev-ref HEAD 2>/dev/null || printf 'HEAD')"

  _explicit="${OPT_SESSION:-${PROVENANCE_SESSION:-}}"
  _reg="$(session_for_worktree "$_top")"

  if [ -n "$_explicit" ]; then
    valid_session_name "$_explicit" || die "invalid session name '$_explicit' (lowercase letters, digits, '-')"
    _f="$(session_file "$_explicit")"
    if [ -f "$_f" ]; then
      _regwt="$(conf_get "$_f" SESSION_WORKTREE)"
      if [ -n "$_regwt" ] && [ "$_regwt" != "$_top" ] && [ "${OPT_FORCE_IDENTITY:-0}" != "1" ]; then
        die "session '$_explicit' is registered to $_regwt, not $_top.
    Refusing to attribute this commit to another session's worktree.
    Use --force-identity only if the registry is stale (e.g. a worktree was moved)."
      fi
    fi
    ID_SESSION="$_explicit"
    ID_AGENT="${OPT_AGENT:-$(conf_get "$(session_file "$_explicit")" SESSION_AGENT)}"
    ID_TASK="$(conf_get "$(session_file "$_explicit")" SESSION_TASK)"
  elif [ -n "$_reg" ]; then
    ID_SESSION="$_reg"
    _f="$(session_file "$_reg")"
    ID_AGENT="${OPT_AGENT:-$(conf_get "$_f" SESSION_AGENT)}"
    ID_TASK="$(conf_get "$_f" SESSION_TASK)"
  else
    # A worktree made by hand (not via session-worktree.sh) is still attributable:
    # the directory name is the session name. The trunk is not a session.
    case "${_top##*/}" in
      wt-*)
        ID_SESSION="${_top##*/wt-}"
        valid_session_name "$ID_SESSION" ||
          die "cannot derive a session name from worktree '${_top##*/}' — run: session-provenance.sh register --session <name>"
        ID_AGENT="${OPT_AGENT:-}"
        ID_TASK=""
        warn "worktree $ID_SESSION is not registered; using the directory name. Run 'session-provenance.sh register --agent <label>' to record the agent and task."
        ;;
      *)
        die "the trunk ($_rel) is not a session. Pass --session <name> (registered ones: $(registered_names | tr '\n' ' ')) or work in a .work/wt-<name> worktree."
        ;;
    esac
  fi

  [ -n "${ID_AGENT:-}" ] || ID_AGENT="DSH agent"
  ID_WORKTREE="$_rel"
}

registered_names() {
  [ -d "$SESSIONS_DIR" ] || return 0
  for _f in "$SESSIONS_DIR"/*.conf; do
    [ -f "$_f" ] || continue
    conf_get "$_f" SESSION_NAME
  done
}

trailer_block() {
  printf 'Session: %s\n' "$ID_SESSION"
  printf 'Worktree: %s\n' "$ID_WORKTREE"
  printf 'Agent: %s\n' "$ID_AGENT"
  [ -z "${ID_TASK:-}" ] || printf 'Task: %s\n' "$ID_TASK"
}

# ------------------------------------------------------------------ commands

cmd_register() {
  # The session name may be positional (`register alpha`) or a flag (`--session alpha`).
  _session=""
  if [ "$#" -gt 0 ]; then
    case "$1" in
      -*) : ;;
      *) _session="$1"; shift ;;
    esac
  fi
  _wt=""; _branch=""; _agent=""; _task=""; _status="active"
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --session) [ "$#" -ge 2 ] || die "--session needs a value"; _session="$2"; shift 2 ;;
      --worktree) [ "$#" -ge 2 ] || die "--worktree needs a value"; _wt="$2"; shift 2 ;;
      --branch) [ "$#" -ge 2 ] || die "--branch needs a value"; _branch="$2"; shift 2 ;;
      --agent) [ "$#" -ge 2 ] || die "--agent needs a value"; _agent="$2"; shift 2 ;;
      --task) [ "$#" -ge 2 ] || die "--task needs a value"; _task="$2"; shift 2 ;;
      --end) _status="ended"; shift ;;
      *) die "unknown option for register: $1" ;;
    esac
  done

  if [ -z "$_session" ]; then
    _top="$(toplevel)"
    case "${_top##*/}" in
      wt-*) _session="${_top##*/wt-}" ;;
      *) die "register needs --session <name> (the trunk is not a session)" ;;
    esac
  fi
  valid_session_name "$_session" || die "invalid session name '$_session' (lowercase letters, digits, '-')"

  _top="$(toplevel)"
  [ -n "$_wt" ] || _wt="$_top"
  # Accept both an absolute worktree path and the short name.
  case "$_wt" in
    /*) : ;;
    *) _wt="$WORK_ROOT/wt-${_wt#wt-}" ;;
  esac
  require_boundary "$_wt"
  [ -d "$_wt" ] || die "worktree does not exist: $_wt"
  [ -n "$_branch" ] || _branch="$(git -C "$_wt" rev-parse --abbrev-ref HEAD 2>/dev/null || printf 'HEAD')"
  [ -n "$_agent" ] || _agent="$(conf_get "$(session_file "$_session")" SESSION_AGENT)"
  [ -n "$_agent" ] || _agent="DSH agent"
  [ -n "$_task" ] || _task="$(conf_get "$(session_file "$_session")" SESSION_TASK)"

  _existing="$(session_for_worktree "$_wt")"
  if [ -n "$_existing" ] && [ "$_existing" != "$_session" ]; then
    die "worktree $_wt is already registered to session '$_existing'. One worktree, one session."
  fi

  conf_write "$(session_file "$_session")" "$_session" "$_wt" "$_branch" "$_agent" "$_task" "$_status"
  say "registered session '$_session'"
  say "  worktree  ${_wt#"$WORKSPACE"/}"
  say "  branch    $_branch"
  say "  agent     $_agent"
  [ -z "$_task" ] || say "  task      $_task"
  say "  record    ${SESSIONS_DIR#"$WORKSPACE"/}/$_session.conf"
}

cmd_whoami() {
  identity_resolve
  _top="$(toplevel)"
  say "session   $ID_SESSION"
  say "worktree  $ID_WORKTREE"
  say "branch    $ID_BRANCH"
  say "agent     $ID_AGENT"
  [ -z "${ID_TASK:-}" ] || say "task      $ID_TASK"
  say "head      $(git -C "$_top" rev-parse --short HEAD) $(git -C "$_top" log -1 --format='%s')"
  say ""
  say "trailers added by 'session-provenance.sh commit':"
  trailer_block | sed 's/^/  /'
}

cmd_commit() {
  OPT_SESSION=""; OPT_AGENT=""; OPT_TASK=""
  _subject=""; _body=""
  _pass=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -m|--message)
        [ "$#" -ge 2 ] || die "$1 needs a value"
        if [ -z "$_subject" ]; then _subject="$2"; else _body="$_body${_body:+

}$2"; fi
        shift 2 ;;
      --session) [ "$#" -ge 2 ] || die "--session needs a value"; OPT_SESSION="$2"; shift 2 ;;
      --agent) [ "$#" -ge 2 ] || die "--agent needs a value"; OPT_AGENT="$2"; shift 2 ;;
      --task) [ "$#" -ge 2 ] || die "--task needs a value"; OPT_TASK="$2"; shift 2 ;;
      --no-verify)
        die "--no-verify is forbidden: the hooks are the record (AGENTS.md, Hard rules)." ;;
      -h|--help) usage; return 0 ;;
      *) _pass[${#_pass[@]}]="$1"; shift ;;
    esac
  done

  [ -n "$_subject" ] || die "commit needs -m '<subject>'"
  identity_resolve
  [ -z "${OPT_TASK:-}" ] || ID_TASK="$OPT_TASK"
  _top="$(toplevel)"

  # Refuse to commit onto the trunk's main without saying so: main is public history.
  _branch="$(git -C "$_top" rev-parse --abbrev-ref HEAD 2>/dev/null || printf 'HEAD')"
  if [ "$_branch" = "main" ] && [ "$ID_WORKTREE" = "unpackfund" ]; then
    warn "committing directly to main from the trunk — the trunk is meant to stay clean (multi-session playbook §3)"
  fi

  mkdir -p "$TMP_DIR"
  require_boundary "$TMP_DIR"
  _msg="$TMP_DIR/commit-msg.$$"
  trap 'rm -f "$_msg"' EXIT
  {
    printf '%s\n' "$_subject"
    if [ -n "$_body" ]; then
      printf '\n%s\n' "$_body"
    fi
    printf '\n'
    trailer_block
  } >"$_msg"

  # ${_pass[@]+...} because bash 3.2 (macOS) treats an empty array as unset under `set -u`.
  if ! git -C "$_top" commit -F "$_msg" ${_pass[@]+"${_pass[@]}"}; then
    die "git commit failed (see the message above)"
  fi
  say ""
  say "committed $(git -C "$_top" rev-parse --short HEAD) as session '$ID_SESSION' in $ID_WORKTREE"
}

cmd_check() {
  GIT_ROOT="$(toplevel)"
  _range=""; _quiet=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --range) [ "$#" -ge 2 ] || die "--range needs a value"; _range="$2"; shift 2 ;;
      --quiet) _quiet=1; shift ;;
      *) die "unknown option for check: $1" ;;
    esac
  done
  require_repo
  if [ -z "$_range" ]; then
    if git -C "$GIT_ROOT" rev-parse --verify --quiet origin/main >/dev/null; then
      _range="origin/main..HEAD"
    else
      _range="HEAD"
    fi
  fi

  _bad=0; _n=0; _ok=0; _skipped=0
  _rows=""
  for _c in $(git -C "$GIT_ROOT" rev-list --reverse "$_range" 2>/dev/null); do
    _n=$((_n + 1))
    _subj="$(git -C "$GIT_ROOT" log -1 --format='%s' "$_c")"
    case "$_subj" in
      "Merge "*) _skipped=$((_skipped + 1)); continue ;;
    esac
    _missing=""
    for _k in $REQUIRED_TRAILERS; do
      _v="$(git -C "$GIT_ROOT" log -1 --format="%(trailers:key=$_k,valueonly,separator=,)" "$_c")"
      [ -n "$_v" ] || _missing="$_missing $_k"
    done
    _sha="$(git -C "$GIT_ROOT" log -1 --format='%h' "$_c")"
    if [ -n "$_missing" ]; then
      _bad=$((_bad + 1))
      _rows="$_rows${_sha}${US}${_subj}${US}missing:${_missing}
"
    else
      _ok=$((_ok + 1))
      _rows="$_rows${_sha}${US}${_subj}${US}ok
"
    fi
  done

  if [ "$_quiet" -eq 0 ]; then
    say "range: $_range"
    printf '%s' "$_rows" | while IFS="$US" read -r _sha _subj _state; do
      [ -n "${_sha:-}" ] || continue
      printf '  %-9s %-12s %s\n' "$_sha" "$_state" "$_subj"
    done
    say ""
    say "$_n commit(s): $_ok with provenance, $_bad without, $_skipped merge commit(s) skipped"
  else
    [ "$_bad" -eq 0 ] || printf '%s' "$_rows" | grep 'missing:' >&2 || true
  fi

  # The deploy-path list here and in the workflow are two copies of one rule. Drift means
  # a path that publishes production is not counted as one by `check` and `pr`.
  _wf="$REPO_ROOT/.github/workflows/deploy-site.yml"
  if [ -f "$_wf" ]; then
    _wfpaths="$(sed -n '/^  push:/,/^  [a-z_]*:$/p' "$_wf" | grep -E '^[[:space:]]+- "' | sed -e 's/^[[:space:]]*-[[:space:]]*//' -e 's/"//g')"
    if [ -z "$_wfpaths" ]; then
      warn "could not read the deploy paths from .github/workflows/deploy-site.yml"
    else
      set -f
      for _p in $_wfpaths; do
        printf '%s' "$_p" | grep -Eq "$DEPLOY_PATHS" ||
          warn "deploy path '$_p' in deploy-site.yml is not matched by DEPLOY_PATHS in this script — update both"
      done
      set +f
    fi
  fi

  [ "$_bad" -eq 0 ] || exit 1
}

cmd_log() {
  GIT_ROOT="$(toplevel)"
  _count=20; _since=""; _branch=""; _all=""; _wide=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --count|-n) [ "$#" -ge 2 ] || die "--count needs a value"; _count="$2"; shift 2 ;;
      --since) [ "$#" -ge 2 ] || die "--since needs a value"; _since="$2"; shift 2 ;;
      --branch) [ "$#" -ge 2 ] || die "--branch needs a value"; _branch="$2"; shift 2 ;;
      --all) _all="--all"; shift ;;
      --wide) _wide=1; shift ;;
      *) die "unknown option for log: $1" ;;
    esac
  done
  require_repo

  _args=("--format=%h%x1f%(trailers:key=Session,valueonly,separator=+)%x1f%(trailers:key=Worktree,valueonly,separator=+)%x1f%ad%x1f%s" "--date=short" "-n" "$_count")
  [ -z "$_since" ] || _args[${#_args[@]}]="--since=$_since"
  [ -z "$_branch" ] || _args[${#_args[@]}]="$_branch"
  [ -z "$_all" ] || _args[${#_args[@]}]="--all"

  printf '%-9s %-14s %-22s %-11s %s\n' "COMMIT" "SESSION" "WORKTREE" "DATE" "SUBJECT"
  git -C "$GIT_ROOT" log "${_args[@]}" | while IFS="$US" read -r _sha _ssn _wt _date _subj; do
    [ -n "${_sha:-}" ] || continue
    [ -n "$_ssn" ] || _ssn="-"
    [ -n "$_wt" ] || _wt="-"
    [ "$_wide" -eq 0 ] || _subj="$_subj"
    printf '%-9s %-14s %-22s %-11s %s\n' "$_sha" "$_ssn" "$_wt" "$_date" "$_subj"
  done

  _total="$(git -C "$GIT_ROOT" log "${_args[@]}" --format='%h' | wc -l | tr -d ' ')"
  _with="$(git -C "$GIT_ROOT" log "${_args[@]}" --format='%(trailers:key=Session,valueonly,separator=+)' | grep -c . || true)"
  say ""
  say "$_total commit(s) shown, $_with attributed to a session"
}

# Branch -> "number state" for every PR, or empty when gh is unavailable.
pr_map() {
  command -v gh >/dev/null 2>&1 || return 0
  GIT_TERMINAL_PROMPT=0 timeout_cmd 25 gh pr list --state all --limit 200 \
    --json number,headRefName,state \
    --template '{{range .}}{{.headRefName}}{{"\t"}}#{{.number}} {{.state}}{{"\n"}}{{end}}' 2>/dev/null || true
}

timeout_cmd() {
  _secs="$1"; shift
  perl -e 'alarm shift; exec @ARGV' "$_secs" "$@"
}

last_deploy() {
  command -v gh >/dev/null 2>&1 || return 0
  GIT_TERMINAL_PROMPT=0 timeout_cmd 25 gh run list --workflow deploy-site.yml --limit 1 \
    --json headSha,conclusion,createdAt,displayTitle \
    --template '{{range .}}{{.headSha}}|{{.conclusion}}|{{.createdAt}}|{{.displayTitle}}{{"\n"}}{{end}}' 2>/dev/null || true
}

cmd_board() {
  GIT_ROOT="$(toplevel)"
  _offline=0; _all=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --offline) _offline=1; shift ;;
      --all) _all=1; shift ;;
      *) die "unknown option for board: $1" ;;
    esac
  done
  require_repo

  _prs=""
  if [ "$_offline" -eq 0 ]; then
    _prs="$(pr_map)"
  fi

  _base="origin/main"
  git -C "$GIT_ROOT" rev-parse --verify --quiet "$_base" >/dev/null || _base="main"

  _refs="$(git -C "$GIT_ROOT" for-each-ref --format='%(refname:short)' refs/heads)"
  if [ "$_all" -eq 1 ]; then
    _refs="$_refs
$(git -C "$GIT_ROOT" for-each-ref --format='%(refname:short)' refs/remotes/origin | grep -v '^origin/HEAD$' | sed 's|^origin/||')"
  fi
  _refs="$(printf '%s\n' "$_refs" | grep -v '^origin$' | sort -u)"

  printf '%-30s %-13s %-22s %5s %6s %-10s %-9s %s\n' "BRANCH" "SESSION" "WORKTREE" "AHEAD" "BEHIND" "LAST" "PR" "STATE"
  printf '%s\n' "$_refs" | while IFS= read -r _b; do
    [ -n "$_b" ] || continue
    _full="refs/heads/$_b"
    if ! git -C "$GIT_ROOT" rev-parse --verify --quiet "$_full" >/dev/null; then
      _full="refs/remotes/origin/$_b"
      git -C "$GIT_ROOT" rev-parse --verify --quiet "$_full" >/dev/null || continue
    fi
    _counts="$(git -C "$GIT_ROOT" rev-list --left-right --count "$_base...$_full" 2>/dev/null || printf '?\t?')"
    _behind="$(printf '%s' "$_counts" | cut -f1)"
    _ahead="$(printf '%s' "$_counts" | cut -f2)"
    _last="$(git -C "$GIT_ROOT" log -1 --format='%h %ad' --date=short "$_full")"

    _ssn="$(session_for_branch "$_b")"
    if [ -z "$_ssn" ]; then
      _ssn="$(git -C "$GIT_ROOT" log -1 --format='%(trailers:key=Session,valueonly,separator=+)' "$_full")"
      [ -n "$_ssn" ] || _ssn="-"
    fi
    _wt="-"
    if [ -f "$(session_file "$_ssn")" ]; then
      _wt="$(conf_get "$(session_file "$_ssn")" SESSION_WORKTREE)"
      _wt="${_wt#"$WORKSPACE"/}"
      [ -n "$_wt" ] || _wt="-"
    fi
    _pr="-"
    if [ -n "$_prs" ]; then
      _pr="$(printf '%s\n' "$_prs" | awk -F'\t' -v b="$_b" '$1==b {print $2; exit}')"
      [ -n "$_pr" ] || _pr="-"
    fi
    _state=""
    _wtabs="$WORKSPACE/$_wt"
    if [ -d "$_wtabs" ]; then
      _dirty="$(git -C "$_wtabs" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
      [ "$_dirty" = "0" ] || _state="${_dirty} uncommitted"
    fi
    [ -n "$_state" ] || _state="clean"
    [ "$_ahead" = "0" ] || [ "$_b" = "main" ] || _state="$_state; not merged"
    printf '%-30s %-13s %-22s %5s %6s %-10s %-9s %s\n' "$_b" "$_ssn" "$_wt" "$_ahead" "$_behind" "$_last" "$_pr" "$_state"
  done

  # A detached worktree (the deploy case) has no branch, so its session never appears in
  # the table above — and that is exactly the worktree a deploy lock is about. List the
  # active sessions the table could not place.
  for _f in "$SESSIONS_DIR"/*.conf; do
    [ -f "$_f" ] || continue
    [ "$(conf_get "$_f" SESSION_STATUS)" = "active" ] || continue
    _br="$(conf_get "$_f" SESSION_BRANCH)"
    printf '%s\n' "$_refs" | grep -qx -- "$_br" && continue
    _nm="$(conf_get "$_f" SESSION_NAME)"
    _w="$(conf_get "$_f" SESSION_WORKTREE)"
    _w="${_w#"$WORKSPACE"/}"
    printf 'off-branch: %-13s %-22s (branch %s) active\n' "$_nm" "$_w" "$_br"
  done

  say ""
  _main="$(git -C "$GIT_ROOT" rev-parse --short main 2>/dev/null || printf '?')"
  _origin="$(git -C "$GIT_ROOT" rev-parse --short origin/main 2>/dev/null || printf '?')"
  say "main: local $_main · origin/main $_origin"
  if [ "$_offline" -eq 0 ]; then
    _d="$(last_deploy)"
    if [ -n "$_d" ]; then
      _dsha="$(printf '%s' "$_d" | cut -d'|' -f1)"
      _dcon="$(printf '%s' "$_d" | cut -d'|' -f2)"
      _dat="$(printf '%s' "$_d" | cut -d'|' -f3)"
      say "last deploy-site: ${_dsha:0:7} $_dcon at $_dat"
      if [ "${_dsha:0:7}" = "$_origin" ]; then
        say "live: origin/main ($_origin) is the deployed commit"
      else
        _since="$(git -C "$GIT_ROOT" rev-list --count "${_dsha}..origin/main" 2>/dev/null || printf '?')"
        say "live: origin/main has $_since commit(s) after the last deploy-site run"
      fi
    else
      say "last deploy-site: unknown (gh unavailable or offline)"
    fi
  fi
}

cmd_blame() {
  GIT_ROOT="$(toplevel)"
  _path="${1:-}"
  [ -n "$_path" ] || die "blame needs a path: session-provenance.sh blame <path>"
  shift || true
  _count=25
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --count|-n) [ "$#" -ge 2 ] || die "--count needs a value"; _count="$2"; shift 2 ;;
      *) die "unknown option for blame: $1" ;;
    esac
  done
  require_repo
  [ -e "$REPO_ROOT/$_path" ] || [ -e "$_path" ] || die "no such path: $_path"

  say "session history for $_path"
  printf '%-9s %-14s %-11s %s\n' "COMMIT" "SESSION" "DATE" "SUBJECT"
  git -C "$GIT_ROOT" log --follow -n "$_count" \
    --format='%h%x1f%(trailers:key=Session,valueonly,separator=+)%x1f%ad%x1f%s' --date=short \
    -- "$_path" | while IFS="$US" read -r _sha _ssn _date _subj; do
    [ -n "${_sha:-}" ] || continue
    [ -n "$_ssn" ] || _ssn="-"
    printf '%-9s %-14s %-11s %s\n' "$_sha" "$_ssn" "$_date" "$_subj"
  done

  say ""
  say "commits per session:"
  git -C "$GIT_ROOT" log --follow -n 200 \
    --format='%(trailers:key=Session,valueonly,separator=+)' -- "$_path" |
    sed 's/^$/unattributed/' | sort | uniq -c | sort -rn | head -12 | sed 's/^/  /'
}

cmd_pr() {
  _title=""; _body=""; _base="main"; _draft=""; _dry=0; _evidence=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --title) [ "$#" -ge 2 ] || die "--title needs a value"; _title="$2"; shift 2 ;;
      --body) [ "$#" -ge 2 ] || die "--body needs a value"; _body="$2"; shift 2 ;;
      --evidence) [ "$#" -ge 2 ] || die "--evidence needs a value"; _evidence="$2"; shift 2 ;;
      --base) [ "$#" -ge 2 ] || die "--base needs a value"; _base="$2"; shift 2 ;;
      --draft) _draft="--draft"; shift ;;
      --dry-run) _dry=1; shift ;;
      *) die "unknown option for pr: $1" ;;
    esac
  done
  identity_resolve
  _top="$(toplevel)"

  _branch="$ID_BRANCH"
  [ "$_branch" != "HEAD" ] || die "detached HEAD — a PR needs a branch"
  [ "$_branch" != "$_base" ] || die "you are on $_base; a PR needs a feature branch"

  _up="$(git -C "$_top" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
  if [ -z "$_up" ]; then
    die "branch $_branch has no upstream. Push it first:
    GIT_TERMINAL_PROMPT=0 perl -e 'alarm 90; exec @ARGV' git push -u origin $_branch"
  fi
  _ahead="$(git -C "$_top" rev-list --count "$_up..HEAD")"
  [ "$_ahead" = "0" ] || die "$_ahead commit(s) are not pushed — push $_branch before opening the PR"

  _base_ref="origin/$_base"
  git -C "$_top" rev-parse --verify --quiet "$_base_ref" >/dev/null || _base_ref="$_base"

  [ -n "$_title" ] || _title="$(git -C "$_top" log -1 --format='%s' "$_base_ref..HEAD")"

  _commits="$(git -C "$_top" log --reverse \
    --format='- `%h` %s _(session: %(trailers:key=Session,valueonly,separator=+))_' "$_base_ref..HEAD")"
  _files="$(git -C "$_top" diff --name-only "$_base_ref...HEAD" | head -40)"
  _nfiles="$(git -C "$_top" diff --name-only "$_base_ref...HEAD" | wc -l | tr -d ' ')"
  _deploy="$(git -C "$_top" diff --name-only "$_base_ref...HEAD" | grep -E "$DEPLOY_PATHS" || true)"

  if [ -n "$_deploy" ]; then
    _impact="- [x] **Touches a deploy path — merging to \`$_base\` runs \`deploy-site\` and publishes \`unpackfund.com\`.**"
    _impact="$_impact
$(printf '%s\n' "$_deploy" | sed 's/^/  - `&`/')"
    _impact="$_impact

  A merge to \`main\` is a production deploy. Confirm the evidence below before merging."
  else
    _impact="- [ ] Does not touch a deploy path — merging to \`$_base\` does not publish the site."
  fi

  mkdir -p "$TMP_DIR"
  require_boundary "$TMP_DIR"
  _f="$TMP_DIR/pr-body.$$"
  trap 'rm -f "$_f"' EXIT
  {
    printf '## What and why\n\n'
    printf '%s\n\n' "${_body:-_One or two sentences: what changes, and what problem it solves._}"
    printf '## Provenance\n\n'
    printf '| | |\n|---|---|\n'
    printf '| Session | `%s` |\n' "$ID_SESSION"
    printf '| Worktree | `%s` |\n' "$ID_WORKTREE"
    printf '| Branch | `%s` |\n' "$_branch"
    printf '| Agent | `%s` |\n' "$ID_AGENT"
    [ -z "${ID_TASK:-}" ] || printf '| Task | %s |\n' "$ID_TASK"
    printf '\n## Commits (%s)\n\n%s\n\n' "$(git -C "$_top" rev-list --count "$_base_ref..HEAD")" "$_commits"
    printf '## Verification\n\n'
    printf '%s\n\n' "${_evidence:-_Command, exit code, and the line it printed. A claim without one is not evidence._}"
    printf '## Production impact\n\n%s\n\n' "$_impact"
    printf '## Rollback\n\n'
    printf '`git revert <merge-sha>` on `%s`, or `gh pr revert` if the branch is gone.\n\n' "$_base"
    printf -- '---\n'
    printf '_Files changed (%s):_\n\n' "$_nfiles"
    printf '%s\n' "$_files" | sed 's/^/- `/; s/$/`/'
    printf '\n_Opened with `scripts/session-provenance.sh pr` — session `%s`._\n' "$ID_SESSION"
  } >"$_f"

  if [ "$_dry" -eq 1 ]; then
    say "--- PR title ---"
    say "$_title"
    say ""
    say "--- PR body ---"
    cat "$_f"
    return 0
  fi

  command -v gh >/dev/null 2>&1 || die "gh is not installed; install it or open the PR in the browser"
  _url="$(GIT_TERMINAL_PROMPT=0 timeout_cmd 60 gh pr create --base "$_base" --head "$_branch" \
    --title "$_title" --body-file "$_f" $_draft)" || die "gh pr create failed"
  say "opened $_url"
  say ""
  say "merge when the evidence in the body is true (merge commit keeps the trailers):"
  say "  GIT_TERMINAL_PROMPT=0 perl -e 'alarm 90; exec @ARGV' gh pr merge --merge --delete-branch"
}

# ------------------------------------------------------------------ usage

usage() {
  cat <<'EOF'
session-provenance.sh — who made this commit, in which workspace, and did it deploy?

Usage:
  session-provenance.sh whoami
  session-provenance.sh register [--session <name>] [--worktree <path>]
                                 [--branch <branch>] [--agent <label>]
                                 [--task <text>] [--end]
  session-provenance.sh commit -m "<subject>" [-m "<body>"] [--task <text>]
                                [--session <name>] [--agent <label>] [git commit args]
  session-provenance.sh check [--range <rev>] [--quiet]
  session-provenance.sh log [--count N] [--since <date>] [--branch <b>] [--all]
  session-provenance.sh board [--offline] [--all]
  session-provenance.sh blame <path> [--count N]
  session-provenance.sh pr [--title <t>] [--body <b>] [--evidence <text>]
                           [--base main] [--draft] [--dry-run]

Every commit carries three trailers:
  Session:  <name>          which session/workstream produced it
  Worktree: .work/wt-<name> which workspace it was written in ("unpackfund" = the trunk)
  Agent:    <model label>   which agent instance, as recorded at registration

The hooks in scripts/git-hooks/ enforce them (commit-msg on every commit, pre-push for
commits authored after 2026-11-02T00:00:00Z). `--no-verify` is forbidden.

Read: docs/08-operations/2026-11-01-cross-session-provenance.md
EOF
}

# ------------------------------------------------------------------ main

case "${1:-}" in
  whoami) shift; cmd_whoami "$@" ;;
  register) shift; cmd_register "$@" ;;
  commit) shift; cmd_commit "$@" ;;
  check) shift; cmd_check "$@" ;;
  log) shift; cmd_log "$@" ;;
  board) shift; cmd_board "$@" ;;
  blame) shift; cmd_blame "$@" ;;
  pr) shift; cmd_pr "$@" ;;
  "" | -h | --help | help) usage ;;
  *) usage >&2; die "unknown command: $1" ;;
esac
