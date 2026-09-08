#!/bin/sh
set -eu

version_source=${1:?control-plane version source is required}
shift
[ "$#" -gt 0 ] || { echo "at least one control-plane binary is required" >&2; exit 2; }

# Git checkouts and native Windows executables may independently emit CRLF. Remove CR from both
# sides while retaining every other byte so a real version mismatch still fails closed.
expected=$(sed -nE 's/^export const APP_RELEASE_VERSION = "(.*)";/\1/p' "$version_source" | tr -d '\r')
[ -n "$expected" ] || { echo "control-plane version source has no APP_RELEASE_VERSION export" >&2; exit 1; }
case "$expected" in *"
"*) echo "control-plane version source has multiple APP_RELEASE_VERSION exports" >&2; exit 1 ;; esac

for control_plane_binary in "$@"; do
  [ -f "$control_plane_binary" ] || { echo "control-plane binary is missing: $control_plane_binary" >&2; exit 1; }
  actual=$("$control_plane_binary" --version | tr -d '\r')
  if [ "$actual" != "$expected" ]; then
    echo "control-plane version mismatch: expected $expected, received $actual" >&2
    exit 1
  fi
done

printf '%s\n' "$expected"
