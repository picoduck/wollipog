#!/bin/sh
# Wollipog — Runner Installer (macOS / Linux). Downloads the standalone runner binary
# (no Node required) and writes a starter config.
#
# Usage (local dashboard, defaults):
#   curl -fsSL https://raw.githubusercontent.com/picoduck/wollipog/main/scripts/install-runner.sh | sh
#
# Usage (remote dashboard):
#   curl -fsSL .../install-runner.sh | sh -s -- --url wss://HOST:4317/runner --token YOUR_TOKEN
set -eu

repo="picoduck/wollipog"
url="ws://127.0.0.1:4317/runner"
token="dev-local-token"
runner_id="$(hostname)"
workspace="$HOME"

while [ $# -gt 0 ]; do
  case "$1" in
    --url) url="$2"; shift 2 ;;
    --token) token="$2"; shift 2 ;;
    --id) runner_id="$2"; shift 2 ;;
    --workspace) workspace="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Darwin) sys=apple-darwin ;;
  Linux)  sys=unknown-linux-gnu ;;
  *) echo "Unsupported OS: $os (use scripts/install-runner.ps1 on Windows)." >&2; exit 1 ;;
esac
case "$arch" in
  arm64 | aarch64) cpu=aarch64 ;;
  x86_64 | amd64)  cpu=x86_64 ;;
  *) echo "Unsupported architecture: $arch" >&2; exit 1 ;;
esac
triple="${cpu}-${sys}"
canonical="wollipog-runner-${triple}"
legacy="agent-manager-runner-${triple}"
legacy_fallback=0

# Extract one exact asset from GitHub's raw release JSON without requiring jq. The scanner isolates
# balanced top-level objects in the assets array before reading fields, so names/digests/URLs cannot
# be mixed across neighboring assets.
release_asset_record() {
  printf '%s' "$release_json" | awk -v wanted="$1" '
    function string_field(object, key,    needle, rest, colon, end) {
      needle = "\"" key "\""
      rest = substr(object, index(object, needle) + length(needle))
      if (rest == object || index(object, needle) == 0) return ""
      colon = index(rest, ":")
      if (colon == 0) return ""
      rest = substr(rest, colon + 1)
      sub(/^[[:space:]]*/, "", rest)
      if (substr(rest, 1, 1) != "\"") return ""
      rest = substr(rest, 2)
      end = index(rest, "\"")
      return end == 0 ? "" : substr(rest, 1, end - 1)
    }
    { json = json $0 }
    END {
      marker = "\"assets\":["
      start = index(json, marker)
      if (start == 0) exit
      json = substr(json, start + length(marker))
      depth = 0; quoted = 0; escaped = 0; object_start = 0
      for (i = 1; i <= length(json); i++) {
        ch = substr(json, i, 1)
        if (quoted) {
          if (escaped) escaped = 0
          else if (ch == "\\") escaped = 1
          else if (ch == "\"") quoted = 0
          continue
        }
        if (ch == "\"") { quoted = 1; continue }
        if (ch == "{") {
          if (depth == 0) object_start = i
          depth++
        } else if (ch == "}") {
          depth--
          if (depth == 0 && object_start > 0) {
            object = substr(json, object_start, i - object_start + 1)
            name = string_field(object, "name")
            if (name == wanted) {
              print name "\t" string_field(object, "digest") "\t" string_field(object, "browser_download_url")
              exit
            }
            object_start = 0
          }
        } else if (ch == "]" && depth == 0) exit
      }
    }
  '
}

api="https://api.github.com/repos/$repo/releases/latest"
use_gh=0
legacy_selected=0
if release_json=$(curl -fsSL "$api"); then
  tag_field=$(printf '%s' "$release_json" | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 || true)
  release_tag=$(printf '%s' "$tag_field" | sed 's/.*:[[:space:]]*"//; s/"$//')
  [ -n "$release_tag" ] || { echo "Latest GitHub release metadata has no tag name." >&2; exit 1; }
  asset_record=$(release_asset_record "$canonical")
  if [ -z "$asset_record" ]; then
    asset_record=$(release_asset_record "$legacy")
    [ -z "$asset_record" ] || legacy_selected=1
  fi
  asset_name=$(printf '%s\n' "$asset_record" | cut -f1)
  dl=$(printf '%s\n' "$asset_record" | cut -f3)
  checksum_record=$(release_asset_record SHA256SUMS)
  checksum_dl=$(printf '%s\n' "$checksum_record" | cut -f3)
