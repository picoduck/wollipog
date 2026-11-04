#!/usr/bin/env bash
# Playwright owns the dependency list. A changed dry-run format fails this optional cache
# phase, so the original bounded install can still run.
set -euo pipefail
phase="${1:?}"
browser="${2:?}"
case "$browser" in chromium|webkit) ;; *) exit 2 ;; esac
cache="$HOME/.cache/playwright-$browser-packages"
manifest="$RUNNER_TEMP/playwright-$browser-archives.txt"
packages_file="$RUNNER_TEMP/playwright-$browser-packages.txt"

case "$phase" in
  resolve)
    : "${ImageOS:?}" "${ImageVersion:?}" "${PLAYWRIGHT_VERSION:?}"
    sudo apt-get update -qq
    # Playwright 1.63's Linux dry-run exits 1 when packages are missing. Reject other
    # failures and validate its complete list before using it as apt arguments.
    report="$(pnpm exec playwright install-deps --dry-run "$browser")" || test "$?" -eq 1
    mapfile -t packages < <(printf '%s\n' "$report" | sed -nE 's/^  ([a-z0-9][a-z0-9+.-]*(:[a-z0-9][a-z0-9-]*)?)$/\1/p')
    test "${#packages[@]}" -gt 0
    grep -qxF "Missing system dependencies (${#packages[@]}):" <<< "$report"
    printf '%s\n' "${packages[@]}" > "$packages_file"
    archives="$(sudo apt-get install -qq --print-uris --no-install-recommends "${packages[@]}")"
    test -n "$archives"
    printf '%s\n' "$archives" > "$manifest"
    digest="$(cut -d ' ' -f 2- "$manifest" | sort | sha256sum | cut -c 1-64)"
    echo "key=playwright-system-v1-$browser-$ImageOS-$ImageVersion-$PLAYWRIGHT_VERSION-$digest" >> "$GITHUB_OUTPUT"
    ;;
  install)
    mode="${3:?}"
    case "$mode" in browser|system) ;; *) exit 2 ;; esac
    if [ "${SYSTEM_CACHE_HIT:-false}" = true ]; then
      mapfile -t packages < "$packages_file"
      test "${#packages[@]}" -gt 0
      sudo cp "$cache"/*.deb /var/cache/apt/archives/
      # No index update or archive fetch on a hit. Missing/corrupt archives fail this
      # attempt and enter the existing bounded, network-enabled Playwright retry.
      sudo apt-get install -y --no-install-recommends --no-download "${packages[@]}"
      if [ "$mode" = browser ]; then
        pnpm exec playwright install "$browser"
      fi
    else
      # An optional resolve timeout can leave root apt holding the lists lock.
      sudo pkill -KILL -x apt-get || true
      if [ "$mode" = browser ]; then
        pnpm exec playwright install --with-deps "$browser"
      else
        pnpm exec playwright install-deps "$browser"
      fi
    fi
    ;;
  collect)
    rm -rf "$cache"
    mkdir -p "$cache"
    while read -r _ archive _; do
      cp "/var/cache/apt/archives/$archive" "$cache/"
    done < "$manifest"
    ;;
  *) exit 2 ;;
esac
