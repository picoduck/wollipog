import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
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
  /** Runner-owned stdio relay to the scoped media MCP server: a private directory holding exactly
   * `relay.cjs`, `mcp.json` and the listening `media.sock`, plus the node executable that runs it.
   * Both are mounted read-only and their digests enter the namespace policy. */
  relay?: { directory: string; nodeExecutable: string };
  /** Non-secret reviewer-only settings. Secrets never enter these args or either digest. */
  providerEnv?: Readonly<Record<string, string>>;
}
export interface EvidenceReviewNamespace {
  command: "/usr/bin/bwrap";
  providerCommand: string;
  args: string[];
  cwd: "/review";
  env: { HOME: "/reviewer-state"; TMPDIR: "/tmp"; PATH: "/usr/bin:/bin";
    SSL_CERT_FILE?: "/etc/ssl/certs/ca-certificates.crt" } & Record<string, string>;
  /** In-namespace paths of the relay, when one is mounted. */
  relay?: { directory: "/relay"; nodeCommand: "/relay-node"; socket: "/relay/media.sock"; mcpConfig: "/relay/mcp.json" };
  /** Stable audited policy/capability digest; Session identity remains in the exact grant. */
  namespaceSha256: string;
  /** Private runner record binding this particular mount mapping; never a transferable grant. */
  launchSha256: string;
  /** These generic tools cannot be available, including through plugins or sibling MCPs. */
  prohibitedTools: readonly string[];
}
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
/** The only settings a reviewer namespace may carry. An allowlist, so no credential can ride along. */
const REVIEWER_SETTINGS: ReadonlySet<string> = new Set(["MAX_MCP_OUTPUT_TOKENS", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "DISABLE_AUTOUPDATER", "CLAUDE_CODE_DISABLE_AUTO_MEMORY", "DISABLE_TELEMETRY", "MCP_TIMEOUT", "MCP_TOOL_TIMEOUT"]);
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
  const relayDirectory = input.relay ? canonical(input.relay.directory, "directory") : null;
  const relayNode = input.relay ? canonical(input.relay.nodeExecutable, "file") : null;
  if (forbidden.some((root) => mountedRoots.some((mounted) => contains(mounted, root) || contains(root, mounted)) ||
      contains(state, root) || contains(root, state) || contains(root, executable) ||
      relayDirectory && (contains(relayDirectory, root) || contains(root, relayDirectory)) || relayNode && contains(root, relayNode)) ||
      mountedRoots.some((root) => contains(root, state) || relayDirectory && contains(root, relayDirectory)) ||
      relayDirectory && (contains(state, relayDirectory) || contains(relayDirectory, state))) {
    throw new Error("Allowed namespace would expose forbidden oracle/source state.");
  }
  // The relay directory is the only runner state the reviewer sees besides its own HOME. It must
  // be private and hold exactly the relay script, its MCP configuration and the listening socket.
  const relayFiles = relayDirectory ? (() => {
    const info = statSync(relayDirectory);
    const entries = readdirSync(relayDirectory).sort();
    if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 ||
      JSON.stringify(entries) !== JSON.stringify(["mcp.json", "media.sock", "relay.cjs"]) ||
      !lstatSync(resolve(relayDirectory, "media.sock")).isSocket()) throw new Error("Media relay directory is not exactly the private runner relay.");
    return { scriptSha256: sha(readFileSync(canonical(resolve(relayDirectory, "relay.cjs"), "file"), "utf8")),
      mcpConfigSha256: sha(readFileSync(canonical(resolve(relayDirectory, "mcp.json"), "file"), "utf8")),
      nodeSha256: createHash("sha256").update(readFileSync(relayNode!)).digest("hex") };
  })() : null;
  const providerEnv = Object.entries(input.providerEnv ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (providerEnv.some(([key, value]) => !REVIEWER_SETTINGS.has(key) || typeof value !== "string" || value.length > 256 ||
    /[\x00-\x1f\x7f]/u.test(value))) {
    throw new Error("Reviewer settings must be bounded non-secret values.");
  }
  // Exact public runtime configuration needed by native DNS/TLS, never the whole /etc tree.
  // The existing network grant is preserved; this does not turn deny into provider access.
  const networkFiles = input.network === "inherit"
    ? ["/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf", "/etc/ssl/certs/ca-certificates.crt"].map((target) => {
        const source = canonical(realpathSync(target), "file");
        const info = statSync(source);
        if (info.size > 1024 * 1024 || info.uid === process.getuid?.() || (info.mode & 0o022) !== 0 ||
          forbidden.some((root) => contains(root, source))) throw new Error("Network runtime configuration is unsafe or exposes forbidden state.");
        return { source, target, sha256: createHash("sha256").update(readFileSync(source)).digest("hex") };
      }) : [];
  const args = ["--die-with-parent", "--new-session", "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
    "--unshare-cgroup", "--cap-drop", "ALL", "--clearenv"];
  if (input.network === "deny") args.push("--unshare-net");
  // Only immutable installed runtime dependencies are exposed. Do not add --ro-bind / /.
  for (const path of runtimeRoots) {
    const actual = realpathSync(path);
    if (actual === path) args.push("--ro-bind", path, path);
    else args.push("--symlink", actual, path);
  }
  if (networkFiles.length) {
    args.push("--dir", "/etc", "--dir", "/etc/ssl", "--dir", "/etc/ssl/certs");
    for (const file of networkFiles) args.push("--ro-bind", file.source, file.target);
    // Installed TLS runtimes may default to a distro-specific symlink outside this exact
    // mount set. Pin the already verified bundle rather than exposing more /etc state.
    args.push("--setenv", "SSL_CERT_FILE", "/etc/ssl/certs/ca-certificates.crt");
  }
  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/review",
    "--bind", state, "/reviewer-state", "--setenv", "HOME", "/reviewer-state",
    "--setenv", "TMPDIR", "/tmp", "--setenv", "PATH", "/usr/bin:/bin");
  if (!mountedRoots.some((root) => contains(root, executable))) args.push("--ro-bind", executable, "/provider");
  // The relay node is always mapped to one fixed path so mcp.json never depends on host layout.
  if (relayDirectory) args.push("--ro-bind", relayDirectory, "/relay", "--ro-bind", relayNode!, "/relay-node");
  for (const [key, value] of providerEnv) args.push("--setenv", key, value);
  args.push("--chdir", "/review");
  return {
    command: "/usr/bin/bwrap", providerCommand: mountedRoots.some((root) => contains(root, executable)) ? executable : "/provider", args, cwd: "/review",
    env: { HOME: "/reviewer-state", TMPDIR: "/tmp", PATH: "/usr/bin:/bin",
      ...(networkFiles.length ? { SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt" as const } : {}),
      ...Object.fromEntries(providerEnv) },
    ...(relayDirectory ? { relay: { directory: "/relay" as const, nodeCommand: "/relay-node" as const,
      socket: "/relay/media.sock" as const, mcpConfig: "/relay/mcp.json" as const } } : {}),
    // Version 1 digests (no relay, no settings) are unchanged, so earlier proofs keep their identity.
    namespaceSha256: sha(JSON.stringify({ version: 1, executableSha256: createHash("sha256").update(readFileSync(executable)).digest("hex"),
      runtimeRoots: mountedRoots, networkFiles: networkFiles.map(({ target, sha256 }) => ({ target, sha256 })), stateTarget: "/reviewer-state", network: input.network,
      tools: MEDIA_REVIEWER_TOOLS, hostRootMounted: false, projectMounted: false,
      ...(relayFiles ? { relay: relayFiles } : {}), ...(providerEnv.length ? { providerEnv } : {}) })),
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