else
  if command -v gh >/dev/null 2>&1 && gh_release=$(gh api "repos/$repo/releases/latest" --jq '.tag_name, (.assets[] | [.name, (.digest // ""), .browser_download_url] | @tsv)' 2>/dev/null); then
    use_gh=1
    gh_tag=$(printf '%s\n' "$gh_release" | sed -n '1p')
    release_tag=$gh_tag
    gh_assets=$(printf '%s\n' "$gh_release" | sed -n '2,$p')
    [ -n "$gh_tag" ] || { echo "Authenticated GitHub release lookup returned no release tag." >&2; exit 1; }
    asset_record=$(printf '%s\n' "$gh_assets" | awk -F '\t' -v wanted="$canonical" '$1 == wanted { print; exit }')
    if [ -z "$asset_record" ]; then
      asset_record=$(printf '%s\n' "$gh_assets" | awk -F '\t' -v wanted="$legacy" '$1 == wanted { print; exit }')
      [ -z "$asset_record" ] || legacy_selected=1
    fi
    asset_name=$(printf '%s\n' "$asset_record" | cut -f1)
    dl=$(printf '%s\n' "$asset_record" | cut -f1)
    checksum_record=$(printf '%s\n' "$gh_assets" | awk -F '\t' '$1 == "SHA256SUMS" { print; exit }')
    checksum_dl=$(printf '%s\n' "$checksum_record" | cut -f1)
  else
    echo "GitHub release lookup failed. For a private repository install/authenticate gh (gh auth login, or set GH_TOKEN with Contents: read), then run a local copy of this script." >&2
    exit 1
  fi
fi
[ -n "$dl" ] || { echo "No runner binary for $triple in release ${release_tag:-latest}." >&2; exit 1; }
publisher_digest=$(printf '%s\n' "$asset_record" | cut -f2)
if ! printf '%s\n' "$publisher_digest" | grep -Eq '^sha256:[0-9a-f]{64}$'; then
  echo "Runner asset $(basename "$dl") has no valid GitHub SHA-256 digest; refusing an unverified install." >&2
  exit 1
