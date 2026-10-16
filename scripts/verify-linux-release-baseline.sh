#!/usr/bin/env bash
# Run against real outputs in the same native Jammy userland that built them.
set -euo pipefail
export LC_ALL=C
verify_linux_release_binary() {
  local binary="$1" machine="$2" versions version newest resolved
  test -s "$binary"
  readelf --file-header "$binary" | grep -F "Machine:" | grep -F "$machine"
  # All required GLIBC symbol versions must be available on the retained baseline.
  # Reject special/private ABIs too, rather than ignoring their nonnumeric names.
  versions="$(readelf --version-info "$binary" | grep -oE 'GLIBC_[A-Za-z0-9_.]+' | sort -Vu)"
  for version in $versions; do
    case "$version" in
      GLIBC_[0-9]*)
        newest="$(printf '%s\n' "${version#GLIBC_}" 2.35 | sort -V | tail -n 1)"
        test "$newest" = 2.35 || { echo "$binary requires $version above the glibc 2.35 baseline" >&2; exit 1; }
        ;;
      *) echo "$binary requires unsupported ABI $version" >&2; exit 1 ;;
    esac
  done
  # Resolve libraries AND relocations using the actual baseline dynamic loader.
  resolved="$(ldd -r "$binary" 2>&1)"
  printf '%s\n' "$resolved"
  if printf '%s\n' "$resolved" | grep -Eq 'not found|undefined symbol'; then
    echo "$binary does not resolve on the Ubuntu 22.04 baseline" >&2
    exit 1
  fi
}

verify_linux_release_baseline() {
  . /etc/os-release
  test "$ID" = ubuntu && test "$VERSION_ID" = 22.04
  test "$(getconf GNU_LIBC_VERSION)" = "glibc 2.35"
  test "$#" = 1
  local target="$1" architecture machine binary
  case "$target" in
    x86_64-unknown-linux-gnu) architecture=x86_64; machine="Advanced Micro Devices X86-64" ;;
    aarch64-unknown-linux-gnu) architecture=aarch64; machine=AArch64 ;;
    *) echo "Unsupported Linux release target: $target" >&2; exit 1 ;;
  esac
  test "$(uname -m)" = "$architecture"
  for binary in \
    "apps/desktop/src-tauri/target/$target/release/wollipog-desktop" \
    "apps/desktop/src-tauri/binaries/control-plane-$target" \
    "apps/desktop/src-tauri/binaries/runner-$target" \
    "apps/control-plane/dist-bin/wollipog-control-plane-$target" \
    "apps/runner/dist-bin/wollipog-runner-$target" \
    "apps/runner/dist-bin/agent-manager-runner-$target"; do
    verify_linux_release_binary "$binary" "$machine"
  done

  # Execute shipped entry points, not a host Node binary or an uninjected bundle.
  sh scripts/verify-runner-release-version.sh apps/runner/src/version.ts \
    "apps/runner/dist-bin/wollipog-runner-$target" "apps/runner/dist-bin/agent-manager-runner-$target"
  sh scripts/verify-control-plane-release-version.sh apps/control-plane/src/release-version.ts \
    "apps/control-plane/dist-bin/wollipog-control-plane-$target"
  cmp "apps/desktop/src-tauri/binaries/control-plane-$target" "apps/control-plane/dist-bin/wollipog-control-plane-$target"
  cmp "apps/desktop/src-tauri/binaries/runner-$target" "apps/runner/dist-bin/wollipog-runner-$target"
  echo "Linux release architecture, ABI, loader and SEA entry points verified on Ubuntu 22.04"
}

if [[ "${BASH_SOURCE[0]}" = "$0" ]]; then
  verify_linux_release_baseline "$@"
fi
