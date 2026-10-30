#!/usr/bin/env bash
set -euo pipefail

# Stage a read-only copy of this checkout for an unprivileged user that runs unreviewed harness
# releases. The user has no sudo, cannot write the copy or the installs, and cannot traverse the
# runner's home, so it cannot reach the job token, later steps' action files or the cache.
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
sudo rm -rf -- "$root"
sudo install -d -o "$(id -un)" -g "$(id -gn)" -m 755 "$root" "$root/repo" "$root/install"
sudo install -d -o root -g root -m 755 "$root/work"
git archive --format=tar HEAD | tar -x -C "$root/repo"
(cd "$root/repo" && pnpm install --frozen-lockfile --prefer-offline)
# Deny traversal of the runner's home to this user specifically; other users are unaffected.
command -v setfacl > /dev/null || sudo DEBIAN_FRONTEND=noninteractive apt-get install -y acl
sudo setfacl -m "u:$user:---" "$HOME"

as_user() { sudo -n -u "$user" -- "$@"; }
as_user test -r "$root/repo/package.json"
as_user test -x "$(command -v node)"
for path in "$root/repo" "$root/repo/scripts" "$root/repo/node_modules" "$root/install" "$root/work"; do
  if as_user test -w "$path"; then echo "$user can write $path" >&2; exit 1; fi
done
if as_user test -x "$HOME"; then echo "$user can traverse $HOME" >&2; exit 1; fi
if as_user sudo -n true > /dev/null 2>&1; then echo "$user can use sudo" >&2; exit 1; fi
echo "Isolated $user: read-only $root/repo, no sudo, no access to $HOME"
