/** Stabilized ACP Registry v1 ingestion and runner-local installed-agent probing. */

import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  AcpRegistryDistributionKind,
  AcpRegistryMetadata,
  AgentDefinition,
} from "@wollipog/protocol";
import { resolveNative, run, type ResolvedLaunch } from "./resolve.js";
import { parseVersion } from "./discover.js";

export const ACP_REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const MAX_REGISTRY_BYTES = 2 * 1024 * 1024;
const CACHE_MAX_AGE_MS = 60 * 60_000;
const FETCH_TIMEOUT_MS = 8_000;
const ID = /^[a-z][a-z0-9-]*$/;

type BinaryTarget = { archive: string; cmd: string; args: string[] };
type PackageTarget = { package: string; args: string[] };
interface RegistryEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  repository?: string;
  website?: string;
  authors?: string[];
  license?: string;
  icon?: string;
  distribution: {
    binary?: Record<string, BinaryTarget>;
    npx?: PackageTarget;
    uvx?: PackageTarget;
  };
}

interface RegistryIndex { version: string; agents: RegistryEntry[] }

export interface RegistryDiscoveryOptions {
  dataDir: string;
  allowedAgentIds: string[];
  platform?: NodeJS.Platform;
  arch?: string;
  refresh?: boolean;
  fetchImpl?: typeof fetch;
  resolveCommand?: typeof resolveNative;
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedString(value: unknown, max = 2_048): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}

function stringArray(value: unknown, maxItems = 32): string[] | undefined {
  if (!Array.isArray(value) || value.length > maxItems) return undefined;
  const out = value.filter((item): item is string => typeof item === "string" && item.length <= 1_024);
  return out.length === value.length ? out : undefined;
}

function httpsUrl(value: unknown): string | undefined {
  const text = boundedString(value, 4_096);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function parsePackage(value: unknown): PackageTarget | undefined {
  const source = record(value);
  const pkg = boundedString(source?.package, 512);
  const args = source?.args === undefined ? [] : stringArray(source.args, 64);
  return pkg && !pkg.startsWith("-") && !/[\s\0]/.test(pkg) && args ? { package: pkg, args } : undefined;
}

function safeArchiveCommand(value: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  return !normalized.startsWith("/") && !/^[A-Za-z]:/.test(normalized) &&
    normalized.split("/").every((part) => part !== "..");
}

function parseBinary(value: unknown): Record<string, BinaryTarget> | undefined {
  const source = record(value);
  if (!source) return undefined;
  const out: Record<string, BinaryTarget> = {};
  for (const [target, raw] of Object.entries(source)) {
    const item = record(raw);
    const archive = httpsUrl(item?.archive);
    const cmd = boundedString(item?.cmd, 1_024);
    const args = item?.args === undefined ? [] : stringArray(item.args, 64);
    if (archive && cmd && safeArchiveCommand(cmd) && args) out[target] = { archive, cmd, args };
  }
  return Object.keys(out).length ? out : undefined;
}

/** Strict-enough runtime projection: unknown top-level fields are ignored for forward compatibility,
 * while every value retained by the runner is bounded and independently validated. */
export function parseRegistryIndex(value: unknown): RegistryIndex {
  const source = record(value);
  const version = boundedString(source?.version, 64);
  if (!version || !/^1\.[0-9]+\.[0-9]+/.test(version) || !Array.isArray(source?.agents)) {
    throw new Error("ACP Registry response is not a supported v1 index");
  }
  if (source.agents.length > 2_000) throw new Error("ACP Registry response has too many agents");
  const agents: RegistryEntry[] = [];
  const ids = new Set<string>();
  for (const raw of source.agents) {
    const item = record(raw);
    if (!item) continue;
    const id = boundedString(item.id, 128);
    const name = boundedString(item.name, 256);
    const adapterVersion = boundedString(item.version, 128);
    const description = boundedString(item.description, 4_096);
    const dist = record(item.distribution);
    if (!id || !ID.test(id) || ids.has(id) || !name || !adapterVersion ||
      !/^\d+\.\d+\.\d+/.test(adapterVersion) || !description || !dist) continue;
    const binary = parseBinary(dist.binary);
    const npx = parsePackage(dist.npx);
    const uvx = parsePackage(dist.uvx);
    if (!binary && !npx && !uvx) continue;
    const repository = httpsUrl(item.repository);
    const website = httpsUrl(item.website);
    const authors = stringArray(item.authors);
    const license = boundedString(item.license, 128);
    const icon = httpsUrl(item.icon);
    ids.add(id);
    agents.push({
      id,
      name,
      version: adapterVersion,
      description,
      distribution: { ...(binary ? { binary } : {}), ...(npx ? { npx } : {}), ...(uvx ? { uvx } : {}) },
      ...(repository ? { repository } : {}),
      ...(website ? { website } : {}),
      ...(authors ? { authors } : {}),
      ...(license ? { license } : {}),
      ...(icon ? { icon } : {}),
    });
  }
  return { version, agents };
}

function platformTarget(platform: NodeJS.Platform, arch: string): string | null {
  const os = platform === "win32" ? "windows" : platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : null;
  const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : null;
  return os && cpu ? `${os}-${cpu}` : null;
}

function displayArg(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./\\-]+$/.test(value) ? value : JSON.stringify(value);
}

