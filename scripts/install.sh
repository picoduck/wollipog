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
  if command -v gh >/dev/null 2>&1 && gh release view --repo "$repo" >/dev/null 2>&1; then
    use_gh=1
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

# Find the first release asset whose download URL ends with the given suffix.
pick() {
  if [ "$use_gh" -eq 1 ]; then
    gh release view --repo "$repo" --json assets --jq ".assets[] | select(.name | endswith(\"$1\")) | .name" | head -1 || true
  else
    printf '%s' "$release_json" | grep -o "https://[^\"]*$1" | head -1 || true
  fi
}

download() {
  asset=$1 dest=$2
  partial="${dest}.download.$$"
  rm -f "$partial"
  if [ "$use_gh" -eq 1 ]; then
    if ! gh release download --repo "$repo" --pattern "$asset" --output "$partial"; then
      rm -f "$partial"; return 1
    fi
  else
    if ! curl -fL -o "$partial" "$asset"; then rm -f "$partial"; return 1; fi
  fi
  mv -f "$partial" "$dest"
}

case "$os" in
  Darwin)
    url=$(pick "_${macdmg}.dmg")
    [ -n "$url" ] || { echo "No macOS .dmg for $macdmg in the latest release (published?)." >&2; exit 1; }
    tmp=$(mktemp -d); trap 'hdiutil detach "$tmp/mnt" -quiet 2>/dev/null || true; rm -rf "$tmp"' EXIT
    echo "Downloading $(basename "$url")..."
    download "$url" "$tmp/app.dmg"
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
    url=$(pick "_${appimg}.AppImage")
    [ -n "$url" ] || { echo "No Linux .AppImage for $appimg in the latest release (published?)." >&2; exit 1; }
    mkdir -p "$HOME/.local/bin"
    dest="$HOME/.local/bin/wollipog.AppImage"
    echo "Downloading $(basename "$url")..."
    download "$url" "$dest"
    chmod +x "$dest"
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
