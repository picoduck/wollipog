#!/bin/sh
set -eu

version_source=${1:?runner version source is required}
shift
[ "$#" -gt 0 ] || { echo "at least one runner binary is required" >&2; exit 2; }

# Git checkouts and native Windows executables may independently emit CRLF. Remove CR from both
# sides while retaining every other byte so a real version mismatch still fails closed.
expected=$(sed -nE 's/^export const VERSION = "(.*)";/\1/p' "$version_source" | tr -d '\r')
[ -n "$expected" ] || { echo "runner version source has no VERSION export" >&2; exit 1; }
case "$expected" in *"
"*) echo "runner version source has multiple VERSION exports" >&2; exit 1 ;; esac

for runner_binary in "$@"; do
  [ -f "$runner_binary" ] || { echo "runner binary is missing: $runner_binary" >&2; exit 1; }
  # Capture the exit status separately: in a pipeline `set -e` would only see tr's status, so a
  # binary that prints the right version and then fails would slip through the gate.
  if ! raw=$("$runner_binary" --version); then
    echo "runner binary failed to report its version: $runner_binary" >&2
    exit 1
  fi
  actual=$(printf '%s' "$raw" | tr -d '\r')
  if [ "$actual" != "$expected" ]; then
    echo "runner version mismatch: expected $expected, received $actual" >&2
    exit 1
  fi
done

printf '%s\n' "$expected"
