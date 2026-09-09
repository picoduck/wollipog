#!/usr/bin/env bash
# End-to-end check of `wollipog service upgrade` against real releases on a disposable Linux host.
#
# Installs release FROM headlessly with the published installer (runner, control plane, dashboard
# bundle), runs it under systemd in system mode, upgrades to release TO with the installed CLI,
# then forces a rollback and proves the previous generation comes back. Everything is real: GitHub
# release metadata and publisher digests, SHA256SUMS, the release executables answering --version,
# systemd, and the loopback admin API. Run only as root on a disposable host (a CI VM); it refuses a
# host that already has Wollipog units or data.
#
# Inputs (environment):
#   WOLLIPOG_E2E_TO_TAG      release to upgrade to (required, vX.Y.Z[-suffix])
#   WOLLIPOG_E2E_FROM_TAG    release to install first (default: TO, upgraded with --force)
#   WOLLIPOG_E2E_CONFIRM=1   acknowledge that this installs and removes system units on THIS host
#   WOLLIPOG_E2E_USER        unprivileged account that runs the installer (default: SUDO_USER)
#   GH_TOKEN                 needed for draft releases and private repositories
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
to_tag=${WOLLIPOG_E2E_TO_TAG:-}
from_tag=${WOLLIPOG_E2E_FROM_TAG:-$to_tag}
port=${WOLLIPOG_E2E_PORT:-4390}
blocked_port=$((port + 1))
cp_unit=wollipog-control-plane.service
runner_unit=wollipog-runner.service
install_user=${WOLLIPOG_E2E_USER:-${SUDO_USER:-}}

fail() { echo "FAIL: $*" >&2; exit 1; }
step() { echo; echo "== $*"; }

[ "$(id -u)" -eq 0 ] || fail "run as root (sudo) on a disposable host"
[ -d /run/systemd/system ] || fail "systemd is not running as PID 1 here"
[ "${WOLLIPOG_E2E_CONFIRM:-}" = 1 ] || fail "set WOLLIPOG_E2E_CONFIRM=1 to acknowledge this installs and removes system units on THIS host"
[ -n "$to_tag" ] || fail "set WOLLIPOG_E2E_TO_TAG"
for tag in "$from_tag" "$to_tag"; do
  printf '%s\n' "$tag" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' || fail "tag $tag must look like v1.2.3"
done
[ -n "$install_user" ] && [ "$install_user" != root ] || fail "set WOLLIPOG_E2E_USER to the unprivileged account that runs the installer"
user_home=$(getent passwd "$install_user" | cut -d: -f6)
[ -d "$user_home" ] || fail "no home directory for $install_user"
for unit in "$cp_unit" "$runner_unit"; do
  state=$(systemctl show -p LoadState --value "$unit" 2>/dev/null || true)
  [ "$state" = not-found ] || fail "$unit is already known to systemd (LoadState=$state)"
  for dir in /etc/systemd/system /run/systemd/system /usr/local/lib/systemd/system /usr/lib/systemd/system /lib/systemd/system; do
    for entry in "$dir/$unit" "$dir/$unit.d"; do
      [ ! -e "$entry" ] && [ ! -L "$entry" ] || fail "$entry exists"
    done
  done
done
[ ! -e /var/lib/wollipog ] && [ ! -e /etc/wollipog ] || fail "/var/lib/wollipog or /etc/wollipog already exists"
for name in "$user_home/.local/bin/wollipog" "$user_home/.local/bin/wollipog-runner" "$user_home/.local/bin/wollipog-control-plane" "$user_home/.local/share/wollipog"; do
  [ ! -e "$name" ] || fail "$name already exists; this script only runs on a host without Wollipog installed"
done
for tool in jq curl gh sha256sum python3; do command -v "$tool" >/dev/null || fail "$tool is required"; done

cli="$user_home/.local/bin/wollipog"
prop() { systemctl show -p "$1" --value "$2"; }
wait_until() { # wait_until <seconds> <description> <command...>
  local deadline=$(( $(date +%s) + $1 )); local what=$2; shift 2
  until "$@"; do
    [ "$(date +%s)" -lt "$deadline" ] || fail "timed out waiting for $what"
    sleep 1
  done
}
healthy() { curl -fsS --max-time 3 "http://127.0.0.1:$port/healthz" 2>/dev/null | jq -e '.ok == true' >/dev/null; }
admin_status() { "$cli" admin status --json; }
runner_online() { admin_status 2>/dev/null | jq -e '.runners.items | any(.status == "online")' >/dev/null; }
version_of() { "$1" --version | tr -d '\r' | head -n1; }
digest_of() { sha256sum "$1" | awk '{print $1}'; }
as_user() { sudo -u "$install_user" -H env "PATH=$PATH" ${GH_TOKEN:+GH_TOKEN="$GH_TOKEN"} "$@"; }

