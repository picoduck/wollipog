/**
 * The command a Codex command-sandbox probe runs (#3843). The probe decides whether Codex's own
 * sandbox is replaced by the runner's boundary, so nothing a session can write may decide its
 * outcome: not a `true` earlier on PATH, not a preloaded library, not a program or a link the
 * session can replace. It is a system `printf`, invoked by its absolute candidate path, that prints
 * a sentinel; only a run that never printed it and failed with bubblewrap's own namespace error
 * reads as a sandbox that could not start.
 *
 * Trust is established for the whole path the kernel will follow, not its endpoints (CR-3.1):
 * every directory, every symlink (intermediate directory links included) and the final file must be
 * root's and writable by no one else, and none may lie under a file system the runner's boundary
 * mounts afresh. Then only root can change what that path names between this check and the exec,
 * and the caller additionally refuses a path that crosses a root the runner's boundary makes
 * writable. The resolution runs again at every launch. Any doubt skips the probe; it never refuses
 * a launch.
 */
import { lstatSync, readlinkSync } from "node:fs";
import { posix } from "node:path";

export const CODEX_SANDBOX_PROBE_SENTINEL = "WOLLIPOG_CODEX_SANDBOX_PROBE_STARTED";

/** Environment overrides for the probe: a fixed PATH and no loader injection. `null` unsets. */
export const CODEX_SANDBOX_PROBE_ENV: Readonly<Record<string, string | null>> = {
  PATH: "/usr/bin:/bin",
  LD_PRELOAD: null,
  LD_LIBRARY_PATH: null,
  LD_AUDIT: null,
};

const CANDIDATES = ["/usr/bin/printf", "/bin/printf"];
const TRUSTED_TARGET_PREFIXES = ["/usr/", "/bin/"];
/** Linux's own limit on symlinks followed in one resolution is 40; a system printf needs a few. */
const MAX_SYMLINK_HOPS = 16;
/** Mounted afresh inside the runner's bubblewrap boundary (and `/proc/self` names a different
 * process there), so what the runner validates under them is not what the probe would run. */
const REMOUNTED_IN_SANDBOX = ["/proc", "/dev", "/tmp", "/sys"];

export interface ProbeEntry {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  uid: number;
  mode: number;
}
export interface ProbeFileSystem {
  /** The entry itself, never what a symlink names. */
  lstat(path: string): ProbeEntry;
  readlink(path: string): string;
}

const nativeFileSystem: ProbeFileSystem = {
  lstat: (path) => lstatSync(path),
  readlink: (path) => readlinkSync(path, "utf8"),
};

/** Root's, and no one else can write it. Group bits also carry a POSIX ACL's mask. */
function rootOwnedUnwritable(entry: ProbeEntry): boolean {
  return entry.uid === 0 && (entry.mode & 0o022) === 0;
}

/** Resolve `path` component by component, as the kernel does, validating every entry visited:
 * each directory entered and each symlink followed must be root's and unwritable by others, and
 * the final entry a root-owned executable regular file under `/usr` or `/bin`. Returns every path
 * visited, or null on any doubt: a missing entry, a loop or too many links, an untrusted entry, or
 * a final file elsewhere. `..` climbs only to a directory this walk already validated. */
