import { realpathSync } from "node:fs";
import type {
  AgentDefinition,
  DeployedSkillState,
  SkillLinkRemoval,
  UnmanagedSkillInfo,
} from "@wollipog/protocol";
import { runContextCommand } from "./context-command.js";
import { SKILL_DIRS, skillsStoreRoot, type ReconcileSkillEntry, type ReconcileSkillsResult } from "./skills.js";
import { WSL_SKILLS_HELPER } from "./wsl-skills-helper.js";

const OWNER = /^[0-9a-f]{64}$/u;
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const VALID_STATUS = new Set(["linked", "conflict", "unsupported", "error"]);
const BOOTSTRAP = String.raw`
import os,stat,sys,uuid
owner=sys.argv[1]
if len(owner)!=64 or any(c not in "0123456789abcdef" for c in owner): raise RuntimeError("invalid owner")
home=os.path.realpath(os.environ["HOME"])
fd=os.open(home,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
  for name in (".agent-manager","runner-instances",owner,"native"):
    try: os.mkdir(name,0o700,dir_fd=fd)
    except FileExistsError: pass
    child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
    info=os.fstat(child)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid!=os.geteuid() or info.st_mode&0o022: raise RuntimeError("unsafe helper directory")
    os.close(fd);fd=child
  data=sys.stdin.buffer.read(131073)
  if len(data)>131072 or not data: raise RuntimeError("invalid helper")
  temp=".wollipog-skills-%s.tmp"%uuid.uuid4().hex
  out=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o700,dir_fd=fd)
  try:
    sent=0
    while sent<len(data): sent+=os.write(out,data[sent:])
    os.fsync(out)
  finally: os.close(out)
  os.rename(temp,"wollipog-skills.py",src_dir_fd=fd,dst_dir_fd=fd)
  os.fsync(fd)
  print(os.path.realpath("/proc/self/fd/%d"%fd)+"/wollipog-skills.py")
finally: os.close(fd)
`;

type Run = typeof runContextCommand;
interface HelperOutput {
  deployed?: unknown;
  unmanaged?: unknown;
  removedLinks?: unknown;
  error?: unknown;
}

export interface ReconcileWslSkillsOptions {
  dataDir: string;
  ownerHash: string;
  agents: AgentDefinition[];
  desired: ReconcileSkillEntry[];
  allowRemovals?: boolean;
  log?: (message: string) => void;
  run?: Run;
  /** Test seam; production translates the canonical native store with wslpath. */
  storeRoot?: (distro: string) => Promise<string>;
}