blocker_pid=""
cleanup() {
  set +e
  echo
  echo "== Cleanup"
  [ -z "$blocker_pid" ] || kill "$blocker_pid" 2>/dev/null
  systemctl stop "$runner_unit" "$cp_unit" 2>/dev/null
  systemctl disable "$runner_unit" "$cp_unit" 2>/dev/null
  rm -f "/etc/systemd/system/$runner_unit" "/etc/systemd/system/$cp_unit"
  systemctl daemon-reload
  rm -rf /var/lib/wollipog /etc/wollipog
  rm -rf "$user_home/.local/share/wollipog" "$user_home/.config/wollipog"
  rm -f "$user_home"/.local/bin/wollipog "$user_home"/.local/bin/wollipog.previous \
    "$user_home"/.local/bin/wollipog-runner "$user_home"/.local/bin/wollipog-runner.previous \
    "$user_home"/.local/bin/wollipog-control-plane "$user_home"/.local/bin/wollipog-control-plane.previous \
    "$user_home"/.local/bin/agent-manager-runner "$user_home"/.local/bin/agent-manager-runner.previous
}
trap cleanup EXIT

step "1. Install $from_tag headlessly as $install_user"
as_user sh "$repo/scripts/install-runner.sh" --control-plane --release "$from_tag"
[ -x "$cli" ] || fail "installer did not produce $cli"
from_version=${from_tag#v}
[ "$(version_of "$cli")" = "$from_version" ] || fail "installed CLI reports $(version_of "$cli"), expected $from_version"
[ "$(version_of "$user_home/.local/bin/wollipog-control-plane")" = "$from_version" ] || fail "installed control plane reports the wrong version"
# The service account must be able to traverse the account's home to reach the executables and bundle.
chmod o+rx "$user_home" "$user_home/.local" "$user_home/.local/bin" "$user_home/.local/share" "$user_home/.local/share/wollipog"

step "2. service install --system from the installed release"
install_json=$("$cli" service install --system --port "$port" --json) || { echo "$install_json"; journalctl -u "$cp_unit" -u "$runner_unit" --no-pager -n 60 || true; fail "service install exited non-zero"; }
echo "$install_json" | jq -c '{health, units}'
echo "$install_json" | jq -e '.health.controlPlane.ok == true and .health.runnerOnline == true' >/dev/null || fail "install did not report a healthy control plane with the runner online"
[ "$(admin_status | jq -r .appVersion)" = "$from_version" ] || fail "control plane reports $(admin_status | jq -r .appVersion) over the admin API, expected $from_version"
cp_path=$(systemctl show -p ExecStart --value "$cp_unit" | sed -n 's/.*path=\([^ ;]*\).*/\1/p')
runner_path=$(systemctl show -p ExecStart --value "$runner_unit" | sed -n 's/.*path=\([^ ;]*\).*/\1/p')
[ -x "$cp_path" ] && [ -x "$runner_path" ] || fail "could not resolve unit executables ($cp_path, $runner_path)"
echo "units run $cp_path and $runner_path"
config_before=$(cat /etc/wollipog/control-plane.env /etc/wollipog/runner.config.json /etc/wollipog/runner.token | sha256sum)
db_before=$(digest_of /var/lib/wollipog/control-plane/control-plane.db)

step "3. service upgrade --release $to_tag"
to_version=${to_tag#v}
force=""
[ "$from_tag" != "$to_tag" ] || force="--force"
upgrade_json=$("$cli" service upgrade --system --release "$to_tag" --yes --json $force) || { echo "$upgrade_json"; journalctl -u "$cp_unit" -u "$runner_unit" --no-pager -n 60 || true; fail "service upgrade exited non-zero"; }
echo "$upgrade_json" | jq -c '{upgraded, release, previous, aliases, webDist}'
echo "$upgrade_json" | jq -e --arg tag "$to_tag" '.upgraded == true and .release == $tag' >/dev/null || fail "upgrade did not report success for $to_tag"
[ "$(version_of "$cp_path")" = "$to_version" ] || fail "control plane executable reports $(version_of "$cp_path"), expected $to_version"
[ "$(version_of "$runner_path")" = "$to_version" ] || fail "runner executable reports $(version_of "$runner_path"), expected $to_version"
[ "$(version_of "$cli")" = "$to_version" ] || fail "the wollipog CLI alias was not refreshed (reports $(version_of "$cli"))"
[ -f "$cp_path.previous" ] && [ -f "$runner_path.previous" ] || fail "previous executables were not retained"
[ "$(version_of "$cp_path.previous")" = "$from_version" ] || fail "retained previous control plane reports $(version_of "$cp_path.previous"), expected $from_version"
web_dist=$(sed -n 's/^WOLLIPOG_WEB_DIST="\(.*\)"$/\1/p' /etc/wollipog/control-plane.env)
[ -f "$web_dist/index.html" ] || fail "web bundle missing at $web_dist after upgrade"
[ -d "$web_dist.previous" ] || fail "previous web bundle was not retained"
wait_until 60 "the upgraded control plane to be healthy" healthy
[ "$(admin_status | jq -r .appVersion)" = "$to_version" ] || fail "admin API reports $(admin_status | jq -r .appVersion) after upgrade, expected $to_version"
wait_until 90 "the runner to be online after the upgrade" runner_online
[ "$(cat /etc/wollipog/control-plane.env /etc/wollipog/runner.config.json /etc/wollipog/runner.token | sha256sum)" = "$config_before" ] || fail "configuration or credentials changed during upgrade"
[ "$(digest_of /var/lib/wollipog/control-plane/control-plane.db)" = "$db_before" ] || echo "note: database bytes changed (expected: the control plane writes on start)"
[ -f /etc/wollipog/runner.token ] && [ "$(stat -c %a /etc/wollipog/runner.token)" = 600 ] || fail "runner token mode changed"

step "4. Forced rollback: the new control plane cannot bind its port"
cp_digest_before=$(digest_of "$cp_path"); runner_digest_before=$(digest_of "$runner_path")
python3 -m http.server "$blocked_port" --bind 127.0.0.1 >/dev/null 2>&1 &
blocker_pid=$!
wait_until 10 "the port blocker to listen" bash -c "curl -fsS --max-time 1 http://127.0.0.1:$blocked_port/ >/dev/null 2>&1"
sed -i "s/^CONTROL_PLANE_PORT=.*/CONTROL_PLANE_PORT=$blocked_port/" /etc/wollipog/control-plane.env
set +e
rollback_out=$("$cli" service upgrade --system --release "$to_tag" --yes --force --json 2>&1)
rollback_code=$?
set -e
echo "$rollback_out" | tail -n 3
[ "$rollback_code" -eq 1 ] || fail "forced rollback should exit 1, got $rollback_code"
echo "$rollback_out" | jq -e '.error | test("rolled back to the previous executables")' >/dev/null || fail "upgrade did not report a rollback"
[ "$(digest_of "$cp_path")" = "$cp_digest_before" ] || fail "rollback did not restore the control plane executable bytes"
[ "$(digest_of "$runner_path")" = "$runner_digest_before" ] || fail "rollback did not restore the runner executable bytes"
[ "$(version_of "$cp_path")" = "$to_version" ] || fail "restored control plane reports $(version_of "$cp_path"), expected $to_version"
kill "$blocker_pid"; blocker_pid=""
sed -i "s/^CONTROL_PLANE_PORT=.*/CONTROL_PLANE_PORT=$port/" /etc/wollipog/control-plane.env
systemctl restart "$cp_unit"
wait_until 60 "the control plane to be healthy after the rollback rehearsal" healthy
systemctl restart "$runner_unit"
wait_until 90 "the runner to be online again" runner_online
[ "$(admin_status | jq -r .appVersion)" = "$to_version" ] || fail "admin API reports $(admin_status | jq -r .appVersion) after rollback, expected $to_version"

step "5. Idempotence: upgrading to the current release is a no-op"
noop_json=$("$cli" service upgrade --system --release "$to_tag" --yes --json)
echo "$noop_json" | jq -e '.upgraded == false' >/dev/null || fail "a second upgrade to the same release was not a no-op"

step "6. uninstall --purge"
"$cli" service uninstall --system --purge --yes --yes-purge --json | jq -c '{removed: .removed, purged: .purged}' || true
[ ! -e /var/lib/wollipog ] && [ ! -e /etc/wollipog ] || fail "purge left data or configuration behind"

echo
echo "PASS: headless install of $from_tag, upgrade to $to_tag, forced rollback, no-op re-upgrade, purge"
