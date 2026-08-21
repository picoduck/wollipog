#!/bin/sh
# Wollipog — desktop app installer (macOS / Linux).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/picoduck/wollipog/main/scripts/install.sh | sh
#
# macOS: downloads the .dmg and copies Wollipog.app to /Applications (falls back to
#        ~/Applications). The app is unsigned — first launch: right-click -> Open.
# Linux: downloads the portable .AppImage to ~/.local/bin.
#
# Assets are matched by ARCH SUFFIX (…_x64.dmg, …_amd64.AppImage), so this script works
# across the Agent Manager → Wollipog product rename on either side of the release.
set -eu

repo="picoduck/wollipog"
api="https://api.github.com/repos/$repo/releases/latest"
use_gh=0
if ! release_json=$(curl -fsSL "$api"); then
  if command -v gh >/dev/null 2>&1 && gh_release=$(gh api "repos/$repo/releases/latest" --jq '.tag_name, (.assets[] | [.name, (.digest // ""), .browser_download_url] | @tsv)' 2>/dev/null); then
    use_gh=1
    release_tag=$(printf '%s\n' "$gh_release" | sed -n '1p')
    gh_assets=$(printf '%s\n' "$gh_release" | sed -n '2,$p')
    [ -n "$release_tag" ] || { echo "Authenticated GitHub release lookup returned no release tag." >&2; exit 1; }
  else
    echo "GitHub release lookup failed. For a private repository install/authenticate gh (gh auth login, or set GH_TOKEN with Contents: read), then run a local copy of this script." >&2
    exit 1
  fi
fi
os=$(uname -s)
arch=$(uname -m)

# Tauri's bundlers name assets inconsistently across platforms, so map per-bundler.
case "$arch" in
  arm64 | aarch64) macdmg=aarch64; appimg=aarch64 ;;
  x86_64 | amd64)  macdmg=x64;     appimg=amd64 ;;
  *) echo "Unsupported architecture: $arch" >&2; exit 1 ;;
esac

# Extract one asset record without mixing fields across neighboring JSON objects.
release_asset_record() {
  printf '%s' "$release_json" | awk -v suffix="$1" '
    function field(object, key,    needle, rest, colon, end) {
      needle = "\"" key "\""; if (index(object, needle) == 0) return ""
      rest = substr(object, index(object, needle) + length(needle)); colon = index(rest, ":")
      if (colon == 0) return ""; rest = substr(rest, colon + 1); sub(/^[[:space:]]*/, "", rest)
      if (substr(rest, 1, 1) != "\"") return ""; rest = substr(rest, 2); end = index(rest, "\"")
      return end == 0 ? "" : substr(rest, 1, end - 1)
    }
    { json = json $0 }
    END {
      marker = "\"assets\":["; start = index(json, marker); if (start == 0) exit
      json = substr(json, start + length(marker)); depth = quoted = escaped = object_start = 0
      for (i = 1; i <= length(json); i++) {
        ch = substr(json, i, 1)
        if (quoted) { if (escaped) escaped = 0; else if (ch == "\\") escaped = 1; else if (ch == "\"") quoted = 0; continue }
        if (ch == "\"") { quoted = 1; continue }
        if (ch == "{") { if (depth == 0) object_start = i; depth++ }
        else if (ch == "}") {
          depth--
          if (depth == 0 && object_start > 0) {
            object = substr(json, object_start, i - object_start + 1); name = field(object, "name")
            if (length(name) >= length(suffix) && substr(name, length(name) - length(suffix) + 1) == suffix) {
              print name "\t" field(object, "digest") "\t" field(object, "browser_download_url"); exit
            }
            object_start = 0
          }
        } else if (ch == "]" && depth == 0) exit
      }
    }
  '
}

pick() {
  if [ "$use_gh" -eq 1 ]; then
    printf '%s\n' "$gh_assets" | awk -F '\t' -v suffix="$1" 'length($1) >= length(suffix) && substr($1, length($1) - length(suffix) + 1) == suffix { print; exit }'
  else
    release_asset_record "$1"
  fi
}

verify_sha256() {
  file=$1 expected=$2 asset_name=$3
  if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$file" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then actual=$(shasum -a 256 "$file" | awk '{print $1}')
  else echo "No SHA-256 tool found (expected sha256sum or shasum); refusing an unverified install." >&2; return 1
  fi
  [ "$actual" = "$expected" ] || { echo "Desktop asset $asset_name failed SHA-256 verification." >&2; return 1; }
}

