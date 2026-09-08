#!/usr/bin/env bash
# End-to-end check of `wollipog service` against a real systemd in system mode.
#
# This installs, kills, restarts, and removes the real wollipog-control-plane.service and
# wollipog-runner.service units, so it must only ever run as root on a disposable host (a CI VM).
# It refuses to run on a host that already has Wollipog units installed. The control plane and
# runner run from this checkout through tiny wrapper executables, so the checkout must be readable
# by the `wollipog` service account (the CI workflow opens the runner's home directory for that).
#
# What it proves, beyond the unit tests:
#   1. install creates the account, units, config, and credentials; both units are active and
#      enabled; the control plane is healthy and the colocated runner registers as online.
#   2. Restart=on-failure: SIGKILL of the control plane's main process is healed by systemd within
#      the restart window and the runner survives it.
#   3. Boot-style ordering: with both units stopped, starting only the runner pulls the control
#      plane in first (Wants=/After=), and the runner comes back online.
#   4. Graceful stop: `systemctl stop` finishes well inside TimeoutStopSec with Result=success.
#   5. Credentials stay 0600 and owned by the service account; the unit files carry no secret.
#   6. uninstall --purge removes the units, data, and configuration.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
node_bin=${NODE_BIN:-$(command -v node)}
port=${WOLLIPOG_E2E_PORT:-4390}
cp_unit=wollipog-control-plane.service
runner_unit=wollipog-runner.service
wrapper_dir=""

fail() { echo "FAIL: $*" >&2; exit 1; }
step() { echo; echo "== $*"; }

[ "$(id -u)" -eq 0 ] || fail "run as root (sudo) on a disposable host"
[ -d /run/systemd/system ] || fail "systemd is not running as PID 1 here"
[ "${WOLLIPOG_E2E_CONFIRM:-}" = 1 ] || fail "set WOLLIPOG_E2E_CONFIRM=1 to acknowledge this installs and removes system units on THIS host"
for unit in "$cp_unit" "$runner_unit"; do
  # The manager's view (every load path, drop-ins) and the files on disk (a unit written since the
  # last daemon-reload is invisible to the manager) must both say the unit does not exist.
  state=$(systemctl show -p LoadState --value "$unit" 2>/dev/null || true)
  [ "$state" = not-found ] || fail "$unit is already known to systemd (LoadState=$state); this script only runs on a host without Wollipog installed"
  for dir in /etc/systemd/system /run/systemd/system /usr/local/lib/systemd/system /usr/lib/systemd/system /lib/systemd/system; do
    [ ! -e "$dir/$unit" ] && [ ! -e "$dir/$unit.d" ] || fail "$dir/$unit exists; this script only runs on a host without Wollipog installed"
  done
done
[ ! -e /var/lib/wollipog ] && [ ! -e /etc/wollipog ] || fail "/var/lib/wollipog or /etc/wollipog already exists"
command -v jq >/dev/null || fail "jq is required"
command -v curl >/dev/null || fail "curl is required"
[ -x "$node_bin" ] || fail "node not found (set NODE_BIN)"

cli() { "$node_bin" --import tsx "$repo/apps/runner/src/cli.ts" --wollipog-cli "$@"; }
prop() { systemctl show -p "$1" --value "$2"; }
wait_until() { # wait_until <seconds> <description> <command...>
  local deadline=$(( $(date +%s) + $1 )); local what=$2; shift 2
  until "$@"; do
    [ "$(date +%s)" -lt "$deadline" ] || fail "timed out waiting for $what"
    sleep 1
  done
}
healthy() { curl -fsS --max-time 3 "http://127.0.0.1:$port/healthz" 2>/dev/null | jq -e '.ok == true' >/dev/null; }
runner_online() { cli service status --system --json 2>/dev/null | jq -e '.runners != null and any(.runners[]; .status == "online")' >/dev/null; }

cleanup() {
  set +e
  echo
  echo "== Cleanup"
  systemctl stop "$runner_unit" "$cp_unit" 2>/dev/null
  systemctl disable "$runner_unit" "$cp_unit" 2>/dev/null
  rm -f "/etc/systemd/system/$runner_unit" "/etc/systemd/system/$cp_unit"
  systemctl daemon-reload
  rm -rf /var/lib/wollipog /etc/wollipog
  [ -z "$wrapper_dir" ] || rm -rf "$wrapper_dir"
}
trap cleanup EXIT

# A fresh directory of our own (never a fixed path that might already hold something), world
# readable so the service account can execute the wrappers.
wrapper_dir=$(mktemp -d /usr/local/lib/wollipog-e2e.XXXXXX)
chmod 0755 "$wrapper_dir"
step "Wrapper executables in $wrapper_dir"
# `--import tsx` would resolve tsx from the unit's WorkingDirectory (/var/lib/wollipog/...), so the
# loader is named by its absolute path inside the checkout.
tsx_loader="$repo/node_modules/tsx/dist/loader.mjs"
[ -f "$tsx_loader" ] || fail "tsx loader not found at $tsx_loader (run pnpm install first)"
cat > "$wrapper_dir/wollipog-control-plane" <<EOF
#!/bin/sh
export TSX_DISABLE_CACHE=1
exec "$node_bin" --import "$tsx_loader" "$repo/apps/control-plane/src/index.ts" "\$@"
EOF
cat > "$wrapper_dir/wollipog-runner" <<EOF
#!/bin/sh
export TSX_DISABLE_CACHE=1
exec "$node_bin" --import "$tsx_loader" "$repo/apps/runner/src/cli.ts" "\$@"
EOF
chmod 0755 "$wrapper_dir"/wollipog-control-plane "$wrapper_dir"/wollipog-runner

