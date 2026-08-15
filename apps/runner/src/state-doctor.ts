import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import type { AgentContext, AgentDriverKind } from "@wollipog/protocol";
import { adoptLegacyWslExecutionIsolationState } from "./execution-isolation.js";
import { adoptLegacyCheckpointRefs, withGitExecutionContext } from "./git-ops.js";
import { runContextCommand } from "./context-command.js";
import type { SessionMeta } from "./session-store.js";

const OWNER_FILE = ".wollipog-runner-owner-v1.json";
const ACTIVE_LEASE = ".wollipog-runner-active-v1.lock";
const MAX_JSON_BYTES = 256 * 1024;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

type DoctorCommand = "inventory" | "adopt-checkpoints" | "adopt-provider-state" |
  "quarantine-wsl" | "quarantine-conductor";

interface DoctorArgs {
  command: DoctorCommand;
  dataDir: string;
  sessionId?: string;
  distro?: string;
  acknowledged: boolean;
}

function parseDoctorArgs(argv: string[]): DoctorArgs {
  const marker = argv.indexOf("--state-doctor");
  const command = argv[marker + 1] as DoctorCommand | undefined;
  if (!command || !["inventory", "adopt-checkpoints", "adopt-provider-state", "quarantine-wsl", "quarantine-conductor"].includes(command)) {
    throw new Error("usage: --state-doctor <inventory|adopt-checkpoints|adopt-provider-state|quarantine-wsl|quarantine-conductor> --data-dir <path> [--session-id <id>] [--wsl-distro <name>] [--ack-all-legacy-runners-stopped]");
  }
  let dataDir: string | undefined;
  let sessionId: string | undefined;
  let distro: string | undefined;
  let acknowledged = false;
  const seen = new Set<string>();
  for (let i = marker + 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) throw new Error("state-doctor argument is missing");
    if (seen.has(arg)) throw new Error(`duplicate state-doctor argument: ${arg}`);
    seen.add(arg);
    if (arg === "--ack-all-legacy-runners-stopped") acknowledged = true;
    else if (arg === "--data-dir") dataDir = argv[++i];
    else if (arg === "--session-id") sessionId = argv[++i];
    else if (arg === "--wsl-distro") distro = argv[++i];
    else throw new Error(`unknown state-doctor argument: ${arg}`);
    if (arg !== "--ack-all-legacy-runners-stopped" && argv[i] === undefined) {
      throw new Error(`${arg} requires a value`);
    }
  }
  if (!dataDir) throw new Error("--data-dir is required");
  if (sessionId && !SESSION_ID.test(sessionId)) throw new Error("--session-id is invalid");
  if (distro && (distro.trim() !== distro || !distro || distro.includes("\0"))) throw new Error("--wsl-distro is invalid");
  return { command, dataDir: resolve(dataDir), sessionId, distro, acknowledged };
}

function protectedJson<T>(path: string): T {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_JSON_BYTES) throw new Error(`unsafe state metadata: ${basename(path)}`);
    return JSON.parse(readFileSync(fd, "utf8")) as T;
  } finally {
    closeSync(fd);
  }
}

function offlineOwner(dataDir: string): string {
  if (existsSync(join(dataDir, ACTIVE_LEASE))) {
    throw new Error("runner data directory has an active or unrecovered lease; stop every runner and resolve the lease before offline maintenance");
  }
  const owner = protectedJson<{ version?: unknown; ownerHash?: unknown }>(join(dataDir, OWNER_FILE));
  if (owner.version !== 2 || typeof owner.ownerHash !== "string" || !/^[a-f0-9]{64}$/u.test(owner.ownerHash)) {
    throw new Error("runner data directory does not contain stable attested owner metadata");
  }
  return owner.ownerHash;
}

function sessionMeta(dataDir: string, sessionId: string): { path: string; meta: SessionMeta } {
  const path = join(dataDir, "sessions", sessionId, "meta.json");
  const meta = protectedJson<SessionMeta>(path);
  if (meta.sessionId !== sessionId) throw new Error("session metadata id does not match its directory");
  return { path, meta };
}

