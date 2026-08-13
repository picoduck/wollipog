#!/bin/sh
set -eu

repo=${1:?repository is required}
release_tag=${2:?release tag is required}
asset_name=${3:?asset name is required}
attempts=${WOLLIPOG_RELEASE_METADATA_ATTEMPTS:-6}
retry_delay=${WOLLIPOG_RELEASE_METADATA_RETRY_DELAY_SECONDS:-5}

case "$attempts" in *[!0-9]*|'') echo "invalid metadata attempt count" >&2; exit 2 ;; esac
case "$retry_delay" in *[!0-9]*|'') echo "invalid metadata retry delay" >&2; exit 2 ;; esac
[ "$attempts" -gt 0 ] || { echo "metadata attempt count must be positive" >&2; exit 2; }

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
metadata_parser="$script_dir/release-asset-metadata.mjs"

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

remote_digest=
attempt=1
while [ "$attempt" -le "$attempts" ]; do
  asset_pages=
  if asset_pages=$(gh api --paginate --slurp "repos/$repo/releases/$release_id/assets?per_page=100"); then
    if remote_digest=$(printf '%s' "$asset_pages" | node "$metadata_parser" asset-digest "$asset_name"); then
      if printf '%s' "$remote_digest" | grep -Eq '^sha256:[0-9a-f]{64}$'; then
        break
      fi
    fi
  fi
  remote_digest=
  [ "$attempt" -eq "$attempts" ] || sleep "$retry_delay"
  attempt=$((attempt + 1))
done

if ! printf '%s' "$remote_digest" | grep -Eq '^sha256:[0-9a-f]{64}$'; then
  echo "$asset_name has no valid GitHub publisher digest" >&2
  exit 1
fi
printf '%s' "$remote_digest"