export function resolveTrustedExecutable(path: string, fs: ProbeFileSystem = nativeFileSystem): { target: string; visited: string[] } | null {
  try {
    if (!posix.isAbsolute(path)) return null;
    const root = fs.lstat("/");
    if (!root.isDirectory() || !rootOwnedUnwritable(root)) return null;
    const visited = ["/"];
    let pending = path.split("/").filter(Boolean);
    let current = "/";
    let hops = 0;
    while (pending.length) {
      const name = pending.shift()!;
      if (name === ".") continue;
      if (name === "..") {
        current = posix.dirname(current);
        continue;
      }
      const next = posix.join(current, name);
      if (REMOUNTED_IN_SANDBOX.some((mount) => next === mount || next.startsWith(`${mount}/`))) return null;
      const entry = fs.lstat(next);
      if (!rootOwnedUnwritable(entry) && !(entry.isSymbolicLink() && entry.uid === 0)) return null;
      visited.push(next);
      if (entry.isSymbolicLink()) {
        // A link's own mode bits mean nothing; its owner and its (validated) directory decide who
        // can replace it. Its target is spliced in and walked like any other path.
        if (++hops > MAX_SYMLINK_HOPS) return null;
        const target = fs.readlink(next);
        if (!target) return null;
        if (posix.isAbsolute(target)) current = "/";
        pending = [...target.split("/").filter(Boolean), ...pending];
        continue;
      }
      if (pending.length) {
        if (!entry.isDirectory()) return null;
        current = next;
        continue;
      }
      if (!entry.isFile() || (entry.mode & 0o111) === 0) return null;
      if (!TRUSTED_TARGET_PREFIXES.some((prefix) => next.startsWith(prefix))) return null;
      return { target: next, visited };
    }
    return null;
  } catch {
    return null;
  }
}

/** The probe argv and every path its resolution crosses, or null when no candidate passes, in which
 * case the probe does not run. Resolved afresh on every call: there is no cache to go stale. The
 * candidate path itself is what runs, never its target, so a multicall binary such as BusyBox picks
 * its applet from the name it was invoked by (CR-2.1). */
export function codexSandboxProbeCommand(fs: ProbeFileSystem = nativeFileSystem): { argv: string[]; visited: string[] } | null {
  for (const candidate of CANDIDATES) {
    const resolved = resolveTrustedExecutable(candidate, fs);
    if (resolved) return { argv: [candidate, CODEX_SANDBOX_PROBE_SENTINEL], visited: resolved.visited };
  }
  return null;
}

/** Whether a writable root of the enclosing boundary contains `path`, which would let the session
 * replace what it names. */
export function probeExecutableWritable(path: string, writableRoots: readonly string[]): boolean {
  return writableRoots.some((root) => {
    const relative = posix.relative(root, path);
    return relative === "" || (!relative.startsWith("..") && !posix.isAbsolute(relative));
  });
}

/** bubblewrap's own refusal, as the whole of one line. */
const BWRAP_NAMESPACE_DENIED = /^bwrap: (?:No permissions to create new namespace|.*unprivileged user namespaces)/;

/** The refusal is the probe's ENTIRE diagnostic output: once the Codex CLI's own `WARNING:` notices
 * are set aside (measured: `codex sandbox` prints one about PATH aliases first), exactly one line
 * remains and it is bubblewrap's. Anything else, including the refusal beside other output, is not
 * read as a namespace denial. The classification also requires that the command never printed the
 * sentinel, so a command's output cannot be mistaken for it. */
function onlyBwrapNamespaceDenial(stderr: unknown): boolean {
  if (typeof stderr !== "string") return false;
  const lines = stderr.split("\n").map((line) => line.trimEnd()).filter((line) => line && !line.startsWith("WARNING: "));
  return lines.length === 1 && BWRAP_NAMESPACE_DENIED.test(lines[0]!);
}

export type CodexSandboxProbeOutcome =
  | { outcome: "started" }
  | { outcome: "failed"; namespaceDenied: boolean; exitCode: number }
  | { outcome: "inconclusive" };

/** Classify the probe's exit, stdout and stderr. The command ran exactly when the sentinel is on
 * stdout; a run that both printed it and failed, or exited 0 without it, proves nothing. */
export function classifyCodexSandboxProbe(exitCode: unknown, stdout: unknown, stderr: unknown): CodexSandboxProbeOutcome {
  if (typeof exitCode !== "number") return { outcome: "inconclusive" };
  const started = typeof stdout === "string" && stdout.includes(CODEX_SANDBOX_PROBE_SENTINEL);
  if (exitCode === 0) return started ? { outcome: "started" } : { outcome: "inconclusive" };
  if (started) return { outcome: "inconclusive" };
  return { outcome: "failed", exitCode, namespaceDenied: onlyBwrapNamespaceDenial(stderr) };
}
