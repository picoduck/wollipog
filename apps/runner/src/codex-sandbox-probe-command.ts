/**
 * The command a Codex command-sandbox probe runs (#3843). The probe decides whether Codex's own
 * sandbox is replaced by the runner's boundary, so nothing a session can write may decide its
 * outcome: not a `true` earlier on PATH, not a preloaded library, not a program the session can
 * replace. It is a system `printf`, resolved by absolute path and checked once, that prints a
 * sentinel; only a run that never printed it and failed with bubblewrap's own namespace error
 * reads as a sandbox that could not start.
 */
import { realpathSync, statSync } from "node:fs";
import { dirname, posix } from "node:path";

export const CODEX_SANDBOX_PROBE_SENTINEL = "WOLLIPOG_CODEX_SANDBOX_PROBE_STARTED";

/** Environment overrides for the probe: a fixed PATH and no loader injection. `null` unsets. */
export const CODEX_SANDBOX_PROBE_ENV: Readonly<Record<string, string | null>> = {
  PATH: "/usr/bin:/bin",
  LD_PRELOAD: null,
  LD_LIBRARY_PATH: null,
  LD_AUDIT: null,
};

const CANDIDATES = ["/usr/bin/printf", "/bin/printf"];
const TRUSTED_PREFIXES = ["/usr/", "/bin/"];

export interface ProbeFileStat { isFile(): boolean; isDirectory(): boolean; uid: number; mode: number }
export interface ProbeFileSystem { realpath(path: string): string; stat(path: string): ProbeFileStat }

const nativeFileSystem: ProbeFileSystem = { realpath: (path) => realpathSync(path), stat: (path) => statSync(path) };

/** Root owns it and every directory above it, and no one else can write any of them. */
function trustedSystemExecutable(path: string, fs: ProbeFileSystem): string | null {
  try {
    const real = fs.realpath(path);
    if (!TRUSTED_PREFIXES.some((prefix) => real.startsWith(prefix))) return null;
    const file = fs.stat(real);
    if (!file.isFile() || file.uid !== 0 || (file.mode & 0o022) !== 0 || (file.mode & 0o111) === 0) return null;
    for (let directory = dirname(real); ; directory = dirname(directory)) {
      const entry = fs.stat(directory);
      if (!entry.isDirectory() || entry.uid !== 0 || (entry.mode & 0o022) !== 0) return null;
      if (directory === "/") break;
    }
    return real;
  } catch {
    return null;
  }
}

let resolved: string | null | undefined;

/** The probe argv, or null when no trusted system `printf` exists, in which case no probe result
 * may enable the fallback. Resolved once per runner process unless a file system is injected. */
export function codexSandboxProbeCommand(fs?: ProbeFileSystem): string[] | null {
  const executable = fs
    ? CANDIDATES.map((path) => trustedSystemExecutable(path, fs)).find((path) => path !== null) ?? null
    : resolved !== undefined ? resolved
      : (resolved = CANDIDATES.map((path) => trustedSystemExecutable(path, nativeFileSystem)).find((path) => path !== null) ?? null);
  return executable ? [executable, CODEX_SANDBOX_PROBE_SENTINEL] : null;
}

/** Whether a writable root of the enclosing boundary contains the probe executable, which would
 * let the session replace it. */
export function probeExecutableWritable(executable: string, writableRoots: readonly string[]): boolean {
  return writableRoots.some((root) => {
    const relative = posix.relative(root, executable);
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
