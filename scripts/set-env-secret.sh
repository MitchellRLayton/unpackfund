#!/bin/sh
# Put one secret into the workspace .env without ever echoing it.
#
# The point is the transcript: a key pasted into a chat, a command argument, or a
# log line is in a plaintext, append-only record and can only be mitigated by
# revoking it. This script reads the value from the clipboard (or stdin), writes
# it to the git-ignored `.env` at the workspace root, and prints only the name
# and the length.
#
#   scripts/set-env-secret.sh OPENFIGI_API_KEY          # value from the clipboard
#   printf '%s' "$KEY" | scripts/set-env-secret.sh NAME  # value from a pipe
#
# The workspace root is the parent of this repository: .env lives there, outside
# git, so it can never be committed. Mode 600 is enforced on every write.
set -eu

name=${1:-}
if [ -z "$name" ]; then
  echo "usage: $0 NAME_OF_VARIABLE   (reads the value from the clipboard, or stdin)" >&2
  exit 2
fi

case "$name" in
  *[!A-Z0-9_]* | [!A-Z]*)
    echo "refusing: '$name' is not a shell variable name (A-Z, 0-9, underscore)" >&2
    exit 2
    ;;
esac

repo=$(cd "$(dirname "$0")/.." && pwd)
env_file=$(cd "$repo/.." && pwd)/.env

# Value source: stdin when piped, otherwise the clipboard.
if [ -t 0 ]; then
  if command -v pbpaste >/dev/null 2>&1; then
    value=$(pbpaste || true)
  else
    printf 'paste the value for %s, then press Enter: ' "$name" >&2
    IFS= read -r value
  fi
else
  value=$(cat)
fi

# One line, no surrounding whitespace: a copied key often carries a trailing
# newline, and an invisible newline in .env makes the value silently wrong.
value=$(printf '%s' "$value" | tr -d '\r\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')

if [ -z "$value" ]; then
  echo "nothing to store: the clipboard or pipe was empty" >&2
  exit 1
fi
if printf '%s' "$value" | grep -q '[[:space:]]'; then
  echo "refusing: the value contains whitespace (a truncated paste?)" >&2
  exit 1
fi
if [ "${#value}" -lt 8 ] || [ "${#value}" -gt 256 ]; then
  echo "refusing: ${#value} characters is not a plausible credential length" >&2
  exit 1
fi

NAME="$name" VALUE="$value" ENV_FILE="$env_file" python3 - <<'PY'
import os
import pathlib
import stat

name = os.environ["NAME"]
value = os.environ["VALUE"]
path = pathlib.Path(os.environ["ENV_FILE"])

lines = path.read_text().splitlines() if path.exists() else []
out, replaced = [], False
for line in lines:
    if line.startswith(f"{name}="):
        out.append(f"{name}={value}")
        replaced = True
    else:
        out.append(line)
if not replaced:
    if out and out[-1].strip():
        out.append("")
    out.append(f"{name}={value}")

path.write_text("\n".join(out) + "\n")
path.chmod(stat.S_IRUSR | stat.S_IWUSR)  # 0600
print(f"stored {name} ({len(value)} characters) in {path}"
      f" — {'replaced' if replaced else 'appended'}, mode 600")
PY

echo "verify without printing it: grep -c '^$name=.' \"$env_file\"" >&2