download() {
  download_asset=$1 download_dest=$2
  partial="${download_dest}.download.$$"
  rm -f "$partial"
  if [ "$use_gh" -eq 1 ]; then
    if ! gh release download "$release_tag" --repo "$repo" --pattern "$download_asset" --output "$partial"; then
      rm -f "$partial"; return 1
    fi
  else
    if ! curl -fL -o "$partial" "$download_asset"; then rm -f "$partial"; return 1; fi
  fi
  mv -f "$partial" "$download_dest"
}

case "$os" in
  Darwin)
    asset_record=$(pick "_${macdmg}.dmg")
    [ -n "$asset_record" ] || { echo "No macOS .dmg for $macdmg in the latest release (published?)." >&2; exit 1; }
    asset_name=$(printf '%s\n' "$asset_record" | cut -f1); publisher_digest=$(printf '%s\n' "$asset_record" | cut -f2); url=$(printf '%s\n' "$asset_record" | cut -f3)
    [ "$use_gh" -eq 0 ] || url=$asset_name
    printf '%s\n' "$publisher_digest" | grep -Eq '^sha256:[0-9a-f]{64}$' || { echo "Desktop asset $asset_name has no valid GitHub SHA-256 digest; refusing an unverified install." >&2; exit 1; }
    tmp=$(mktemp -d); trap 'hdiutil detach "$tmp/mnt" -quiet 2>/dev/null || true; rm -rf "$tmp"' EXIT
    echo "Downloading $(basename "$url")..."
    download "$url" "$tmp/app.dmg"
    verify_sha256 "$tmp/app.dmg" "${publisher_digest#sha256:}" "$asset_name"
    echo "Installing to /Applications..."
    hdiutil attach "$tmp/app.dmg" -nobrowse -quiet -mountpoint "$tmp/mnt"
    app=$(ls -d "$tmp/mnt/"*.app 2>/dev/null | head -1)
    [ -n "$app" ] || { echo "No .app inside the dmg." >&2; exit 1; }
    if cp -R "$app" /Applications/ 2>/dev/null; then dest=/Applications; else
      mkdir -p "$HOME/Applications"; cp -R "$app" "$HOME/Applications/"; dest="$HOME/Applications"
    fi
    # An upgrade across the rename would otherwise leave the obsolete app launchable.
    rm -rf "$dest/Agent Manager.app" 2>/dev/null || true
    echo "Installed to $dest. First launch: right-click the app -> Open (unsigned build)."
    ;;
  Linux)
    asset_record=$(pick "_${appimg}.AppImage")
    [ -n "$asset_record" ] || { echo "No Linux .AppImage for $appimg in the latest release (published?)." >&2; exit 1; }
    asset_name=$(printf '%s\n' "$asset_record" | cut -f1); publisher_digest=$(printf '%s\n' "$asset_record" | cut -f2); url=$(printf '%s\n' "$asset_record" | cut -f3)
    [ "$use_gh" -eq 0 ] || url=$asset_name
    printf '%s\n' "$publisher_digest" | grep -Eq '^sha256:[0-9a-f]{64}$' || { echo "Desktop asset $asset_name has no valid GitHub SHA-256 digest; refusing an unverified install." >&2; exit 1; }
    mkdir -p "$HOME/.local/bin"
    dest="$HOME/.local/bin/wollipog.AppImage"
    staged="${dest}.download.$$"
    trap 'rm -f "$staged"' EXIT
    rm -f "$staged"
    echo "Downloading $(basename "$url")..."
    download "$url" "$staged"
    verify_sha256 "$staged" "${publisher_digest#sha256:}" "$asset_name"
    chmod +x "$staged"
    mv -f "$staged" "$dest"
    # A previous install under the old name would otherwise linger as a stale duplicate.
    rm -f "$HOME/.local/bin/agent-manager.AppImage"
    echo "Installed to $dest"
    case ":$PATH:" in
      *":$HOME/.local/bin:"*) echo "Run: wollipog.AppImage" ;;
      *) echo "Run: $dest  (add ~/.local/bin to PATH to launch by name)" ;;
    esac
    ;;
  *)
    echo "Unsupported OS: $os (use scripts/install.ps1 on Windows)." >&2
    exit 1
    ;;
esac
