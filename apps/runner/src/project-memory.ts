import { agentContextKey, supportsClaudeProjectMemory, type AgentDefinition } from "@wollipog/protocol";
import { createHash } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, posix, resolve } from "node:path";
import type { SessionMeta } from "./session-store.js";
import { runContextCommand } from "./context-command.js";

export function projectMemoryKey(meta: Pick<SessionMeta, "projectMemory">): string {
  return JSON.stringify(meta.projectMemory ?? null);
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** A new store never imports an un-attributable legacy shared directory. Legacy memory and
 * private/shared partitions are retained untouched when the policy changes. */
export async function prepareProjectMemory(
  meta: SessionMeta, stateDir: string, ownerHash?: string,
  contextCommand: typeof runContextCommand = runContextCommand,
): Promise<string | undefined> {
  if (!meta.projectMemory || meta.driver !== "claude-code") return undefined;
  const unavailable = projectMemoryUnavailable(meta);
  if (unavailable) {
    if (meta.projectMemory.sharing === "shared") throw new Error(unavailable);
    return undefined;
  }
  const project = digest(meta.projectMemory.projectId ?? `unassigned:${meta.repoPath}`);
  const account = digest(meta.providerCredentialHome ?? meta.env.CLAUDE_CONFIG_DIR ??
    join(meta.env.HOME ?? homedir(), ".claude"));
  const parts = ["project-memory", "claude", project,
    ...(meta.projectMemory.sharing === "shared" ? ["shared"] : ["accounts", account])];
  if (meta.context.kind === "native") {
    let directory = stateDir;
    for (const part of parts) {
      directory = join(directory, part);
      try { await mkdir(directory, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const entry = await lstat(directory);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Project memory directory is redirected or is not a directory.");
    }
    return directory;
  }
  if (meta.context.kind !== "wsl" || !ownerHash || !/^[a-f0-9]{64}$/.test(ownerHash)) {
    throw new Error("Project memory selection is unavailable in this context. Use a host Claude session.");
  }
  const result = await contextCommand(meta.context, "sh", ["-c", `
set -eu
owner="$1"
shift
set -- .agent-manager runner-instances "$owner" "$@"
root="$HOME"
for part do
  root="$root/$part"
  [ ! -L "$root" ] || { echo 'Project memory directory is redirected' >&2; exit 1; }
  if [ ! -d "$root" ]; then mkdir -m 700 -- "$root"; fi
  [ -d "$root" ] || exit 1
done
printf '%s' "$root"
`, "wollipog-project-memory", ownerHash, ...parts], { cwd: "/", timeoutMs: 5_000 });
  const directory = result.stdout;
  if (!posix.isAbsolute(directory) || directory.includes("\n")) throw new Error("Invalid project memory directory returned by WSL.");
  return directory;
}

/** Claude applies only the last --settings. Merge that exact effective document so hooks,
 * permissions and operator settings survive; then append our explicit directory override. */
export function withClaudeProjectMemory(args: readonly string[], directory: string | undefined, cwd = process.cwd()): string[] {
  if (!directory) return [...args];
  let settings: Record<string, unknown> = {};
  let effectiveSettings: string | undefined;
  const result: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    let value: string | undefined;
    if (arg === "--settings") value = args[++index];
    else if (arg.startsWith("--settings=")) value = arg.slice("--settings=".length);
    else { result.push(arg); continue; }
    if (!value) throw new Error("Missing Claude settings argument.");
    effectiveSettings = value;
  }
  if (effectiveSettings !== undefined) {
    const value = effectiveSettings;
    const file = resolve(cwd, value);
    if (!value.trimStart().startsWith("{") && statSync(file).size > 96 * 1024) {
      throw new Error("Claude settings are too large for project memory selection. Reduce the launch settings below 96 KiB.");
    }
    const parsed: unknown = JSON.parse(value.trimStart().startsWith("{") ? value : readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid Claude settings document.");
    settings = parsed as Record<string, unknown>;
  }
  const document = JSON.stringify({ ...settings, autoMemoryDirectory: directory });
  if (Buffer.byteLength(document) > 96 * 1024) throw new Error("Claude settings are too large for project memory selection. Reduce the launch settings below 96 KiB.");
  return [...result, "--settings", document];
}


/** WSL operator settings paths belong to the distro, not the Windows runner. Native managed
 * hook paths stay intact until prepareClaudeHookArgs selects the current in-memory document. */
export async function prepareProjectMemoryArgs(meta: SessionMeta): Promise<string[]> {
  if (meta.context.kind !== "wsl") return meta.args;
  const args = [...meta.args];
  let index = -1; let value: string | undefined; let pair = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--settings") { index = i + 1; value = args[++i]; pair = true; }
    else if (args[i]?.startsWith("--settings=")) { index = i; value = args[i]!.slice(11); pair = false; }
  }
  if (index < 0 || value?.trimStart().startsWith("{")) return args;
  if (!value) throw new Error("Missing Claude settings argument.");
  const result = await runContextCommand(meta.context, "head", ["-c", "98305", "--", value],
    { cwd: meta.worktreePath ?? meta.repoPath, timeoutMs: 5_000 });
  if (Buffer.byteLength(result.stdout) > 96 * 1024) throw new Error("Claude settings are too large for project memory selection. Reduce the launch settings below 96 KiB.");
  args[index] = pair ? result.stdout : `--settings=${result.stdout}`;
  return args;
}

/** Unsupported default cases retain native memory instead of breaking an existing session. */
export function projectMemoryUnavailable(meta: SessionMeta): string | undefined {
  if (!meta.projectMemory || meta.driver !== "claude-code") return undefined;
  if (meta.executionTarget && meta.executionTarget.adapter !== "host") {
    return "Project memory policy is unavailable for this execution target. Native memory behavior remains unchanged; use a host Claude session to apply the policy.";
  }
  if (!supportsClaudeProjectMemory(meta.agentVersion)) {
    return "Project memory policy requires Claude Code 2.1.284 or newer. Native memory behavior remains unchanged; update Claude Code and refresh the runner's agents to apply the policy.";
  }
  return undefined;
}

/** Native Windows cmd shims cannot carry arbitrary JSON (% expansion and the 8 KiB limit).
 * Keep launch settings in a driver-private file outside the shared writable memory partition. */
export class NativeProjectMemorySettings {
  private root?: string;
  args(args: readonly string[], directory: string | undefined, cwd: string): string[] {
    const merged = withClaudeProjectMemory(args, directory, cwd);
    if (!directory) return merged;
    this.root ??= mkdtempSync(join(tmpdir(), "wollipog-memory-settings-"));
    const file = join(this.root, "settings.json");
    writeFileSync(file, merged.at(-1)!, { mode: 0o600 });
    return [...merged.slice(0, -1), file];
  }
  dispose(): void {
    if (this.root) rmSync(this.root, { recursive: true, force: true });
    this.root = undefined;
  }
}


/** Compare process configuration, not a saved policy that an unsupported process cannot apply. */
export function effectiveProjectMemoryKey(meta: SessionMeta): string {
  if (!meta.projectMemory || meta.driver !== "claude-code" ||
      meta.projectMemory.sharing === "separate" && projectMemoryUnavailable(meta)) return "native";
  return projectMemoryKey(meta);
}


/** Adoption has no agent id. Match the recorded binary and context, including after managed
 * hook arguments were appended; ambiguous discovery never invents a capability version. */
export function projectMemoryAgentVersion(meta: Pick<SessionMeta, "agentId" | "adopted" | "command" | "driver" | "context">,
  agents: readonly AgentDefinition[]): string | undefined {
  if (meta.agentId) return agents.find(agent => agent.id === meta.agentId)?.version;
  if (!meta.adopted) return undefined;
  const matches = agents.filter(agent => agent.command === meta.command &&
    (agent.driver ?? "acp") === meta.driver && agentContextKey(agent.context) === agentContextKey(meta.context));
  const versions = new Set(matches.map(agent => agent.version));
  return versions.size === 1 ? matches[0]?.version : undefined;
}
