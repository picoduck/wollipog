#!/usr/bin/env bash
set -euo pipefail

repo=${1:?repository is required}
release_tag=${2:?release tag is required}
manifest=${3:?checksum manifest is required}
attempts=${WOLLIPOG_RELEASE_METADATA_ATTEMPTS:-6}
retry_delay=${WOLLIPOG_RELEASE_METADATA_RETRY_DELAY_SECONDS:-5}

case "$attempts" in *[!0-9]*|'') echo "invalid metadata attempt count" >&2; exit 2 ;; esac
case "$retry_delay" in *[!0-9]*|'') echo "invalid metadata retry delay" >&2; exit 2 ;; esac
[ "$attempts" -gt 0 ] || { echo "metadata attempt count must be positive" >&2; exit 2; }

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
metadata_parser="$script_dir/release-asset-metadata.mjs"
release_verifier="$script_dir/verify-runner-release-assets.mjs"
assets_json=$(mktemp "${TMPDIR:-/tmp}/wollipog-draft-assets.XXXXXX")
trap 'rm -f "$assets_json"' EXIT

# The release-by-tag endpoint omits drafts. Resolve exactly one draft from the paginated release
# collection, then bind every subsequent request to that immutable numeric release id.
release_id=
attempt=1
while [ "$attempt" -le "$attempts" ]; do
  release_pages=
  if release_pages=$(gh api --paginate --slurp "repos/$repo/releases?per_page=100"); then
    if release_id=$(printf '%s' "$release_pages" | node "$metadata_parser" draft-release-id "$release_tag"); then
      break
    fi
  fi
  release_id=
  [ "$attempt" -eq "$attempts" ] || sleep "$retry_delay"
  attempt=$((attempt + 1))
done

case "$release_id" in *[!0-9]*|'') echo "could not resolve the draft release id for $release_tag" >&2; exit 1 ;; esac
[ "$release_id" -gt 0 ] || { echo "could not resolve the draft release id for $release_tag" >&2; exit 1; }

verified=0
attempt=1
while [ "$attempt" -le "$attempts" ]; do
  # Both commands are conditions so bash -e cannot turn a transient API, JSON, inventory, or
  # digest failure into an unbounded early exit. A successful verifier is the only success gate.
  if gh api --paginate --slurp "repos/$repo/releases/$release_id/assets?per_page=100" >"$assets_json"; then
    if node "$release_verifier" release \
      --assets-json "$assets_json" \
      --manifest "$manifest"; then
      verified=1
      break
    fi
  fi
  echo "release assets have not converged yet (attempt $attempt/$attempts)" >&2
  [ "$attempt" -eq "$attempts" ] || sleep "$retry_delay"
  attempt=$((attempt + 1))
done

[ "$verified" -eq 1 ] || {
  echo "draft release assets did not converge after $attempts attempts" >&2
  exit 1
}