function preview(command: string, args: string[]): string {
  return [command, ...args].map(displayArg).join(" ");
}

interface SelectedDistribution {
  kind: AcpRegistryDistributionKind;
  command: string;
  /** Arguments for the package runner or extracted command shown in the disabled preview. */
  commandArgs: string[];
  /** Arguments accepted by an already-installed adapter binary. */
  adapterArgs: string[];
  preview: string;
  packageSpec?: string;
}

function selectDistribution(entry: RegistryEntry, platform: NodeJS.Platform, arch: string): SelectedDistribution | null {
  if (entry.distribution.npx) {
    const target = entry.distribution.npx;
    return {
      kind: "npx",
      command: "npx",
      commandArgs: ["--yes", target.package, ...target.args],
      adapterArgs: target.args,
      preview: preview("npx", ["--yes", target.package, ...target.args]),
      packageSpec: target.package,
    };
  }
  if (entry.distribution.uvx) {
    const target = entry.distribution.uvx;
    return {
      kind: "uvx",
      command: "uvx",
      commandArgs: [target.package, ...target.args],
      adapterArgs: target.args,
      preview: preview("uvx", [target.package, ...target.args]),
      packageSpec: target.package,
    };
  }
  const key = platformTarget(platform, arch);
  const target = key ? entry.distribution.binary?.[key] : undefined;
  if (!target) return null;
  return {
    kind: "binary",
    command: target.cmd,
    commandArgs: target.args,
    adapterArgs: target.args,
    preview: `archive ${target.archive} -> ${preview(target.cmd, target.args)}`,
  };
}

const PRIORITY_BINARY_HINTS: Record<string, string[]> = {
  opencode: ["opencode"],
  cursor: ["cursor-agent"],
  gemini: ["gemini"],
};

interface RegistryApproval {
  agentId: string;
  schemaVersion: string;
  adapterVersion: string;
  fingerprint: string;
  approvedAt: number;
}

interface RegistryApprovalFile { version: 1; approvals: RegistryApproval[] }

function approvalPath(dataDir: string): string {
  return join(dataDir, "registry", "approvals-v1.json");
}

function exactPackageVersion(selected: SelectedDistribution, adapterVersion: string): boolean {
  const spec = selected.packageSpec;
  if (!spec || selected.kind === "binary") return false;
  return spec.endsWith(`@${adapterVersion}`) || spec.endsWith(`==${adapterVersion}`);
}

function approvalFingerprint(
  entry: RegistryEntry,
  schemaVersion: string,
  selected: SelectedDistribution | null,
): string | null {
  if (!selected || !exactPackageVersion(selected, entry.version)) return null;
  return createHash("sha256").update(JSON.stringify([
    schemaVersion,
    entry.id,
    entry.version,
    selected.kind,
    selected.command,
    selected.commandArgs,
  ])).digest("hex");
}

function validApproval(value: unknown): value is RegistryApproval {
  const item = record(value);
  return Boolean(item && typeof item.agentId === "string" && ID.test(item.agentId) &&
    typeof item.schemaVersion === "string" && /^1\.\d+\.\d+/.test(item.schemaVersion) &&
    typeof item.adapterVersion === "string" && /^\d+\.\d+\.\d+/.test(item.adapterVersion) &&
    typeof item.fingerprint === "string" && /^[a-f0-9]{64}$/.test(item.fingerprint) &&
    typeof item.approvedAt === "number" && Number.isFinite(item.approvedAt));
}

async function readApprovals(dataDir: string): Promise<RegistryApproval[]> {
  try {
    const parsed = JSON.parse(await readFile(approvalPath(dataDir), "utf8")) as unknown;
    const source = record(parsed);
    if (source?.version !== 1 || !Array.isArray(source.approvals) || source.approvals.length > 64) return [];
    return source.approvals.filter(validApproval);
  } catch {
    return [];
  }
}

