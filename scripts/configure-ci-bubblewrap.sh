#!/usr/bin/env bash
set -euo pipefail

# Only disposable GitHub Ubuntu 24.04 jobs may load this per-executable profile.
test "${GITHUB_ACTIONS:-}" = true
test "${RUNNER_OS:-}" = Linux
. /etc/os-release
test "$ID" = ubuntu
test "$VERSION_ID" = 24.04
test "$(command -v bwrap)" = /usr/bin/bwrap
test "$(stat -c %u /usr/bin/bwrap)" = 0

smoke() {
  /usr/bin/bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --unshare-pid -- /bin/true
}
if smoke; then exit 0; fi

# Noble restricts capabilities inside unprivileged user namespaces. Grant only
# bubblewrap the documented userns permission, retaining the system-wide policy.
test "$(cat /sys/module/apparmor/parameters/enabled)" = Y
test "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns)" = 1
command -v apparmor_parser
test ! -e /etc/apparmor.d/wollipog-ci-bwrap
profile=$(mktemp)
trap 'rm -f "$profile"' EXIT
cat > "$profile" <<'PROFILE'
abi <abi/4.0>,
include <tunables/global>
profile wollipog-ci-bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
}
PROFILE
sudo install -m 0644 "$profile" /etc/apparmor.d/wollipog-ci-bwrap
sudo apparmor_parser -r /etc/apparmor.d/wollipog-ci-bwrap
test "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns)" = 1
smoke