step "1. service install --system"
install_json=$(cli service install --system --control-plane-bin "$wrapper_dir/wollipog-control-plane" --runner-bin "$wrapper_dir/wollipog-runner" --port "$port" --json) || {
  echo "$install_json"; journalctl -u "$cp_unit" -u "$runner_unit" --no-pager -n 80 || true; fail "install exited non-zero"; }
echo "$install_json" | jq .
echo "$install_json" | jq -e '.health.controlPlane.ok == true' >/dev/null || fail "install did not report a healthy control plane"
echo "$install_json" | jq -e '.health.runnerOnline == true' >/dev/null || fail "install did not report the runner online"
id wollipog >/dev/null || fail "service account wollipog was not created"
sudo -u wollipog test -r "$repo/package.json" || fail "the wollipog account cannot read the checkout at $repo (open the parent directories with chmod o+rx)"
for unit in "$cp_unit" "$runner_unit"; do
  [ "$(systemctl is-active "$unit")" = active ] || fail "$unit is not active after install"
  [ "$(systemctl is-enabled "$unit")" = enabled ] || fail "$unit is not enabled after install"
done
prop After "$runner_unit" | grep -q "$cp_unit" || fail "runner unit is not ordered after the control plane"
prop Wants "$runner_unit" | grep -q "$cp_unit" || fail "runner unit does not want the control plane"
[ "$(prop Restart "$cp_unit")" = on-failure ] || fail "control plane Restart is not on-failure"
[ "$(prop KillMode "$cp_unit")" = control-group ] || fail "control plane KillMode is not control-group"
[ "$(prop User "$cp_unit")" = wollipog ] || fail "control plane does not run as wollipog"

step "5. Credential hygiene"
for secret in /etc/wollipog/runner.token /var/lib/wollipog/control-plane/control-plane.db.local-device-token; do
  [ -f "$secret" ] || fail "$secret missing"
  [ "$(stat -c %a "$secret")" = 600 ] || fail "$secret is mode $(stat -c %a "$secret"), expected 600"
  [ "$(stat -c %U "$secret")" = wollipog ] || fail "$secret is owned by $(stat -c %U "$secret"), expected wollipog"
done
runner_token=$(cat /etc/wollipog/runner.token)
! grep -qF "$runner_token" "/etc/systemd/system/$runner_unit" "/etc/systemd/system/$cp_unit" /etc/wollipog/runner.config.json || fail "the runner token appears outside its 0600 file"

step "2. Restart=on-failure heals a SIGKILLed control plane"
old_pid=$(prop MainPID "$cp_unit")
[ "$old_pid" != 0 ] || fail "control plane has no main PID"
kill -9 "$old_pid"
wait_until 40 "systemd to restart the control plane" bash -c "[ \"\$(systemctl show -p MainPID --value $cp_unit)\" != 0 ] && [ \"\$(systemctl show -p MainPID --value $cp_unit)\" != $old_pid ]"
wait_until 60 "the restarted control plane to be healthy" healthy
[ "$(prop NRestarts "$cp_unit")" -ge 1 ] || fail "NRestarts did not increase"
[ "$(systemctl is-active "$runner_unit")" = active ] || fail "runner unit did not survive the control-plane crash"
wait_until 90 "the runner to re-register after the crash" runner_online

step "3. Boot-style ordering: starting only the runner pulls in the control plane"
systemctl stop "$runner_unit" "$cp_unit"
[ "$(systemctl is-active "$cp_unit")" = inactive ] || fail "control plane did not stop"
[ "$(systemctl is-active "$runner_unit")" = inactive ] || fail "runner did not stop"
systemctl start "$runner_unit"
wait_until 60 "both units to be active" bash -c "[ \"\$(systemctl is-active $cp_unit)\" = active ] && [ \"\$(systemctl is-active $runner_unit)\" = active ]"
wait_until 60 "the control plane to be healthy" healthy
wait_until 90 "the runner to register online" runner_online
cp_started=$(prop ExecMainStartTimestampMonotonic "$cp_unit")
runner_started=$(prop ExecMainStartTimestampMonotonic "$runner_unit")
[ "$cp_started" -le "$runner_started" ] || fail "the runner started before the control plane ($runner_started < $cp_started)"

step "4. Graceful stop finishes inside TimeoutStopSec"
timeout_stop=$(prop TimeoutStopUSec "$cp_unit")
started=$(date +%s)
systemctl stop "$cp_unit"
elapsed=$(( $(date +%s) - started ))
echo "stop took ${elapsed}s (TimeoutStopSec=$timeout_stop)"
[ "$elapsed" -lt 30 ] || fail "graceful stop took ${elapsed}s"
[ "$(prop Result "$cp_unit")" = success ] || fail "control plane stop Result=$(prop Result "$cp_unit")"
systemctl start "$cp_unit"
wait_until 60 "the control plane to be healthy again" healthy

step "status and doctor in system mode"
cli service status --system || fail "service status exited non-zero"
cli admin doctor --json | jq -e '.checks | all(.status != "fail")' >/dev/null || { cli admin doctor || true; fail "admin doctor reported a failing check"; }

step "6. uninstall --purge"
cli service uninstall --system --purge --yes --yes-purge --json | jq .
for unit in "$cp_unit" "$runner_unit"; do
  [ ! -e "/etc/systemd/system/$unit" ] || fail "$unit still exists after uninstall"
  [ "$(systemctl is-active "$unit" || true)" != active ] || fail "$unit still active after uninstall"
done
[ ! -e /var/lib/wollipog ] || fail "/var/lib/wollipog survived --purge"
[ ! -e /etc/wollipog ] || fail "/etc/wollipog survived --purge"

echo
echo "PASS: wollipog service install / crash recovery / boot ordering / graceful stop / uninstall on real systemd"