async function writeApprovals(dataDir: string, approvals: RegistryApproval[]): Promise<void> {
  const dir = join(dataDir, "registry");
  const path = approvalPath(dataDir);
  await mkdir(dir, { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const body: RegistryApprovalFile = { version: 1, approvals: approvals.slice(0, 64) };
  await writeFile(temp, `${JSON.stringify(body, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
}

async function resolveInstalled(
  entry: RegistryEntry,
  selected: SelectedDistribution | null,
  resolveCommand: typeof resolveNative,
): Promise<{ launch: ResolvedLaunch; bin: string } | null> {
  // A manifest is metadata, not launch authority. Only conformance-ranked ids have a runner-owned
  // PATH identity, and an incompatible platform distribution remains unavailable even if a
  // same-named command happens to exist.
  if (!selected) return null;
  for (const bin of PRIORITY_BINARY_HINTS[entry.id] ?? []) {
    const resolved = await resolveCommand(bin);
    if (resolved) return { launch: resolved.launch, bin };
  }
  return null;
}

function metadata(
  entry: RegistryEntry,
  schemaVersion: string,
  selected: SelectedDistribution | null,
  installStatus: AcpRegistryMetadata["installStatus"],
): AcpRegistryMetadata {
  return {
    id: entry.id,
    schemaVersion,
    adapterVersion: entry.version,
    description: entry.description,
    transport: "stdio",
    distribution: selected?.kind ?? "binary",
    installPreview: selected?.preview ?? "No compatible distribution for this runner platform",
    installStatus,
    authentication: "required-live-verification",
    ...(entry.repository ? { repository: entry.repository } : {}),
    ...(entry.website ? { website: entry.website } : {}),
    ...(entry.authors ? { authors: entry.authors } : {}),
    ...(entry.license ? { license: entry.license } : {}),
    ...(entry.icon ? { icon: entry.icon } : {}),
  };
}

export async function registryEntriesToAgents(
  index: RegistryIndex,
  allowedAgentIds: string[],
  options: Pick<RegistryDiscoveryOptions, "platform" | "arch" | "resolveCommand"> & {
    approvedFingerprints?: ReadonlySet<string>;
  } = {},
): Promise<AgentDefinition[]> {
  const allowed = new Set(allowedAgentIds);
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const resolveCommand = options.resolveCommand ?? resolveNative;
  const chosen = index.agents.filter((entry) => allowed.has(entry.id));
  return Promise.all(chosen.map(async (entry): Promise<AgentDefinition> => {
    const selected = selectDistribution(entry, platform, arch);
    const installed = await resolveInstalled(entry, selected, resolveCommand);
    const fingerprint = approvalFingerprint(entry, index.version, selected);
    const approved = !installed && fingerprint != null && options.approvedFingerprints?.has(fingerprint) === true;
    const packageRunner = approved && selected ? await resolveCommand(selected.command) : null;
    let version: string | undefined;
    if (installed) {
      const result = await run(installed.launch.command, [...installed.launch.args, "--version"], { timeoutMs: 5_000 });
      if (result.code === 0) version = parseVersion(result.stdout || result.stderr);
    }
    const launchArgs = installed
      ? [...installed.launch.args, ...(selected?.adapterArgs ?? [])]
      : packageRunner
        ? [...packageRunner.launch.args, ...(selected?.commandArgs ?? [])]
        : selected?.commandArgs ?? [];
    const installStatus: AcpRegistryMetadata["installStatus"] = installed
      ? "installed"
      : approved
        ? "approved"
        : !selected
          ? "unsupported-platform"
          : fingerprint
            ? "approval-required"
            : "manual-only";
    return {
      id: entry.id,
      name: entry.name,
      command: installed?.launch.command ?? packageRunner?.launch.command ?? selected?.command ?? `registry:${entry.id}`,
      args: launchArgs,
      env: {},
      driver: "acp",
      acpTransport: "stdio",
      context: { kind: "native" },
      version: version ?? entry.version,
      available: Boolean(installed || packageRunner),
      authStatus: "unknown",
      source: "registry",
      ...(installed ? { bin: installed.bin } : {}),
      registry: metadata(entry, index.version, selected, installStatus),
    };
  }));
}

async function readCache(path: string): Promise<RegistryIndex | null> {
  try {
    const raw = await readFile(path, "utf8");
    if (Buffer.byteLength(raw) > MAX_REGISTRY_BYTES) return null;
    return parseRegistryIndex(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function fetchIndex(fetchImpl: typeof fetch): Promise<{ index: RegistryIndex; raw: string }> {
  const response = await fetchImpl(ACP_REGISTRY_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`ACP Registry returned HTTP ${response.status}`);
  const expectedOrigin = new URL(ACP_REGISTRY_URL).origin;
  if (!response.url) throw new Error("ACP Registry response did not report its final URL");
  const responseUrl = new URL(response.url);
  if (responseUrl.protocol !== "https:" || responseUrl.origin !== expectedOrigin) {
    throw new Error("ACP Registry redirected outside the trusted CDN origin");
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_REGISTRY_BYTES) throw new Error("ACP Registry response is too large");
  if (!response.body) throw new Error("ACP Registry response had no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REGISTRY_BYTES) {
      await reader.cancel("ACP Registry response is too large");
      throw new Error("ACP Registry response is too large");
    }
    chunks.push(value);
  }
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
  return { index: parseRegistryIndex(JSON.parse(raw)), raw };
}

async function loadRegistryIndex(options: RegistryDiscoveryOptions): Promise<RegistryIndex> {
  const cacheDir = join(options.dataDir, "registry");
  const cachePath = join(cacheDir, "registry-v1.json");
  let cached = await readCache(cachePath);
  let cacheFresh = false;
  try {
    cacheFresh = Date.now() - (await stat(cachePath)).mtimeMs <= CACHE_MAX_AGE_MS;
  } catch {
    /* missing cache */
  }
  let index = cached;
  if (options.refresh || !cacheFresh || !index) {
    try {
      const fetched = await fetchIndex(options.fetchImpl ?? fetch);
      index = fetched.index;
      await mkdir(cacheDir, { recursive: true });
      const temp = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temp, fetched.raw, { encoding: "utf8", mode: 0o600 });
      await rename(temp, cachePath);
    } catch (error) {
      if (!index) throw error;
    }
  }
  return index!;
}

/** Load a fresh registry when possible and fall back to the last validated cache when offline. */
export async function discoverRegistryAgents(options: RegistryDiscoveryOptions): Promise<AgentDefinition[]> {
  if (!options.allowedAgentIds.length) return [];
  const [index, approvals] = await Promise.all([loadRegistryIndex(options), readApprovals(options.dataDir)]);
  return registryEntriesToAgents(index, options.allowedAgentIds, {
    ...options,
    approvedFingerprints: new Set(approvals.map((approval) => approval.fingerprint)),
  });
}

export interface RegistryApprovalOptions extends RegistryDiscoveryOptions {
  agentId: string;
  schemaVersion: string;
  adapterVersion: string;
  action: "approve" | "revoke";
}

const approvalQueues = new Map<string, Promise<void>>();

/** Persist or revoke authorization for one exact package-runner launch. This never launches the
 * package; the approved fingerprint is rechecked by discovery immediately before it can become
 * available to a later session. */
async function updateRegistryApprovalNow(options: RegistryApprovalOptions): Promise<void> {
  if (!options.allowedAgentIds.includes(options.agentId)) throw new Error("agent is not allowed by runner policy");
  const approvals = await readApprovals(options.dataDir);
  if (options.action === "revoke") {
    await writeApprovals(options.dataDir, approvals.filter((approval) => !(
      approval.agentId === options.agentId &&
      approval.schemaVersion === options.schemaVersion &&
      approval.adapterVersion === options.adapterVersion
    )));
    return;
  }
  const index = await loadRegistryIndex({ ...options, refresh: true });
  if (index.version !== options.schemaVersion) throw new Error("registry schema version changed; refresh and confirm again");
  const entry = index.agents.find((agent) => agent.id === options.agentId);
  if (!entry) throw new Error("agent is no longer present in the Registry");
  if (entry.version !== options.adapterVersion) throw new Error("adapter version changed; refresh and confirm again");
  const selected = selectDistribution(entry, options.platform ?? process.platform, options.arch ?? process.arch);
  const fingerprint = approvalFingerprint(entry, index.version, selected);
  if (!fingerprint) {
    throw new Error(selected?.kind === "binary"
      ? "binary Registry installs require an integrity digest and are manual-only"
      : "package launch is not pinned to the exact adapter version and is manual-only");
  }
  const packageRunner = await (options.resolveCommand ?? resolveNative)(selected!.command);
  if (!packageRunner) throw new Error(`${selected!.command} is not installed on the runner host`);
  const next = approvals.filter((approval) => approval.agentId !== entry.id);
  next.unshift({
    agentId: entry.id,
    schemaVersion: index.version,
    adapterVersion: entry.version,
    fingerprint,
    approvedAt: Date.now(),
  });
  await writeApprovals(options.dataDir, next);
}

export function updateRegistryApproval(options: RegistryApprovalOptions): Promise<void> {
  const key = approvalPath(options.dataDir);
  const prior = approvalQueues.get(key) ?? Promise.resolve();
  const run = prior.catch(() => {}).then(() => updateRegistryApprovalNow(options));
  approvalQueues.set(key, run);
  void run.finally(() => {
    if (approvalQueues.get(key) === run) approvalQueues.delete(key);
  }).catch(() => {});
  return run;
}