fi
expected_sha256=${publisher_digest#sha256:}

bindir="$HOME/.local/bin"
mkdir -p "$bindir"
bin="$bindir/wollipog-runner"
cli_bin="$bindir/wollipog"
legacy_bin="$bindir/agent-manager-runner"
echo "Downloading $asset_name from $release_tag..."
partial="${bin}.download.$$"
legacy_partial="${legacy_bin}.alias.$$"
cli_partial="${cli_bin}.alias.$$"
checksum_partial="${bin}.SHA256SUMS.$$"
cleanup() {
  [ -z "${partial:-}" ] || rm -f "$partial"
  [ -z "${legacy_partial:-}" ] || rm -f "$legacy_partial"
  [ -z "${cli_partial:-}" ] || rm -f "$cli_partial"
  [ -z "${checksum_partial:-}" ] || rm -f "$checksum_partial"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
cleanup
if [ "$use_gh" -eq 1 ]; then
  if ! gh release download "$release_tag" --repo "$repo" --pattern "$asset_name" --output "$partial"; then
    exit 1
  fi
  if [ -n "$checksum_dl" ]; then
    gh release download "$release_tag" --repo "$repo" --pattern SHA256SUMS --output "$checksum_partial"
  fi
else
  curl -fL -o "$partial" "$dl"
  if [ -n "$checksum_dl" ]; then
    curl -fL -o "$checksum_partial" "$checksum_dl"
  fi
fi
if command -v sha256sum >/dev/null 2>&1; then
  actual_sha256=$(sha256sum "$partial" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  actual_sha256=$(shasum -a 256 "$partial" | awk '{print $1}')
else
  echo "No SHA-256 tool found (expected sha256sum or shasum); refusing an unverified install." >&2
  rm -f "$partial"
  exit 1
fi
if [ "$actual_sha256" != "$expected_sha256" ]; then
  echo "Runner asset $(basename "$dl") failed SHA-256 verification." >&2
  rm -f "$partial"
  exit 1
fi

if [ -n "$checksum_dl" ]; then
  manifest_sha256=$(awk -v asset="$asset_name" '
    NF == 2 && $2 == asset && length($1) == 64 && $1 !~ /[^0-9a-fA-F]/ {
      count++; digest=tolower($1)
    }
    END { if (count == 1) print digest; else exit 1 }
  ' "$checksum_partial" || true)
  [ -n "$manifest_sha256" ] || {
    echo "SHA256SUMS in release $release_tag has no unique exact entry for $asset_name." >&2
    exit 1
  }
  [ "$actual_sha256" = "$manifest_sha256" ] || {
    echo "SHA-256 verification failed for $asset_name from release $release_tag." >&2
    exit 1
  }
fi
chmod +x "$partial"
mv -f "$partial" "$bin"
partial=""

# Keep old service definitions and shell commands working throughout the compatibility window.
# Prefer a hard link so both names are guaranteed to address the same bytes, but fall back to an
# atomic copy on filesystems that do not support links.
refresh_legacy_alias() {
  if ! ln -f "$bin" "$legacy_partial" 2>/dev/null; then
    cp "$bin" "$legacy_partial" || return 1
    chmod +x "$legacy_partial" || return 1
  fi
  mv -f "$legacy_partial" "$legacy_bin" || return 1
}
if ! refresh_legacy_alias; then
  echo "Warning: could not refresh the legacy runner command alias at $legacy_bin; the canonical runner is installed." >&2
  rm -f "$legacy_partial" || true
fi
legacy_partial=""

# The same verified SEA dispatches by invocation name, so the user-facing CLI needs no second
# download or runtime. Publish it only after the canonical binary has been verified and promoted.
refresh_cli_alias() {
  if ! ln -f "$bin" "$cli_partial" 2>/dev/null; then
    cp "$bin" "$cli_partial" || return 1
    chmod +x "$cli_partial" || return 1
  fi
  mv -f "$cli_partial" "$cli_bin" || return 1
}
if ! refresh_cli_alias; then
  echo "Warning: could not refresh the Wollipog CLI alias at $cli_bin; rerun this installer after stopping any process using it." >&2
  rm -f "$cli_partial" || true
fi
cli_partial=""
rm -f "$checksum_partial"
checksum_partial=""

canonical_cfgdir="$HOME/.config/wollipog"
canonical_cfg="$canonical_cfgdir/runner.config.json"
legacy_cfgdir="$HOME/.config/agent-manager"
legacy_cfg="$legacy_cfgdir/runner.config.json"

# Never copy a credential-bearing legacy config. Existing installs keep using it in place until
# the operator deliberately reissues credentials into the canonical location.
if [ -f "$canonical_cfg" ]; then
  cfgdir=$canonical_cfgdir
  cfg=$canonical_cfg
elif [ -f "$legacy_cfg" ]; then
  cfgdir=$legacy_cfgdir
  cfg=$legacy_cfg
  config_warning="$legacy_cfgdir/.wollipog-config-location-warning-v1"
  if [ ! -f "$config_warning" ]; then
    echo "Warning: using the existing legacy runner config at $legacy_cfg; it was not copied or changed. Fresh installs use $canonical_cfg." >&2
    touch "$config_warning" 2>/dev/null || true
  fi
else
  cfgdir=$canonical_cfgdir
  cfg=$canonical_cfg
fi
install_umask=$(umask)
umask 077
mkdir -p "$cfgdir"
if [ "$legacy_selected" -eq 1 ]; then
  if command -v sha256sum >/dev/null 2>&1; then
    legacy_warning_scope=$(printf '%s' "$release_tag" | sha256sum | awk '{print $1}')
  else
    legacy_warning_scope=$(printf '%s' "$release_tag" | shasum -a 256 | awk '{print $1}')
  fi
  legacy_warning="$cfgdir/.legacy-runner-asset-warning-v1-$legacy_warning_scope"
  if [ ! -f "$legacy_warning" ]; then
    echo "Warning: Wollipog used a legacy runner asset because the canonical asset was absent; update the release producer before compatibility is removed." >&2
    : > "$legacy_warning" || true
  fi
fi
if [ ! -f "$cfg" ]; then
  cat > "$cfg" <<EOF
{
  "runnerId": "$runner_id",
  "controlPlaneUrl": "$url",
  "token": "$token",
  "workspaces": [{ "id": "home", "name": "$runner_id", "path": "$workspace" }],
  "agents": []
}
EOF
  echo "Wrote starter config: $cfg"
fi
umask "$install_umask"

echo ""
echo "Runner installed: $bin"
echo "CLI installed:    $cli_bin"
echo "Start it:  $bin --config $cfg"
case ":$PATH:" in
  *":$bindir:"*) ;;
  *) echo "(add ~/.local/bin to PATH to run 'wollipog-runner' by name)" ;;
esac