const clean = (value: unknown) => String(value).replace(/[\p{Cc}\p{Cf}]+/gu, " ").trim().slice(0, 500);
const safeDistro = (value: string) => value.length > 0 && value.length <= 256 && value === value.trim() &&
  !/[\\/:*?"<>|\p{Cc}\p{Cf}]/u.test(value) && !value.endsWith(".");

function wslBindings(agents: AgentDefinition[], distro: string) {
  return agents.flatMap((agent) => {
    const relDir = SKILL_DIRS[agent.driver ?? "acp"];
    return agent.id !== "conductor" && agent.context?.kind === "wsl" && agent.context.distro === distro && relDir
      ? [{ agentId: agent.id, driver: agent.driver ?? "acp", relDir }]
      : [];
  });
}

async function bootstrap(distro: string, ownerHash: string, run: Run): Promise<string> {
  const context = { kind: "wsl" as const, distro };
  const result = await run(context, "python3", ["-c", BOOTSTRAP, ownerHash], {
    cwd: "/", stdin: WSL_SKILLS_HELPER, timeoutMs: 30_000, maxBuffer: 64 * 1024,
  });
  const path = result.stdout.trim();
  if (!path.startsWith("/") || path.length > 4096 || /[\0\r\n]/u.test(path)) throw new Error("invalid helper path");
  return path;
}

async function translatedStoreRoot(dataDir: string, distro: string, run: Run): Promise<string> {
  const native = realpathSync(skillsStoreRoot(dataDir));
  const result = await run({ kind: "wsl", distro }, "wslpath", ["-a", native], {
    cwd: "/", timeoutMs: 5_000, maxBuffer: 16 * 1024,
  });
  const path = result.stdout.trim();
  if (!path.startsWith("/") || path.length > 4096 || /[\0\r\n]/u.test(path)) throw new Error("invalid store path");
  return path;
}

function parseOutput(value: HelperOutput, knownAgents: ReadonlySet<string>): ReconcileSkillsResult {
  if (typeof value.error === "string") throw new Error(clean(value.error));
  if (!Array.isArray(value.deployed) || !Array.isArray(value.unmanaged) || !Array.isArray(value.removedLinks) ||
      value.deployed.length > 4096 || value.unmanaged.length > 4096 || value.removedLinks.length > 4096) throw new Error();
  const deployed: DeployedSkillState[] = value.deployed.map((item) => {
    const row = item as DeployedSkillState;
    if (!row || !NAME.test(row.name) || !DIGEST.test(row.digest) || !Array.isArray(row.links) || row.links.length > 4096) throw new Error();
    const links = row.links.map((link) => {
      if (!link || typeof link.agentId !== "string" || !knownAgents.has(link.agentId) || !VALID_STATUS.has(link.status)) throw new Error();
      return { agentId: link.agentId, status: link.status,
        ...(typeof link.detail === "string" && clean(link.detail) ? { detail: clean(link.detail) } : {}) };
    });
    return { name: row.name, digest: row.digest, links,
      ...(typeof row.error === "string" && clean(row.error) ? { error: clean(row.error) } : {}) };
  });
  const unmanaged: UnmanagedSkillInfo[] = value.unmanaged.map((item) => {
    const row = item as UnmanagedSkillInfo;
    if (!row || typeof row.agentId !== "string" || !knownAgents.has(row.agentId) || !NAME.test(row.name)) throw new Error();
    return { agentId: row.agentId, name: row.name,
      ...(typeof row.description === "string" && clean(row.description) ? { description: clean(row.description) } : {}) };
  });
  const removedLinks: SkillLinkRemoval[] = value.removedLinks.map((item) => {
    const row = item as SkillLinkRemoval;
    if (!row || typeof row.path !== "string" || typeof row.reason !== "string") throw new Error();
    return { path: clean(row.path), reason: clean(row.reason) };
  });
  return { deployed, unmanaged, removedLinks };
}

function failedForDistro(distro: string, desired: ReconcileSkillEntry[], agentIds: ReadonlySet<string>,
  detail: string): ReconcileSkillsResult {
  return {
    deployed: desired.flatMap((entry) => {
      const targets = entry.targets.filter((target) => agentIds.has(target.agentId));
      return targets.length ? [{ name: String(entry.name), digest: String(entry.versionDigest),
        links: targets.map((target) => ({ agentId: target.agentId, status: "error" as const,
          detail: `Skill deployment is unavailable inside WSL distro ${distro}.` })), error: detail }] : [];
    }),
    unmanaged: [], removedLinks: [], error: detail,
  };
}

function mergeResults(results: ReconcileSkillsResult[]): ReconcileSkillsResult {
  const deployed = new Map<string, DeployedSkillState>();
  for (const result of results) for (const row of result.deployed) {
    const prior = deployed.get(row.name);
    if (!prior) deployed.set(row.name, { ...row, links: [...row.links] });
    else {
      prior.links.push(...row.links);
      if (row.error) prior.error = prior.error ? `${prior.error} ${row.error}` : row.error;
    }
  }
  const errors = results.flatMap((result) => result.error ? [result.error] : []);
  return { deployed: [...deployed.values()], unmanaged: results.flatMap((result) => result.unmanaged),
    removedLinks: results.flatMap((result) => result.removedLinks),
    ...(errors.length ? { error: errors.join(" ") } : {}) };
}

/** Reconcile every advertised WSL distro serially. One helper process owns each complete link pass,
 * so no host-side path API ever mutates Linux symlinks. */
export async function reconcileWslSkills(options: ReconcileWslSkillsOptions): Promise<ReconcileSkillsResult> {
  if (!OWNER.test(options.ownerHash)) throw new Error("WSL skills require an attested owner hash");
  const run = options.run ?? runContextCommand;
  const distros = [...new Set(options.agents.flatMap((agent) =>
    agent.context?.kind === "wsl" && safeDistro(agent.context.distro) ? [agent.context.distro] : []))];
  const results: ReconcileSkillsResult[] = [];
  for (const distro of distros) {
    const bindings = wslBindings(options.agents, distro);
    if (!bindings.length) continue;
    const agentIds = new Set(bindings.map((binding) => binding.agentId));
    try {
      const [helper, storeRoot] = await Promise.all([
        bootstrap(distro, options.ownerHash, run),
        options.storeRoot ? options.storeRoot(distro) : translatedStoreRoot(options.dataDir, distro, run),
      ]);
      const skills = options.desired.flatMap((entry) => {
        const targets = entry.targets.filter((target) => agentIds.has(target.agentId));
        return targets.length ? [{ name: entry.name, versionDigest: entry.versionDigest, targets }] : [];
      });
      const response = await run({ kind: "wsl", distro }, "python3", [helper], {
        cwd: "/", timeoutMs: 60_000, maxBuffer: 4 * 1024 * 1024,
        stdin: JSON.stringify({ ownerHash: options.ownerHash, distro, storeRoot, bindings, skills,
          allowRemovals: options.allowRemovals === true }),
      });
      results.push(parseOutput(JSON.parse(response.stdout) as HelperOutput, agentIds));
    } catch (error) {
      const detail = `WSL skill reconciliation failed in ${distro}.`;
      options.log?.(`${detail} ${clean(error)}`);
      results.push(failedForDistro(distro, options.desired, agentIds, detail));
    }
  }
  return mergeResults(results);
}

/** Replace native placeholder states for WSL agents with authoritative in-distro results. */
export function mergeWslSkillsResult(
  native: ReconcileSkillsResult,
  wsl: ReconcileSkillsResult,
  agents: AgentDefinition[],
): ReconcileSkillsResult {
  const wslAgents = new Set(agents.flatMap((agent) => agent.context?.kind === "wsl" ? [agent.id] : []));
  const rows = new Map(native.deployed.map((row) => [row.name, {
    ...row,
    links: row.links.filter((link) => !wslAgents.has(link.agentId)),
  }]));
  for (const incoming of wsl.deployed) {
    const row = rows.get(incoming.name);
    if (!row) rows.set(incoming.name, { ...incoming, links: [...incoming.links] });
    else {
      row.links.push(...incoming.links);
      if (incoming.error) row.error = row.error ? `${row.error} ${incoming.error}` : incoming.error;
    }
  }
  const errors = [native.error, wsl.error].filter((value): value is string => Boolean(value));
  return {
    deployed: [...rows.values()],
    unmanaged: [...native.unmanaged, ...wsl.unmanaged],
    removedLinks: [...native.removedLinks, ...wsl.removedLinks],
    ...(errors.length ? { error: errors.join(" ") } : {}),
  };
}
