import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

/** Single-purpose media reviewer namespace. Unlike the ordinary write sandbox this never
 * mounts the host root or project. Creation is preparation, not permission to run a provider.
 * A managed Session adapter must preserve accounting, current admission and exact MCP scope. */
export interface EvidenceReviewNamespaceInput {
  /** Fresh runner-owned directory containing only the specifically approved provider state.
   * It must not contain transcripts, source generators, project files or expected truth. */
  stateDirectory: string;
  /** Installed audited executable; bind only this file if it is outside the runtime roots. */
  providerExecutable: string;
  /** Operator-owned roots excluded from this reviewer; metadata never exposes their content. */
  forbiddenRoots: string[];
  /** Exact existing network grant. This builder cannot turn deny into inherit. */
  network: "deny" | "inherit";
}
export interface EvidenceReviewNamespace {
  command: "/usr/bin/bwrap";
  args: string[];
  cwd: "/review";
  env: { HOME: "/reviewer-state"; TMPDIR: "/tmp"; PATH: "/usr/bin:/bin" };
  /** Stable audited policy/capability digest; Session identity remains in the exact grant. */
  namespaceSha256: string;
  /** Private runner record binding this particular mount mapping; never a transferable grant. */
  launchSha256: string;
  /** These generic tools cannot be available, including through plugins or sibling MCPs. */
  prohibitedTools: readonly string[];
}
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const contains = (parent: string, child: string) => {
  const rel = relative(parent, child);
  return rel === "" || rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
};
function canonical(path: string, kind: "file" | "directory"): string {
  if (!isAbsolute(path) || path !== resolve(path) || /[\x00-\x1f\x7f]/u.test(path)) throw new Error("Namespace path must be canonical and absolute.");
  const actual = realpathSync(path);
  if (actual !== path || lstatSync(path).isSymbolicLink() ||
    !(kind === "file" ? statSync(path).isFile() : statSync(path).isDirectory())) throw new Error("Namespace path is not a direct canonical entry.");
  return actual;
}
export function prepareEvidenceReviewNamespace(input: EvidenceReviewNamespaceInput): EvidenceReviewNamespace {
  if (process.platform !== "linux" || process.getuid?.() === 0) throw new Error("Narrowed media namespace requires a non-root native Linux runner.");
  if (!input || !["deny", "inherit"].includes(input.network) || !Array.isArray(input.forbiddenRoots) ||
      !input.forbiddenRoots.length || input.forbiddenRoots.length > 32) throw new Error("Forbidden source/oracle roots and existing network policy are required.");
  canonical("/usr/bin/bwrap", "file");
  const state = canonical(input.stateDirectory, "directory");
  const executable = canonical(input.providerExecutable, "file");
  const runtimeRoots = ["/usr", "/lib", "/lib64", "/bin", "/sbin"].filter((path) => {
    try { return statSync(path).isDirectory(); } catch { return false; }
  });
  const mountedRoots = runtimeRoots.map((path) => realpathSync(path));
  const forbidden = input.forbiddenRoots.map((path) => canonical(path, "directory"));
  if (forbidden.some((root) => mountedRoots.some((mounted) => contains(mounted, root) || contains(root, mounted)) ||
      contains(state, root) || contains(root, state) || contains(root, executable)) ||
      mountedRoots.some((root) => contains(root, state))) throw new Error("Allowed namespace would expose forbidden oracle/source state.");
  const args = ["--die-with-parent", "--new-session", "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
    "--unshare-cgroup", "--cap-drop", "ALL", "--clearenv"];
  if (input.network === "deny") args.push("--unshare-net");
  // Only immutable installed runtime dependencies are exposed. Do not add --ro-bind / /.
  for (const path of runtimeRoots) {
    const actual = realpathSync(path);
    if (actual === path) args.push("--ro-bind", path, path);
    else args.push("--symlink", actual, path);
  }
  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/review",
    "--bind", state, "/reviewer-state", "--setenv", "HOME", "/reviewer-state",
    "--setenv", "TMPDIR", "/tmp", "--setenv", "PATH", "/usr/bin:/bin");
  if (!mountedRoots.some((root) => contains(root, executable))) args.push("--ro-bind", executable, "/provider");
  args.push("--chdir", "/review");
  return {
    command: "/usr/bin/bwrap", args, cwd: "/review",
    env: { HOME: "/reviewer-state", TMPDIR: "/tmp", PATH: "/usr/bin:/bin" },
    namespaceSha256: sha(JSON.stringify({ version: 1, executableSha256: createHash("sha256").update(readFileSync(executable)).digest("hex"),
      runtimeRoots: mountedRoots, stateTarget: "/reviewer-state", network: input.network,
      tools: MEDIA_REVIEWER_TOOLS, hostRootMounted: false, projectMounted: false })),
    launchSha256: sha(JSON.stringify({ version: 1, executable, state, args })),
    prohibitedTools: ["Read", "Bash", "Grep", "Glob", "WebFetch", "WebSearch", "Task", "Agent", "Skill"],
  };
}

/** Provider adapter must additionally enforce strict MCP configuration with only these exact
 * purpose-bound handlers. No generic management tools, file resources or extra server discovery. */
export const MEDIA_REVIEWER_TOOLS = ["review_video_evidence_frame", "submit_video_evidence_verdict"] as const;
export function mediaOnlyToolSet(actual: readonly string[]): boolean {
  return actual.length === MEDIA_REVIEWER_TOOLS.length &&
    new Set(actual).size === actual.length && MEDIA_REVIEWER_TOOLS.every((tool) => actual.includes(tool));
}
