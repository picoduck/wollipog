/** The remote shell receives only quoted runner arguments, never a plaintext credential. */
import { execFile } from "node:child_process";
import { devNull } from "node:os";

/** Remove/shutdown must leave time for cleanup within the service's 30s stop budget. */
export const SSH_TEARDOWN_TIMEOUT_MS = 20_000;

let stdinNullSupport: Promise<boolean> | undefined;
export function localSshSupportsStdinNull(): Promise<boolean> {
  // Parse only, without connecting or loading user configuration. IgnoreUnknown is deliberately
  // untouched: overriding its first-value-wins string would mask portable user SSH settings.
  return stdinNullSupport ??= new Promise(resolve => {
    execFile("ssh", ["-G", "-F", devNull, "-o", "StdinNull=no", "localhost"],
      { timeout: 2_000, maxBuffer: 64 * 1024, windowsHide: true }, error => resolve(!error));
  });
}

function quote(value: string): string { return "'" + value.replace(/'/g, "'\\''") + "'"; }

/** Only fixed diagnostic fields cross into control-plane logs; never forward arbitrary stderr. */
export function sshLaunchDiagnostic(line: string): Record<string, string> | null {
  const mode = /^\[runner\] ssh_launch mode=(delegated-scope|process-scan)(?: |$)/u.exec(line);
  if (mode) return { event: "ssh_runner_launch", mode: mode[1]! };
  const containment = /^\[runner\] provider_process_containment proofStandard=(linux-cgroup-v2|marker-parent-links) reason=([a-z-]+)$/u.exec(line);
  if (containment) return { event: "ssh_runner_containment", proofStandard: containment[1]!, reason: containment[2]! };
  if (line.startsWith("[runner] ssh_launch_failed reason=containment-unavailable;")) {
    return { event: "ssh_runner_launch_failed", reason: "containment-unavailable" };
  }
  return null;
}

export function supervisedSshCommand(command: string, unit: string): string {
  if (!/^wollipog-ssh-[a-zA-Z0-9-]+\.scope$/u.test(unit)) throw new Error("invalid SSH runner scope");
  const script = `
unit=$1
shift
export WOLLIPOG_SSH_SUPERVISED=1
unset WOLLIPOG_SSH_REQUIRE_CGROUP
if [ "$(uname -s)" = Linux ]; then
  export XDG_RUNTIME_DIR="\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  if command -v systemd-run >/dev/null 2>&1 && command -v systemctl >/dev/null 2>&1 &&
     systemctl --user show-environment >/dev/null 2>&1; then
    export WOLLIPOG_SSH_REQUIRE_CGROUP=1
    # Before v254 scope commands were not expanded. Later releases allow disabling expansion.
    case "$(systemd-run --help)" in
      *--expand-environment*) set -- --expand-environment=no -- "$@" ;;
      *) set -- -- "$@" ;;
    esac
    echo '[runner] ssh_launch mode=delegated-scope' >&2
    exec systemd-run --user --scope --collect --quiet --description='Wollipog SSH Runner' \\
      --unit="$unit" --property=Delegate=yes "$@"
  fi
  echo '[runner] ssh_launch mode=process-scan reason=user-manager-unavailable; abandoned ownership may require operator recovery or a host reboot' >&2
fi
exec "$@"
`;
  // Always use sh explicitly: the account's login shell may be zsh, bash, or fish.
  return "exec sh -c " + quote(script) + " sh " + quote(unit) + " sh -c " + quote("exec " + command);
}
