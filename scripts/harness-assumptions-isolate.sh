#!/usr/bin/env bash
set -euo pipefail
umask 022

# Stage a read-only copy of this checkout for an unprivileged user that runs unreviewed harness
# releases. The user has no sudo, cron or at, cannot write the copy, the installs, its Node or
# anything on the runner's PATH, and cannot traverse the runner's home or the tool cache, so it
# cannot reach the job token, later steps' action files or the cache.
user="$1"
root="$2"
test "${GITHUB_ACTIONS:-}" = true
test "$(id -un)" != "$user"
case "$root" in /opt/*) ;; *) echo "isolation root must be under /opt" >&2; exit 1 ;; esac

if ! id -u "$user" > /dev/null 2>&1; then
  sudo useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$user"
fi
if id -nG "$user" | tr ' ' '\n' | grep -qxE 'sudo|admin|adm|docker|root'; then
  echo "$user must not belong to a privileged group" >&2
  exit 1
fi
for deny in /etc/cron.deny /etc/at.deny; do
  sudo touch "$deny"
  sudo grep -qx "$user" "$deny" || echo "$user" | sudo tee -a "$deny" > /dev/null
done
sudo rm -rf -- "$root"
sudo install -d -o "$(id -un)" -g "$(id -gn)" -m 755 "$root" "$root/repo" "$root/install" "$root/node" "$root/node/bin"
sudo install -d -o root -g root -m 755 "$root/work"
git archive --format=tar HEAD | tar -x -C "$root/repo"
(cd "$root/repo" && pnpm install --frozen-lockfile --prefer-offline)
# pnpm and tar may keep permissive modes; nothing in the copy stays writable by other users.
chmod -R go-w "$root/repo"
# The hosted tool cache is writable by every user, so the probe user gets its own Node copy and is
# denied the cache, like the runner's home, with ACL entries that affect no other user.
install -m 755 "$(readlink -f "$(command -v node)")" "$root/node/bin/node"
command -v setfacl > /dev/null || sudo DEBIAN_FRONTEND=noninteractive apt-get install -y acl
sudo setfacl -m "u:$user:---" "$HOME"
# Preinstalled trees under /opt (tool cache, pipx and others) include world-writable entries.
for entry in /opt/*; do
  if [ "$entry" != "$root" ]; then sudo setfacl -m "u:$user:---" "$entry"; fi
done

as_user() { sudo -n -u "$user" -- "$@"; }
IFS=: read -r -a search <<< "$PATH"
# Remove write access, for this user alone, from anything else on the runner's PATH it can write.
for dir in "${search[@]}"; do
  [ -d "$dir" ] || continue
  while IFS= read -r -d '' path; do
    echo "Denying $user write access to $path"
    sudo setfacl -m "u:$user:rX" "$path"
  done < <(as_user find "$dir" -maxdepth 1 -writable -print0 2> /dev/null || true)
done
as_user test -r "$root/repo/package.json"
as_user "$root/node/bin/node" --version > /dev/null
for path in "$root/repo" "$root/repo/scripts" "$root/repo/node_modules" "$root/install" "$root/work" "$root/node/bin" "$root/node/bin/node"; do
  if as_user test -w "$path"; then echo "$user can write $path ($(stat -c '%a %U:%G' "$path"))" >&2; exit 1; fi
done
writable="$(find "$root/repo" ! -type l -perm /o+w -print -quit)"
if [ -n "$writable" ]; then echo "$user can write $writable" >&2; exit 1; fi
# Nothing the runner user later executes from PATH may be writable by the probe user.
for dir in "${search[@]}"; do
  [ -d "$dir" ] || continue
  writable="$(as_user find "$dir" -maxdepth 1 -writable -print -quit 2> /dev/null || true)"
  if [ -n "$writable" ]; then echo "$user can write $writable on the runner's PATH" >&2; exit 1; fi
done
if as_user test -x "$HOME"; then echo "$user can traverse $HOME" >&2; exit 1; fi
if [ -d /opt/hostedtoolcache ] && as_user test -x /opt/hostedtoolcache; then echo "$user can traverse /opt/hostedtoolcache" >&2; exit 1; fi
if as_user sudo -n true > /dev/null 2>&1; then echo "$user can use sudo" >&2; exit 1; fi
# Diagnostic only: harness preparation may grant bubblewrap namespaces later; probes report the result.
if [ -x /usr/bin/bwrap ]; then
  if smoke="$(as_user /usr/bin/bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --unshare-pid -- /bin/true 2>&1)"; then
    echo "bubblewrap smoke as $user: ok"
  else
    echo "bubblewrap smoke as $user: failed: ${smoke:0:200}"
  fi
fi
echo "Isolated $user: read-only $root/repo, private Node, no sudo, cron or at, no access to $HOME or the tool cache"