function replaceMeta(path: string, meta: SessionMeta): void {
  const temp = `${path}.state-doctor-${process.pid}-${randomUUID()}`;
  writeFileSync(temp, `${JSON.stringify(meta, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  renameSync(temp, path);
}

function requireMutation(args: DoctorArgs): void {
  if (!args.acknowledged) {
    throw new Error("mutation requires --ack-all-legacy-runners-stopped; legacy runners do not honor attested state locks");
  }
}

function legacyConductorFiles(dataDir: string): string[] {
  const dir = join(dataDir, "conductor");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mcp.json"))
    .map((entry) => join(dir, entry.name))
    .sort();
}

function storedMetas(dataDir: string): { metas: SessionMeta[]; unreadable: number } {
  const root = join(dataDir, "sessions");
  if (!existsSync(root)) return { metas: [], unreadable: 0 };
  const metas: SessionMeta[] = [];
  let unreadable = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SESSION_ID.test(entry.name)) continue;
    try { metas.push(sessionMeta(dataDir, entry.name).meta); } catch { unreadable++; }
  }
  return { metas, unreadable };
}

async function inventoryWsl(distro: string): Promise<{ available: boolean; legacyRoots: number }> {
  const context = { kind: "wsl" as const, distro };
  try {
    const result = await runContextCommand(context, "sh", ["-c",
      'n=0; for p in "$HOME/.agent-manager/provider-state" "$HOME/.agent-manager/worktrees"; do [ ! -e "$p" ] || n=$((n+1)); done; printf "%s" "$n"',
    ], { cwd: "/", timeoutMs: 8_000, maxBuffer: 1024 });
    return { available: true, legacyRoots: Number.parseInt(result.stdout.trim(), 10) || 0 };
  } catch {
    return { available: false, legacyRoots: 0 };
  }
}

export async function runStateDoctor(argv = process.argv): Promise<void> {
  const args = parseDoctorArgs(argv);
  const ownerHash = offlineOwner(args.dataDir);
  if (args.command === "inventory") {
    const { metas, unreadable } = storedMetas(args.dataDir);
    const wsl = args.distro ? await inventoryWsl(args.distro) : undefined;
    const report = {
      version: 1,
      ownerId: createHash("sha256").update(ownerHash).digest("hex").slice(0, 16),
      legacyCheckpointSessions: metas.filter((meta) => meta.checkpointRefVersion === undefined && meta.worktreePath).length,
      legacyWslWorktrees: metas.filter((meta) => meta.context.kind === "wsl" && meta.worktreePath && !meta.worktreePath.includes("/runner-instances/")).length,
      legacyWslProviderSessions: metas.filter((meta) => meta.context.kind === "wsl" && meta.providerStateVersion !== 3).length,
      legacyConductorConfigs: legacyConductorFiles(args.dataDir).length,
      unreadableSessionMetadata: unreadable,
      ...(wsl ? { wsl } : {}),
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  requireMutation(args);
  if (args.command === "quarantine-conductor") {
    const files = legacyConductorFiles(args.dataDir);
    const quarantineId = randomUUID();
    const target = join(args.dataDir, "state-quarantine", quarantineId, "conductor");
    mkdirSync(target, { recursive: true, mode: 0o700 });
    const manifest = files.map((source, index) => ({
      itemId: createHash("sha256").update(basename(source)).digest("hex"),
      storedAs: `${String(index + 1).padStart(4, "0")}.mcp.json`,
    }));
    // Publish the secret-free rollback map before the first move. A crash may leave a partial
    // quarantine, but never anonymous files whose original names can no longer be identified.
    writeFileSync(join(target, "manifest.json"), `${JSON.stringify({ version: 1, items: manifest }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    for (const [index, source] of files.entries()) {
      const item = manifest[index];
      if (!item) throw new Error("conductor quarantine manifest changed unexpectedly");
      renameSync(source, join(target, item.storedAs));
    }
    process.stdout.write(`${JSON.stringify({ quarantined: files.length, quarantineId })}\n`);
    return;
  }
  if (args.command === "quarantine-wsl") {
    if (!args.distro) throw new Error("quarantine-wsl requires --wsl-distro");
    const quarantineId = randomUUID();
    const result = await runContextCommand({ kind: "wsl", distro: args.distro }, "sh", ["-c",
      'set -eu; q="$HOME/.agent-manager/state-quarantine/$1"; umask 077; mkdir -p -- "$q"; n=0; for name in provider-state worktrees; do src="$HOME/.agent-manager/$name"; if [ -e "$src" ]; then mv -- "$src" "$q/$name"; n=$((n+1)); fi; done; printf "%s" "$n"',
      "state-doctor", quarantineId,
    ], { cwd: "/", timeoutMs: 30_000, maxBuffer: 1024 });
    process.stdout.write(`${JSON.stringify({ quarantinedRoots: Number.parseInt(result.stdout.trim(), 10) || 0, quarantineId })}\n`);
    return;
  }
  if (!args.sessionId) throw new Error(`${args.command} requires --session-id`);
  const { path, meta } = sessionMeta(args.dataDir, args.sessionId);
  if (args.command === "adopt-checkpoints") {
    if (meta.checkpointRefVersion !== undefined) throw new Error("session checkpoint refs are already owner-scoped");
    const count = await withGitExecutionContext(meta.context, () =>
      adoptLegacyCheckpointRefs(meta.repoPath, meta.sessionId, ownerHash));
    replaceMeta(path, { ...meta, checkpointRefVersion: 2, updatedAt: Date.now() });
    process.stdout.write(`${JSON.stringify({ adoptedCheckpointEntries: count, sourcePreserved: true })}\n`);
    return;
  }
  if (meta.context.kind !== "wsl") throw new Error("adopt-provider-state requires a WSL session");
  if (meta.providerStateVersion === 3) throw new Error("session provider state is already owner-scoped");
  const outcome = await adoptLegacyWslExecutionIsolationState(
    meta.context,
    meta.driver as AgentDriverKind,
    meta.sessionId,
    ownerHash,
  );
  replaceMeta(path, { ...meta, providerStateVersion: 3, updatedAt: Date.now() });
  process.stdout.write(`${JSON.stringify({ providerState: outcome, sourcePreserved: true })}\n`);
}
