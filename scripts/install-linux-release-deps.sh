#!/usr/bin/env bash
# Shared by release and publication-free native compatibility builds.
set -euo pipefail
. /etc/os-release
test "$ID" = ubuntu && test "$VERSION_ID" = 22.04
test "$(getconf GNU_LIBC_VERSION)" = "glibc 2.35"
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev \
  patchelf build-essential libssl-dev file binutils rpm libfuse2 xz-utils unzip

# Jammy's distribution gh predates --slurp, used by draft-release digest verification.
# Pin and verify the same modern CLI on both native architectures.
gh_version=2.102.0
case "$(dpkg --print-architecture)" in
  amd64) gh_arch=amd64; gh_sha=bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386 ;;
  arm64) gh_arch=arm64; gh_sha=7862c86c72f43df3a2d93ddde6f473285b4e2af61b494849846827e513ef6484 ;;
  *) echo "Unsupported Linux release architecture" >&2; exit 1 ;;
esac
gh_tmp="$(mktemp -d)"
trap 'rm -rf "$gh_tmp"' EXIT
gh_archive="gh_${gh_version}_linux_${gh_arch}.tar.gz"
curl --fail --location --retry 3 --output "$gh_tmp/$gh_archive" \
  "https://github.com/cli/cli/releases/download/v$gh_version/$gh_archive"
printf '%s  %s\n' "$gh_sha" "$gh_tmp/$gh_archive" | sha256sum --check
tar -xzf "$gh_tmp/$gh_archive" -C "$gh_tmp"
install -m 0755 "$gh_tmp/gh_${gh_version}_linux_${gh_arch}/bin/gh" /usr/local/bin/gh
gh --version
gh api --help | grep -- --slurp
