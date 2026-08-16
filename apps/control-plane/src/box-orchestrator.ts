/**
 * Box orchestrator: bootstraps and supervises a runner on a remote machine over SSH.
 *
 * For each box the control plane:
 *   1. detects the remote platform (`ssh … uname -s -m`),
 *   2. ensures the matching runner binary is deployed (`scp` if missing),
 *   3. launches it config-less through a reverse tunnel:
 *        ssh -R <port>:127.0.0.1:<cpPort> <target> '<runner> --runner-id … --control-plane-url ws://127.0.0.1:<port>/runner …'
 * The runner dials the tunnel and registers via the normal `/runner` path, so a box is just a
 * runner with a persisted SSH config. The orchestrator only owns the SSH process + box status.
 *
 * Shipped supervised-tunnel scope: Unix-like targets; the runner process lifetime equals the SSH
 * session. Persisted provider sessions can hydrate/resume after reconnect, but active work does not
 * continue while disconnected. Auth: non-interactive SSH (agent/passwordless keys). See
 * docs/ssh-runner-lifecycle.md for the gated durable-service design.
 */

import { spawn, execFile, type ChildProcess } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  createWriteStream,
  createReadStream,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { get as httpsGet } from "node:https";
import type { BoxStatus, RunnerCredentialSecret } from "@wollipog/protocol";
import type { BoxConfig, ControlPlaneDb } from "./db.js";
import { readCompatibleEnv, type Environment } from "./env-compat.js";
import type { Hub } from "./hub.js";

/** Home-relative path the runner binary is deployed to on the box (cwd is $HOME over SSH). */
const REMOTE_RUNNER_PATH = ".agent-manager/agent-manager-runner";

/** SSH options shared by every invocation: never prompt (fail fast), trust-on-first-use host keys. */
const SSH_BASE_OPTS = [
  "-o", "StrictHostKeyChecking=accept-new",
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=10",
];

const INITIAL_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;
const LEGACY_RUNNER_ASSET_WARNING =
  "Wollipog used a legacy runner asset because the canonical asset was absent; update the release producer before compatibility is removed.";
const LEGACY_STAGED_RUNNER_ASSET_WARNING_MARKER = ".legacy-staged-runner-asset-warning";
const LEGACY_RELEASE_RUNNER_ASSET_WARNING_MARKER = ".legacy-release-runner-asset-warning";

/* ----------------------------- pure helpers (unit-tested) ----------------------------- */

/** POSIX single-quote a value for safe embedding in the remote shell command. */
export function posixQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Map `uname -s -m` output to the runner-binary target triple, or null if unsupported. */
export function tripleFromUname(unameSM: string): string | null {
  const [sys, machRaw] = unameSM.trim().split(/\s+/);
  const mach = machRaw ?? "";
  const arch = /^(aarch64|arm64)/.test(mach) ? "aarch64" : /^(x86_64|amd64)/.test(mach) ? "x86_64" : null;
  if (!arch) return null;
  if (sys === "Linux") return `${arch}-unknown-linux-gnu`;
  if (sys === "Darwin") return `${arch}-apple-darwin`;
  return null;
}

/** The remote command that launches the runner config-less (run by the remote shell). The token
 * is passed as a FILE path (not the secret) so it never appears in any process's argv. */
export function buildRemoteCommand(o: {
  runnerPath: string;
  runnerId: string;
  controlPlaneUrl: string;
  tokenFile: string;
  dataDir?: string | null;
  adoptLegacyDataDir?: boolean;
  workspaces: { id: string; path: string }[];
}): string {
  const parts = [
    posixQuote(o.runnerPath),
    "--runner-id", posixQuote(o.runnerId),
    "--control-plane-url", posixQuote(o.controlPlaneUrl),
    "--token-file", posixQuote(o.tokenFile),
  ];
  if (o.dataDir) parts.push("--data-dir", posixQuote(o.dataDir));
  if (o.adoptLegacyDataDir) parts.push("--adopt-legacy-data-dir");
  for (const w of o.workspaces) parts.push("--workspace", posixQuote(`${w.id}:${w.path}`));
  return parts.join(" ");
}

/** New managed boxes never share the historical home-level runner root. */
export function managedBoxRunnerDataDir(boxId: string): string {
  if (!/^box-[a-f0-9]{8}$/u.test(boxId)) throw new Error("invalid box id");
  return `.agent-manager/runner-data/${boxId}`;
}

/** Adoption authority is attempt-scoped: stale persisted/runtime epochs never gain the flag. */
export function managedAdoptionEpochIsCurrent(
  currentRuntimeEpoch: number,
  attemptRuntimeEpoch: number,
  pendingAdoptionEpoch: string | null,
  attemptAdoptionEpoch: string | null,
): boolean {
  return currentRuntimeEpoch === attemptRuntimeEpoch &&
    attemptAdoptionEpoch !== null &&
    pendingAdoptionEpoch === attemptAdoptionEpoch;
}

/** ssh argv (spawn with shell:false) opening a reverse tunnel and running the remote command.
 * `--` terminates option parsing so an SSH target can never be read as an option. */
export function buildSshArgs(o: {
  sshTarget: string;
  sshPort: number;
  remotePort: number;
  cpPort: number;
  remoteCommand: string;
}): string[] {
  return [
    "-p", String(o.sshPort),
    ...SSH_BASE_OPTS,
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-o", "ExitOnForwardFailure=yes",
    "-R", `${o.remotePort}:127.0.0.1:${o.cpPort}`,
    "--",
    o.sshTarget,
    o.remoteCommand,
  ];
}

/** Is the binary identified by `localHash` already the one deployed to this box? Compared by
 * CONTENT, not remote `--version`: the runner version string doesn't change across launch-contract
 * changes (e.g. adding --token-file), so a stale remote binary must still be detected + replaced. */
export function binaryIsCurrent(deployedVersion: string | null, localHash: string): boolean {
  return deployedVersion === localHash;
}

/** Attempt-private upload path. Distinct epochs prevent a superseded reconnect from promoting a
 * newer attempt's bytes or interleaving two scp writers. */
export function stagedRunnerPath(epoch: number): string {
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error(`invalid deployment epoch: ${epoch}`);
  return `${REMOTE_RUNNER_PATH}.new-${epoch}`;
}

/** Login-shell-safe cleanup: the quoted find pattern is not expanded by zsh when no files match. */
export function buildStageSweepCommand(): string {
  return "mkdir -p .agent-manager && find .agent-manager -maxdepth 1 -name 'agent-manager-runner.new-*' -mmin +60 -delete";
}

/** Promote only after a complete scp. `mv` is atomic because staging and live paths share a dir. */
export function buildPromoteCommand(epoch: number): string {
  const staged = stagedRunnerPath(epoch);
  return `chmod +x ${staged} && mv -f ${staged} ${REMOTE_RUNNER_PATH}`;
}

/** Attempt-specific credential paths prevent a superseded deploy from overwriting the token used
 * by a newer launch. Only generated credential ids are accepted in remote paths. */
export function remoteCredentialPath(credentialId: string): string {
  if (!/^rcred_[a-f0-9]{32}$/u.test(credentialId)) throw new Error("invalid runner credential id");
  return `.agent-manager/credentials/${credentialId}`;
}

/** Token bytes arrive on stdin; umask makes the newly-created file owner-readable only. */
export function buildTokenDeployCommand(credentialId: string): string {
  const live = remoteCredentialPath(credentialId);
  const staged = `${live}.new-$$`;
  return (
    `umask 077; mkdir -p .agent-manager/credentials; ` +
    `find .agent-manager/credentials -maxdepth 1 -type f -mmin +10080 -delete; ` +
    `trap 'rm -f ${staged}' EXIT HUP INT TERM; ` +
    `cat > ${staged} && chmod 600 ${staged} && mv -f ${staged} ${live}`
  );
}

/** Shared reconnect/update race guard. Any epoch change, removal, or shutdown supersedes all async
 * work captured by the older attempt before it may promote bytes or start a runner. */
export function deploymentAttemptIsCurrent(
  currentEpoch: number,
  attemptEpoch: number,
  removed: boolean,
  stopping: boolean,
): boolean {
  return currentEpoch === attemptEpoch && !removed && !stopping;
}

/** Short sha256 of a file's contents (streamed — the runner binary is ~120 MB). */
function fileDigest(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    const s = createReadStream(path);
    s.on("data", (c) => h.update(c));
    s.on("end", () => resolve(h.digest("hex")));
    s.on("error", reject);
  });
}

/* ----------------------------- binary resolver ----------------------------- */

export interface ResolvedRunnerBinary {
  path: string;
  /** Full verified digest; deployment persists the first 16 hex chars as its content identity. */
  sha256: string;
  source: "staged" | "release-cache";
}

export type BinaryResolver = (triple: string, o?: { refresh?: boolean }) => Promise<ResolvedRunnerBinary>;

export function binaryDeployIdentity(binary: ResolvedRunnerBinary): string {
  if (!/^[0-9a-f]{64}$/.test(binary.sha256)) throw new Error("resolved runner binary has an invalid SHA-256 digest");
  return binary.sha256.slice(0, 16);
}

/** Current-first release/staging names. The legacy alias remains accepted throughout migration. */
export function runnerAssetNames(triple: string): readonly [string, string] {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(triple)) {
    throw new Error(`invalid runner target triple: ${triple}`);
  }
  const executable = triple.includes("-pc-windows-") ? ".exe" : "";
  return [`wollipog-runner-${triple}${executable}`, `agent-manager-runner-${triple}${executable}`];
}

export interface ReleaseArtifactRequest {
  repo: string;
  releaseTag: string;
  assetName: string;
  /** Used only for GitHub API requests; never persisted or logged. */
  token?: string;
}

export interface ReleaseArtifactDownload {
  /** Publisher-provided GitHub release-asset digest, when metadata exposes one. */
  sha256?: string;
}

export interface ReleaseArtifactSelectionRequest {
  repo: string;
  releaseTag: string;
  assetNames: readonly string[];
  /** Used only for GitHub API requests; never persisted or logged. */
  token?: string;
}

export interface ReleaseArtifactSelection {
  assetName: string;
  download(dest: string): Promise<ReleaseArtifactDownload>;
}

interface RunnerCacheManifest {
  schemaVersion: 1 | 2;
  repo: string;
  releaseTag: string;
  assetName: string;
  sha256: string;
  size: number;
  digestProvenance?: "github-release-asset";
}

const CACHE_MANIFEST_SCHEMA = 2;

function parseCacheManifest(path: string): RunnerCacheManifest | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object") return null;
    const m = value as Partial<RunnerCacheManifest>;
    if (
      (m.schemaVersion !== 1 && m.schemaVersion !== CACHE_MANIFEST_SCHEMA) ||
      typeof m.repo !== "string" ||
      typeof m.releaseTag !== "string" ||
      typeof m.assetName !== "string" ||
      typeof m.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(m.sha256) ||
      typeof m.size !== "number" ||
      !Number.isSafeInteger(m.size) ||
      m.size < 1
    ) {
      return null;
    }
    if (m.schemaVersion === CACHE_MANIFEST_SCHEMA && m.digestProvenance !== "github-release-asset") return null;
    return m as RunnerCacheManifest;
  } catch {
    return null;
  }
}

async function cacheEntryIsCurrent(
  binaryPath: string,
  manifestPath: string,
  identity: Pick<RunnerCacheManifest, "repo" | "releaseTag" | "assetName">,
  digest: (path: string) => Promise<string>,
): Promise<{ current: boolean; sha256?: string; reason?: string }> {
  if (!existsSync(binaryPath)) return { current: false };
  const manifest = parseCacheManifest(manifestPath);
  if (!manifest) return { current: false, reason: "missing or malformed cache manifest" };
  if (
    manifest.repo !== identity.repo ||
    manifest.releaseTag !== identity.releaseTag ||
    manifest.assetName !== identity.assetName
  ) {
    return { current: false, reason: "cache manifest release identity mismatch" };
  }
  try {
    const stat = lstatSync(binaryPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { current: false, reason: "cached binary is not a regular file" };
    }
    if (stat.size !== manifest.size) return { current: false, reason: "cached binary size mismatch" };
    // File timestamps are only cache hints, not integrity evidence. Some filesystems preserve the
    // observed timestamp across an immediate same-size overwrite, so trusting a prior digest here
    // can accept tampered bytes. Release artifacts must always be checked against their manifest.
    const sha256 = await digest(binaryPath);
    if (sha256 !== manifest.sha256) {
      return { current: false, reason: "cached binary content hash mismatch" };
    }
  } catch {
    return { current: false, reason: "cached binary could not be read" };
  }
  return { current: true, sha256: manifest.sha256 };
}

/** Keep the current release plus one previous known-good release for rollback. Best-effort only:
 * cache cleanup must never make an otherwise valid resolution fail. Symlinks are never followed. */
function pruneReleaseCache(cacheDir: string, currentRelease: string, warn?: (message: string) => void): void {
  try {
    const previous = readdirSync(cacheDir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          entry.name !== currentRelease &&
          /^v[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.name),
      )
      .map((entry) => {
        const path = join(cacheDir, entry.name);
        const stat = lstatSync(path);
        return { path, name: entry.name, mtimeMs: stat.isSymbolicLink() ? Number.POSITIVE_INFINITY : stat.mtimeMs };
      })
      .filter((entry) => Number.isFinite(entry.mtimeMs))
      .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
    for (const stale of previous.slice(1)) {
      rmSync(stale.path, { recursive: true, force: true });
      warn?.(`pruned stale runner release cache ${stale.name}; kept ${currentRelease} plus one rollback release`);
    }
  } catch (err) {
    warn?.(`runner cache retention cleanup skipped: ${(err as Error).message}`);
  }
}

function ensureReleaseCacheDir(cacheDir: string, releaseDir: string): void {
  mkdirSync(cacheDir, { recursive: true });
  if (!existsSync(releaseDir)) {
    mkdirSync(releaseDir);
    return;
  }
  const stat = lstatSync(releaseDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`runner release cache must be a real directory, not a symlink: ${releaseDir}`);
  }
}

function cachePathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Only proven absence permits the legacy generation. Permission/I/O failures are ambiguous
    // canonical state and therefore pin resolution to canonical repair rather than downgrade.
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
}

/** A verified canonical download supersedes the same release/triple's legacy cache. Remove only
 * ordinary files inside the already-validated release directory; never follow or recursively
 * remove a substituted entry. Cleanup is best-effort because the canonical result is complete. */
function removeSupersededLegacyCache(
  releaseDir: string,
  legacyName: string,
  warn?: (message: string) => void,
): void {
  for (const path of [join(releaseDir, legacyName), join(releaseDir, `${legacyName}.manifest.json`)]) {
    try {
      if (!cachePathExists(path)) continue;
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        warn?.("superseded legacy runner cache cleanup skipped because an entry was not a regular file");
        continue;
      }
      rmSync(path, { force: true });
    } catch (error) {
      warn?.(`superseded legacy runner cache cleanup skipped: ${(error as Error).message}`);
    }
  }
}

/** Resolve a local path to the runner binary for a target triple (the `scp` source).
 * Order: $WOLLIPOG_RUNNER_BIN_DIR → dist-bin (explicit operator overrides) → a release-identified,
 * full-hash-validated cache → the exact release embedded in the packaged control plane.
 * `refresh: true` bypasses a valid cache but never bypasses an explicit staged build. */
export function makeBinaryResolver(opts: {
  repo: string;
  releaseTag: string;
  cacheDir: string;
  distBinDir: string;
  log?: (m: string) => void;
  warn?: (m: string) => void;
  env?: Environment;
  token?: string | null;
  /** Injectable for tests — defaults to the authenticated GitHub artifact downloader. */
  download?: (request: ReleaseArtifactRequest, dest: string) => Promise<ReleaseArtifactDownload | void>;
  /** Injectable release-level resolver. Production fetches metadata once, then downloads one selected asset. */
  release?: (request: ReleaseArtifactSelectionRequest) => Promise<ReleaseArtifactSelection>;
  /** Injectable for deterministic hash-count coverage. */
  digest?: (path: string) => Promise<string>;
}): BinaryResolver {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(opts.repo)) {
    throw new Error(`invalid GitHub repository: ${opts.repo}`);
  }
  if (!/^v[A-Za-z0-9][A-Za-z0-9._-]*$/.test(opts.releaseTag)) {
    throw new Error(`invalid runner release tag: ${opts.releaseTag}`);
  }
  const configuredToken =
    opts.token === undefined ? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN : opts.token;
  const token = configuredToken?.trim() || undefined;
  const download = opts.download;
  const resolveRelease = opts.release ?? (download ? undefined : resolveReleaseArtifact);
  const digest = opts.digest ?? fileDigest;
  const runnerBinDir = readCompatibleEnv(
    opts.env ?? process.env,
    "WOLLIPOG_RUNNER_BIN_DIR",
    "MAM_RUNNER_BIN_DIR",
    opts.warn,
  );
  const validated = new Map<string, { size: number; mtimeMs: number; ctimeMs: number; sha256: string }>();
  const legacyWarningHandled = { staged: false, release: false };
  const warnLegacyAssetOnce = (source: "staged" | "release") => {
    if (!opts.warn || legacyWarningHandled[source]) return;
    legacyWarningHandled[source] = true;
    const releaseDir = join(opts.cacheDir, opts.releaseTag);
    const marker = source === "staged"
      ? LEGACY_STAGED_RUNNER_ASSET_WARNING_MARKER
      : LEGACY_RELEASE_RUNNER_ASSET_WARNING_MARKER;
    try {
      ensureReleaseCacheDir(opts.cacheDir, releaseDir);
      writeFileSync(join(releaseDir, marker), "", { flag: "wx", mode: 0o600 });
    } catch (err) {
      // Another process or an earlier invocation already claimed the durable warning. Other
      // persistence failures still warn once for this resolver instead of hiding the fallback.
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return;
    }
    opts.warn(LEGACY_RUNNER_ASSET_WARNING);
  };
  // One in-flight download per release/triple: concurrent resolutions (two boxes on the same
  // platform, or update-spam on one box) share it instead of interleaving writes to one path.
  const inflight = new Map<string, Promise<ResolvedRunnerBinary>>();
  return async (triple, o = {}) => {
    const names = runnerAssetNames(triple);
    const dirs = [runnerBinDir, opts.distBinDir].filter(Boolean) as string[];
    for (const dir of dirs) {
      for (const name of names) {
        const p = join(dir, name);
        if (!existsSync(p)) continue;
        opts.warn?.(
          `using explicitly staged ${name} from ${dir}; its release identity cannot be verified ` +
            "before cross-platform deployment and is operator-managed",
        );
        const stat = lstatSync(p);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`staged runner binary is not a regular file: ${p}`);
        const prior = validated.get(p);
        const sha256 =
          prior?.size === stat.size && prior.mtimeMs === stat.mtimeMs && prior.ctimeMs === stat.ctimeMs
            ? prior.sha256
            : await digest(p);
        validated.set(p, { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, sha256 });
        if (name === names[1]) warnLegacyAssetOnce("staged");
        return { path: p, sha256, source: "staged" };
      }
    }

    const releaseDir = join(opts.cacheDir, opts.releaseTag);
    ensureReleaseCacheDir(opts.cacheDir, releaseDir);
    const canonicalDest = join(releaseDir, names[0]);
    // Either half of an exact canonical cache entry proves this release/triple had crossed the
    // generation boundary. A damaged or interrupted canonical cache must be repaired canonically,
    // never silently downgraded to an otherwise-valid legacy cache.
    const canonicalCacheStateExists =
      cachePathExists(canonicalDest) || cachePathExists(`${canonicalDest}.manifest.json`);
    const compatibleCacheNames = canonicalCacheStateExists ? names.slice(0, 1) : names;
    if (!o.refresh) {
      for (const name of compatibleCacheNames) {
        const dest = join(releaseDir, name);
        const identity = { repo: opts.repo, releaseTag: opts.releaseTag, assetName: name };
        const cached = await cacheEntryIsCurrent(dest, `${dest}.manifest.json`, identity, digest);
        if (cached.current) {
          pruneReleaseCache(opts.cacheDir, opts.releaseTag, opts.warn);
          if (name === names[1]) warnLegacyAssetOnce("release");
          return { path: dest, sha256: cached.sha256!, source: "release-cache" };
        }
        if (cached.reason) {
          opts.warn?.(`ignoring ${name} cache for ${opts.releaseTag}: ${cached.reason}; downloading again`);
        }
        const unversioned = join(opts.cacheDir, name);
        if (existsSync(unversioned)) {
          opts.warn?.(`ignoring unversioned legacy runner cache ${unversioned}; expected release ${opts.releaseTag}`);
        }
      }
    }

    const key = `${opts.releaseTag}/${triple}`;
    let job = inflight.get(key);
    if (!job) {
      job = (async () => {
        ensureReleaseCacheDir(opts.cacheDir, releaseDir);
        const resolutionNames = canonicalCacheStateExists ? names.slice(0, 1) : names;
        const attempts: Array<{
          name: string;
          download: (dest: string) => Promise<ReleaseArtifactDownload | void>;
        }> = resolveRelease
          ? [await resolveRelease({
              repo: opts.repo,
              releaseTag: opts.releaseTag,
              assetNames: resolutionNames,
              token,
            }).then((selection) => {
              if (!resolutionNames.includes(selection.assetName)) {
                throw new Error(`release resolver selected unexpected runner asset ${selection.assetName}`);
              }
              return { name: selection.assetName, download: selection.download };
            })]
          : resolutionNames.map((name) => ({
              name,
              download: (dest) => download!({
                repo: opts.repo,
                releaseTag: opts.releaseTag,
                assetName: name,
                token,
              }, dest),
            }));
        for (const attempt of attempts) {
          const name = attempt.name;
          const dest = join(releaseDir, name);
          const manifestPath = `${dest}.manifest.json`;
          const identity = { repo: opts.repo, releaseTag: opts.releaseTag, assetName: name };
          const suffix = `${process.pid}-${randomUUID()}`;
          const tmp = `${dest}.partial-${suffix}`;
          const manifestTmp = `${manifestPath}.partial-${suffix}`;
          opts.log?.(
            `downloading ${name} from exact release ${opts.releaseTag}${token ? " with GitHub authentication" : ""}`,
          );
          try {
            const downloaded = await attempt.download(tmp);
            const downloadedSize = statSync(tmp).size;
            if (downloadedSize < 1) throw new Error(`downloaded ${name} was empty`);
            const sha256 = await digest(tmp);
            const releaseSha256 = downloaded?.sha256;
            if (releaseSha256 !== undefined && !/^[0-9a-f]{64}$/.test(releaseSha256)) {
              throw new Error(`release metadata for ${name} had an invalid SHA-256 digest`);
            }
            if (releaseSha256 !== undefined && sha256 !== releaseSha256) {
              throw new Error(`downloaded ${name} did not match its GitHub release SHA-256 digest`);
            }
            const manifest: RunnerCacheManifest = {
              schemaVersion: releaseSha256 ? CACHE_MANIFEST_SCHEMA : 1,
              ...identity,
              sha256,
              size: downloadedSize,
              ...(releaseSha256 ? { digestProvenance: "github-release-asset" as const } : {}),
            };
            writeFileSync(manifestTmp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
            renameSync(tmp, dest);
            renameSync(manifestTmp, manifestPath);
            const stat = lstatSync(dest);
            validated.set(dest, { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, sha256 });
            const persisted = parseCacheManifest(manifestPath);
            if (!persisted) throw new Error(`downloaded ${name} cache manifest could not be re-read`);
            if (name === names[0]) removeSupersededLegacyCache(releaseDir, names[1], opts.warn);
            pruneReleaseCache(opts.cacheDir, opts.releaseTag, opts.warn);
            for (const candidate of names) {
              const unversioned = join(opts.cacheDir, candidate);
              if (!existsSync(unversioned)) continue;
              try {
                const candidateStat = lstatSync(unversioned);
                if (candidateStat.isFile() && !candidateStat.isSymbolicLink()) rmSync(unversioned, { force: true });
              } catch (err) {
                opts.warn?.(`legacy runner cache cleanup skipped for ${unversioned}: ${(err as Error).message}`);
              }
            }
            if (name === names[1]) warnLegacyAssetOnce("release");
            return { path: dest, sha256: persisted.sha256, source: "release-cache" as const };
          } catch (err) {
            rmSync(tmp, { force: true });
            rmSync(manifestTmp, { force: true });
            if (!resolveRelease && err instanceof ReleaseAssetNotFoundError && name !== names.at(-1)) continue;
            throw err;
          }
        }
        throw new Error(`release ${opts.releaseTag} has no compatible runner asset for ${triple}`);
      })().finally(() => inflight.delete(key));
      inflight.set(key, job);
    }
    return job!;
  };
}

export interface GithubReleaseAsset {
  name?: unknown;
  url?: unknown;
  browser_download_url?: unknown;
  digest?: unknown;
}

export interface GithubRelease {
  assets?: unknown;
}

export class ReleaseAssetNotFoundError extends Error {}

function githubAssetSha256(asset: GithubReleaseAsset): string {
  const match = /^sha256:([0-9a-f]{64})$/.exec(typeof asset.digest === "string" ? asset.digest : "");
  if (!match) throw new Error(`GitHub release metadata for ${String(asset.name)} has no valid SHA-256 digest`);
  return match[1]!;
}

export function githubRequestHeaders(token?: string, accept = "application/vnd.github+json"): Record<string, string> {
  return {
    Accept: accept,
    "User-Agent": "wollipog-control-plane",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export function redirectedRequestHeaders(
  requestHeaders: Record<string, string>,
  nextUrl: string,
): Record<string, string> {
  const nextHeaders = { ...requestHeaders };
  if (new URL(nextUrl).hostname !== "api.github.com") delete nextHeaders.Authorization;
  return nextHeaders;
}

type GithubResponseHeaders = Record<string, string | string[] | undefined>;

function firstHeader(headers: GithubResponseHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Keep rate-limit failures actionable without relying on (or echoing) GitHub's response body. */
export function githubMetadataRequestError(statusCode: number, headers: GithubResponseHeaders): string {
  const remaining = firstHeader(headers, "x-ratelimit-remaining");
  const retryAfter = firstHeader(headers, "retry-after");
  const rateLimited = statusCode === 429 || remaining === "0";
  if (!rateLimited) return `GitHub release metadata request failed (${statusCode})`;
  const reset = Number(firstHeader(headers, "x-ratelimit-reset"));
  const resetDate = new Date(reset * 1_000);
  const resetContext = Number.isSafeInteger(reset) && reset > 0 && Number.isFinite(resetDate.getTime())
    ? `; rate limit resets at ${resetDate.toISOString()}`
    : "";
  const retryContext = retryAfter && /^\d+$/.test(retryAfter) ? `; retry after ${retryAfter} seconds` : "";
  return `GitHub release metadata request was rate limited (${statusCode})${resetContext}${retryContext}`;
}

function readJson(url: string, headers: Record<string, string>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = httpsGet(url, { headers }, (res) => {
      const { statusCode = 0 } = res;
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 5 * 1024 * 1024) req.destroy(new Error("GitHub release metadata exceeded 5 MiB"));
        else chunks.push(chunk);
      });
      res.on("end", () => {
        if (statusCode !== 200) {
          reject(new Error(githubMetadataRequestError(statusCode, res.headers)));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
        } catch {
          reject(new Error("GitHub release metadata was not valid JSON"));
        }
      });
      res.on("error", reject);
    });
    req.setTimeout(30_000, () => req.destroy(new Error("GitHub release metadata request timed out")));
    req.on("error", reject);
  });
}

export interface ReleaseArtifactSelectionFallbackDeps {
  directMetadata(): Promise<unknown>;
  ghMetadata(): Promise<unknown>;
  directDownload(asset: GithubReleaseAsset, dest: string): Promise<void>;
  ghDownload(request: ReleaseArtifactRequest, dest: string): Promise<void>;
}

/** Resolve canonical/legacy candidates from one release metadata document, then download only the
 * selected asset. The fallback metadata is the raw REST representation so its publisher digest is
 * available even when authentication comes from the user's GitHub CLI session. */
export async function resolveReleaseArtifactWithFallback(
  request: ReleaseArtifactSelectionRequest,
  deps: ReleaseArtifactSelectionFallbackDeps,
): Promise<ReleaseArtifactSelection> {
  let metadata: unknown;
  let source: "direct" | "gh" = "direct";
  let directMetadataError: unknown;
  try {
    metadata = await deps.directMetadata();
  } catch (error) {
    directMetadataError = error;
    if (request.token) {
      throw artifactDownloadError({ ...request, assetName: request.assetNames[0] ?? "runner" }, error);
    }
    source = "gh";
    try {
      metadata = await deps.ghMetadata();
    } catch (ghError) {
      throw artifactDownloadError(
        { ...request, assetName: request.assetNames[0] ?? "runner" },
        error,
        ghError,
      );
    }
  }

  const release = metadata && typeof metadata === "object" ? metadata as GithubRelease : {};
  const assets = Array.isArray(release.assets) ? release.assets as GithubReleaseAsset[] : [];
  const asset = request.assetNames
    .map((name) => assets.find((candidate) => candidate.name === name))
    .find((candidate): candidate is GithubReleaseAsset => candidate !== undefined);
  if (!asset || typeof asset.name !== "string") {
    throw new ReleaseAssetNotFoundError(
      `release ${request.releaseTag} has none of the compatible assets: ${request.assetNames.join(", ")}`,
    );
  }
  const assetName = asset.name;
  const sha256 = githubAssetSha256(asset);
  const selectedRequest: ReleaseArtifactRequest = {
    repo: request.repo,
    releaseTag: request.releaseTag,
    assetName,
    token: request.token,
  };
  return {
    assetName,
    download: async (dest) => {
      if (source === "gh") {
        try {
          await deps.ghDownload(selectedRequest, dest);
        } catch (ghError) {
          throw artifactDownloadError(selectedRequest, directMetadataError, ghError);
        }
        return { sha256 };
      }
      try {
        await deps.directDownload(asset, dest);
      } catch (directError) {
        if (request.token) throw artifactDownloadError(selectedRequest, directError);
        try {
          await deps.ghDownload(selectedRequest, dest);
        } catch (ghError) {
          throw artifactDownloadError(selectedRequest, directError, ghError);
        }
      }
      return { sha256 };
    },
  };
}

export function githubAssetDownloadUrl(
  asset: GithubReleaseAsset,
  request: Pick<ReleaseArtifactRequest, "repo" | "releaseTag" | "token">,
): string {
  const authenticated = Boolean(request.token);
  const candidate = authenticated ? asset.url : asset.browser_download_url;
  let assetUrl: URL | null = null;
  try {
    assetUrl = typeof candidate === "string" ? new URL(candidate) : null;
  } catch {
    assetUrl = null;
  }
  const assetName = typeof asset.name === "string" ? asset.name : "";
  const repoPath = request.repo.split("/").map(encodeURIComponent).join("/");
  const apiPathPrefix = `/repos/${repoPath}/releases/assets/`;
  const expectedBrowserPath =
    `/${repoPath}/releases/download/${encodeURIComponent(request.releaseTag)}/${encodeURIComponent(assetName)}`;
  const validPath = authenticated
    ? assetUrl?.pathname.startsWith(apiPathPrefix)
      && /^[0-9]+$/.test(assetUrl.pathname.slice(apiPathPrefix.length))
    : assetUrl?.pathname === expectedBrowserPath;
  const expectedHost = authenticated ? "api.github.com" : "github.com";
  if (
    !assetUrl
    || assetUrl.protocol !== "https:"
    || assetUrl.hostname !== expectedHost
    || !validPath
  ) {
    throw new Error(`release ${request.releaseTag} has no valid ${String(asset.name)} asset URL`);
  }
  return assetUrl.toString();
}

async function resolveReleaseArtifact(request: ReleaseArtifactSelectionRequest): Promise<ReleaseArtifactSelection> {
  const repoPath = request.repo.split("/").map(encodeURIComponent).join("/");
  const tag = encodeURIComponent(request.releaseTag);
  return resolveReleaseArtifactWithFallback(request, {
    directMetadata: () => readJson(
      `https://api.github.com/repos/${repoPath}/releases/tags/${tag}`,
      githubRequestHeaders(request.token),
    ),
    ghMetadata: () => readReleaseMetadataWithGh(request),
    directDownload: (asset, dest) => downloadFollowingRedirects(
      githubAssetDownloadUrl(asset, request),
      dest,
      githubRequestHeaders(request.token, "application/octet-stream"),
    ),
    ghDownload: (selected, dest) => downloadReleaseAssetWithGh(selected, dest),
  });
}

export function githubCliDownloadArgs(request: ReleaseArtifactRequest, dest: string): string[] {
  return [
    "release", "download", request.releaseTag,
    "--repo", request.repo,
    "--pattern", request.assetName,
    "--output", dest,
    "--clobber",
  ];
}

export function githubCliReleaseMetadataArgs(
  request: Pick<ReleaseArtifactRequest, "repo" | "releaseTag">,
): string[] {
  const repoPath = request.repo.split("/").map(encodeURIComponent).join("/");
  return ["api", `repos/${repoPath}/releases/tags/${encodeURIComponent(request.releaseTag)}`];
}

function readReleaseMetadataWithGh(
  request: Pick<ReleaseArtifactRequest, "repo" | "releaseTag">,
): Promise<unknown> {
  return new Promise((resolveMetadata, rejectMetadata) => {
    execFile(
      "gh",
      githubCliReleaseMetadataArgs(request),
      { windowsHide: true, timeout: 30_000, maxBuffer: 5 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          rejectMetadata(new Error((stderr.trim() || error.message).slice(0, 2_000)));
          return;
        }
        try {
          resolveMetadata(JSON.parse(stdout) as unknown);
        } catch {
          rejectMetadata(new Error("authenticated gh REST release metadata was not valid JSON"));
        }
      },
    );
  });
}

function downloadReleaseAssetWithGh(request: ReleaseArtifactRequest, dest: string): Promise<void> {
  return new Promise((resolveDownload, rejectDownload) => {
    execFile(
      "gh",
      githubCliDownloadArgs(request, dest),
      { windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024 },
      (error, _stdout, stderr) => {
        if (!error) {
          resolveDownload();
          return;
        }
        rejectDownload(new Error((stderr.trim() || error.message).slice(0, 2_000)));
      },
    );
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function artifactDownloadError(request: ReleaseArtifactRequest, directError: unknown, ghError?: unknown): Error {
  const attempts = request.token
    ? `authenticated GitHub API download failed: ${errorText(directError)}`
    : ghError
      ? `unauthenticated download failed: ${errorText(directError)}; authenticated gh fallback failed: ${errorText(ghError)}`
      : `download failed: ${errorText(directError)}`;
  return new Error(
    `${attempts}. Could not fetch ${request.assetName} from exact release ${request.releaseTag}. ` +
      "Verify that the exact release and asset exist; for a private repository set GH_TOKEN/GITHUB_TOKEN " +
      "with Contents: read or run gh auth login. Otherwise stage a matching local build in WOLLIPOG_RUNNER_BIN_DIR.",
  );
}

function downloadFollowingRedirects(
  url: string,
  dest: string,
  requestHeaders: Record<string, string>,
  hops = 0,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (hops > 5) return reject(new Error("too many redirects"));
    const req = httpsGet(url, { headers: requestHeaders }, (res) => {
      const { statusCode = 0, headers: responseHeaders } = res;
      if (statusCode >= 300 && statusCode < 400 && responseHeaders.location) {
        res.resume();
        const next = new URL(responseHeaders.location, url).toString();
        const nextHeaders = redirectedRequestHeaders(requestHeaders, next);
        return resolve(downloadFollowingRedirects(next, dest, nextHeaders, hops + 1));
      }
      if (statusCode !== 200) {
        res.resume();
        return reject(
          new Error(
            `download failed (${statusCode}). The release may be unpublished — stage the binary ` +
              `in WOLLIPOG_RUNNER_BIN_DIR or publish a release.`,
          ),
        );
      }
      const file = createWriteStream(dest, { mode: 0o755 });
      // pipeline (not .pipe) so premature close / response errors REJECT: a stalled or aborted
      // body must settle this promise, or the resolver's shared in-flight job (and its .partial
      // temp file) would stay wedged until the control plane restarts.
      pipeline(res, file).then(resolve, reject);
    });
    // Inactivity timeout for the same reason — a 200 whose body stops flowing never fires any
    // stream event on its own.
    req.setTimeout(60_000, () => req.destroy(new Error("download stalled (no socket activity for 60s)")));
    req.on("error", reject);
  });
}

/* ----------------------------- orchestrator ----------------------------- */

interface BoxRuntime {
  child: ChildProcess | null;
  remotePort: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  backoffMs: number;
  removed: boolean;
  /** Bumped on every (re)start and stop; in-flight async attempts capture it and bail once
   * superseded, so reconnect spam can't leave two bootstraps/ssh children racing for one box. */
  epoch: number;
  /** Exact durable authorization carried by this launch/reconnect chain, if any. */
  activeAdoptionEpoch: string | null;
  /** Credential minted for this exact launch; registration must prove it before adoption settles. */
  activeCredentialId: string | null;
}

export interface OrchestratorDeps {
  db: ControlPlaneDb;
  hub: Hub;
  cpPort: number;
  issueCredential: (runnerId: string) => RunnerCredentialSecret;
  resolveBinary: BinaryResolver;
  stopManagedChild?: (child: ChildProcess) => Promise<void>;
  log?: (msg: string) => void;
}

export type LegacyDataAdoptionStartResult =
  | "started"
  | "not_found"
  | "not_legacy"
  | "already_authorized"
  | "stop_failed"
  | "superseded";

export function stopAndWaitForManagedChild(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
      error ? reject(error) : resolve();
    };
    const onExit = () => finish();
    const onError = (error: Error) => finish(error);
    child.once("exit", onExit);
    child.once("error", onError);
    timer = setTimeout(() => finish(new Error("managed runner did not stop before the adoption timeout")), timeoutMs);
    try {
      if (!child.killed && !child.kill()) finish(new Error("managed runner refused the stop signal"));
    } catch (error) {
      finish(error as Error);
    }
  });
}

export interface PreparedRunnerUpdate {
  status: "ready";
  boxId: string;
  triple: string;
  expectedVersion: string;
  source: ResolvedRunnerBinary["source"];
  /** Internal supersession fence captured before artifact resolution. */
  startEpoch: number;
}

export interface CurrentRunnerUpdate {
  status: "already_current";
  boxId: string;
  triple: string;
  expectedVersion: string;
  source: ResolvedRunnerBinary["source"];
}

export type RunnerUpdatePreparation = PreparedRunnerUpdate | CurrentRunnerUpdate;

export function classifyRunnerUpdate(input: {
  boxId: string;
  triple: string;
  deployedVersion: string | null;
  candidate: ResolvedRunnerBinary;
  startEpoch: number;
}): RunnerUpdatePreparation {
  const expectedVersion = binaryDeployIdentity(input.candidate);
  const common = {
    boxId: input.boxId,
    triple: input.triple,
    expectedVersion,
    source: input.candidate.source,
  };
  return binaryIsCurrent(input.deployedVersion, expectedVersion)
    ? { status: "already_current", ...common }
    : { status: "ready", ...common, startEpoch: input.startEpoch };
}

export class BoxOrchestrator {
  private readonly runtimes = new Map<string, BoxRuntime>();
  // Distinct high loopback port per box for the reverse tunnel's REMOTE listener. Must not be
  // cpPort: under mirrored-networking WSL, the box's loopback already maps to the host's CP, so
  // binding cpPort on the box collides ("remote port forwarding failed").
  private nextRemotePort = 47100;
  private stopping = false;
  private readonly stopManagedChild: (child: ChildProcess) => Promise<void>;
  constructor(private readonly deps: OrchestratorDeps) {
    this.stopManagedChild = deps.stopManagedChild ?? stopAndWaitForManagedChild;
  }

  private allocRemotePort(): number {
    const p = this.nextRemotePort;
    this.nextRemotePort = this.nextRemotePort >= 47999 ? 47100 : this.nextRemotePort + 1;
    return p;
  }

  private log(msg: string): void {
    this.deps.log?.(`[box] ${msg}`);
  }

  /** Re-bootstrap persisted boxes on control-plane startup. */
  rehydrate(): void {
    for (const cfg of this.deps.db.listBoxConfigs()) {
      if (cfg.autoReconnect) this.start(cfg);
    }
  }

  /** Begin bootstrapping an already-persisted box (called by POST /api/boxes). */
  add(boxId: string): void {
    const cfg = this.deps.db.getBoxConfig(boxId);
    if (cfg) this.start(cfg);
  }

  reconnect(boxId: string): void {
    const cfg = this.deps.db.getBoxConfig(boxId);
    if (!cfg) return;
    this.stopRuntime(boxId); // supersedes any in-flight attempt (bumps epoch, kills child, clears timer)
    const rt = this.runtimes.get(boxId);
    if (rt) rt.backoffMs = INITIAL_BACKOFF_MS;
    this.start(cfg);
  }

  /** Stop the old managed process before durably authorizing one exact legacy-root adoption. */
  async authorizeLegacyDataAdoption(
    boxId: string,
    actor: { userId: string; role: "owner" | "admin" },
  ): Promise<LegacyDataAdoptionStartResult> {
    const cfg = this.deps.db.getBoxConfig(boxId);
    if (!cfg) return "not_found";
    if (cfg.runnerDataDir !== null) return "not_legacy";
    if (cfg.legacyDataAdoptionEpoch !== null) return "already_authorized";

    let rt = this.runtimes.get(boxId);
    if (!rt) {
      rt = {
        child: null,
        remotePort: this.allocRemotePort(),
        reconnectTimer: null,
        backoffMs: INITIAL_BACKOFF_MS,
        removed: false,
        epoch: 0,
        activeAdoptionEpoch: null,
        activeCredentialId: null,
      };
      this.runtimes.set(boxId, rt);
    }
    const lifecycleEpoch = ++rt.epoch;
    if (rt.reconnectTimer) {
      clearTimeout(rt.reconnectTimer);
      rt.reconnectTimer = null;
    }
    const child = rt.child;
    rt.child = null;
    rt.activeAdoptionEpoch = null;
    rt.activeCredentialId = null;
    if (child) {
      try {
        await this.stopManagedChild(child);
      } catch (error) {
        if (rt.epoch === lifecycleEpoch && !rt.removed && !this.stopping) {
          this.setStatus(boxId, "failed", (error as Error).message);
        }
        return "stop_failed";
      }
    }
    if (rt.epoch !== lifecycleEpoch || rt.removed || this.stopping) return "superseded";

    const adoptionEpoch = `adopt-${randomUUID()}`;
    if (!this.deps.db.authorizeBoxLegacyDataAdoption({
      boxId,
      epoch: adoptionEpoch,
      authorizedBy: actor.userId,
      authorizedRole: actor.role,
      now: Date.now(),
    })) return "not_legacy";
    this.deps.hub.boxChanged(boxId);
    const authorized = this.deps.db.getBoxConfig(boxId);
    if (!authorized || authorized.pendingLegacyDataAdoptionEpoch !== adoptionEpoch) return "superseded";
    rt.backoffMs = INITIAL_BACKOFF_MS;
    this.start(authorized);
    return "started";
  }

  /** Resolve the exact candidate before asking permission to interrupt work. An identical artifact
   * is a successful no-op: it must not restart a healthy runner or force the user through an
   * active-session warning merely to prove that the box is current. */
  async prepareRunnerUpdate(boxId: string): Promise<RunnerUpdatePreparation | null> {
    const cfg = this.deps.db.getBoxConfig(boxId);
    if (!cfg) return null;
    const startEpoch = this.runtimes.get(boxId)?.epoch ?? -1;
    const triple = await this.detectTriple(cfg);
    if (cfg.triple !== triple) {
      this.deps.db.setBoxTriple(boxId, triple, Date.now());
      this.deps.hub.boxChanged(boxId);
    }
    const candidate = await this.deps.resolveBinary(triple, { refresh: true });
    return classifyRunnerUpdate({
      boxId,
      triple,
      deployedVersion: cfg.deployedVersion,
      candidate,
      startEpoch,
    });
  }

  /** Start a prepared update only if no newer lifecycle operation superseded its artifact check. */
  startPreparedRunnerUpdate(prepared: PreparedRunnerUpdate): "started" | "superseded" {
    if ((this.runtimes.get(prepared.boxId)?.epoch ?? -1) !== prepared.startEpoch) {
      this.log(`${prepared.boxId} update superseded by a newer reconnect/update — skipping its reconnect`);
      return "superseded";
    }
    this.reconnect(prepared.boxId);
    return "started";
  }

  remove(boxId: string): void {
    const rt = this.runtimes.get(boxId);
    if (rt) rt.removed = true;
    this.stopRuntime(boxId);
    this.runtimes.delete(boxId);
  }

  /** Called from the /runner register handler: flip the matching box → online. */
  onRunnerRegistered(runnerId: string, credentialId: string): void {
    const boxId = this.deps.db.boxIdForRunner(runnerId);
    if (!boxId) return;
    const rt = this.runtimes.get(boxId);
    if (rt) rt.backoffMs = INITIAL_BACKOFF_MS; // a healthy connection resets backoff
    if (rt?.activeAdoptionEpoch && rt.activeCredentialId === credentialId && this.deps.db.completeBoxLegacyDataAdoption(
      boxId,
      rt.activeAdoptionEpoch,
      Date.now(),
    )) {
      rt.activeAdoptionEpoch = null;
      this.deps.hub.boxChanged(boxId);
    }
    this.setStatus(boxId, "online");
  }

  /** Called when a box's runner websocket drops — mark it offline even if the SSH child lingers. */
  onRunnerDisconnected(runnerId: string): void {
    const boxId = this.deps.db.boxIdForRunner(runnerId);
    if (!boxId) return;
    // Only downgrade from online; a bootstrapping/deploying/failed status is already accurate.
    if (this.deps.db.getBox(boxId)?.status === "online") this.setStatus(boxId, "offline");
  }

  /** Graceful shutdown: stop reconnecting, kill all SSH children. Wired to signals + Fastify close. */
  shutdown(): void {
    this.stopping = true;
    for (const id of [...this.runtimes.keys()]) this.stopRuntime(id);
  }

  private start(cfg: BoxConfig): void {
    if (this.stopping) return;
    let rt = this.runtimes.get(cfg.boxId);
    if (!rt) {
      rt = {
        child: null,
        remotePort: this.allocRemotePort(),
        reconnectTimer: null,
        backoffMs: INITIAL_BACKOFF_MS,
        removed: false,
        epoch: 0,
        activeAdoptionEpoch: null,
        activeCredentialId: null,
      };
      this.runtimes.set(cfg.boxId, rt);
    }
    rt.removed = false;
    rt.activeAdoptionEpoch = cfg.pendingLegacyDataAdoptionEpoch;
    rt.activeCredentialId = null;
    const epoch = ++rt.epoch; // this attempt owns the runtime until something supersedes it
    void this.bootstrap(cfg, rt, epoch, rt.activeAdoptionEpoch);
  }

  /** Is `epoch` still the current attempt for `rt` (not superseded/removed/shutting down)? */
  private live(rt: BoxRuntime, epoch: number): boolean {
    return deploymentAttemptIsCurrent(rt.epoch, epoch, rt.removed, this.stopping);
  }

  private async bootstrap(
    cfg: BoxConfig,
    rt: BoxRuntime,
    epoch: number,
    adoptionEpoch: string | null,
  ): Promise<void> {
    try {
      if (!this.live(rt, epoch)) return;
      this.setStatus(cfg.boxId, "bootstrapping");
      const triple = await this.detectTriple(cfg);
      // Persist the detected platform: the Runners view shows it, and "Update runner" needs it
      // to name WHICH binary to rebuild when no fresh one can be resolved.
      if (cfg.triple !== triple) this.deps.db.setBoxTriple(cfg.boxId, triple, Date.now());
      if (!this.live(rt, epoch)) return;
      this.setStatus(cfg.boxId, "deploying");
      await this.ensureBinary(cfg, triple, rt, epoch);
      if (!this.live(rt, epoch)) return;
      const secret = this.deps.issueCredential(cfg.runnerId);
      rt.activeCredentialId = secret.credential.credentialId;
      const tokenFile = remoteCredentialPath(secret.credential.credentialId);
      await this.deployTokenFile(cfg, secret);
      if (!this.live(rt, epoch)) return;
      const fresh = this.deps.db.getBoxConfig(cfg.boxId);
      if (!fresh) return;
      if (adoptionEpoch && !managedAdoptionEpochIsCurrent(
        rt.epoch,
        epoch,
        fresh.pendingLegacyDataAdoptionEpoch,
        adoptionEpoch,
      )) return;
      this.launch(fresh, rt, epoch, tokenFile, adoptionEpoch);
    } catch (err) {
      if (!this.live(rt, epoch)) return;
      const msg = (err as Error).message;
      this.log(`${cfg.boxId} bootstrap failed: ${msg}`);
      this.setStatus(cfg.boxId, "failed", msg);
      this.scheduleReconnect(cfg, rt, epoch);
    }
  }

  private launch(
    cfg: BoxConfig,
    rt: BoxRuntime,
    epoch: number,
    tokenFile: string,
    adoptionEpoch: string | null,
  ): void {
    const controlPlaneUrl = `ws://127.0.0.1:${rt.remotePort}/runner`;
    const remoteCommand = buildRemoteCommand({
      runnerPath: REMOTE_RUNNER_PATH,
      runnerId: cfg.runnerId,
      controlPlaneUrl,
      tokenFile,
      dataDir: cfg.runnerDataDir,
      adoptLegacyDataDir: adoptionEpoch !== null,
      workspaces: cfg.workspaces,
    });
    const args = buildSshArgs({
      sshTarget: cfg.sshTarget,
      sshPort: cfg.sshPort,
      remotePort: rt.remotePort,
      cpPort: this.deps.cpPort,
      remoteCommand,
    });
    this.log(`${cfg.boxId} launching ssh ${cfg.sshTarget} (tunnel :${rt.remotePort} → CP :${this.deps.cpPort})`);
    const child = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    rt.child = child;
    let stderrTail = "";
    child.stderr?.on("data", (b: Buffer) => {
      stderrTail = (stderrTail + b.toString()).slice(-2000);
    });
    child.stdout?.on("data", () => {
      /* drain the runner's stdout so its pipe never blocks */
    });
    child.on("error", (err) => {
      if (rt.child === child) rt.child = null;
      if (!this.live(rt, epoch)) return; // superseded attempt — ignore
      this.setStatus(cfg.boxId, "failed", `ssh spawn error: ${err.message}`);
      this.scheduleReconnect(cfg, rt, epoch);
    });
    child.on("exit", (code, signal) => {
      if (rt.child === child) rt.child = null; // only clear if this child is still the current one
      if (!this.live(rt, epoch)) return; // a newer attempt / removal / shutdown owns the box now
      this.log(`${cfg.boxId} ssh exited (${signal ? `signal ${signal}` : `code ${code}`})`);
      const lastLine = stderrTail.trim().split("\n").pop()?.trim() || null;
      this.setStatus(cfg.boxId, "offline", lastLine);
      if (cfg.autoReconnect) this.scheduleReconnect(cfg, rt, epoch);
    });
  }

  private scheduleReconnect(cfg: BoxConfig, rt: BoxRuntime, epoch: number): void {
    if (!this.live(rt, epoch) || !cfg.autoReconnect || rt.reconnectTimer) return;
    const delay = rt.backoffMs;
    rt.backoffMs = Math.min(rt.backoffMs * 2, MAX_BACKOFF_MS);
    this.log(`${cfg.boxId} reconnecting in ${Math.round(delay / 1000)}s`);
    rt.reconnectTimer = setTimeout(() => {
      rt.reconnectTimer = null;
      if (!this.live(rt, epoch)) return;
      const fresh = this.deps.db.getBoxConfig(cfg.boxId);
      if (fresh) void this.bootstrap(fresh, rt, epoch, rt.activeAdoptionEpoch); // same epoch — continuation of this attempt chain
    }, delay);
  }

  private setStatus(boxId: string, status: BoxStatus, error: string | null = null): void {
    this.deps.db.setBoxStatus(boxId, status, Date.now(), error);
    this.deps.hub.boxChanged(boxId);
  }

  private stopRuntime(boxId: string): void {
    const rt = this.runtimes.get(boxId);
    if (!rt) return;
    rt.epoch++; // supersede any in-flight attempt and pending reconnect timers
    rt.activeAdoptionEpoch = null;
    rt.activeCredentialId = null;
    if (rt.reconnectTimer) {
      clearTimeout(rt.reconnectTimer);
      rt.reconnectTimer = null;
    }
    if (rt.child && !rt.child.killed) {
      try {
        rt.child.kill();
      } catch {
        /* already gone */
      }
    }
    rt.child = null;
  }

  /** ssh argv for a one-shot remote command (no tunnel). `--` keeps the target out of options. */
  private sshArgs(cfg: BoxConfig, remoteCommand: string): string[] {
    return ["-p", String(cfg.sshPort), ...SSH_BASE_OPTS, "--", cfg.sshTarget, remoteCommand];
  }

  private detectTriple(cfg: BoxConfig): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile("ssh", this.sshArgs(cfg, "uname -s -m"), { timeout: 20_000 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(`ssh ${cfg.sshTarget}: ${(stderr || "").trim() || err.message}`));
        const triple = tripleFromUname(stdout);
        if (!triple) return reject(new Error(`unsupported remote platform: ${stdout.trim()}`));
        resolve(triple);
      });
    });
  }

  private async ensureBinary(cfg: BoxConfig, triple: string, rt: BoxRuntime, epoch: number): Promise<void> {
    let local: ResolvedRunnerBinary;
    try {
      local = await this.deps.resolveBinary(triple);
    } catch (err) {
      // No local binary to deploy — fall back to whatever is already on the box (best effort; we
      // can't verify its launch-contract compatibility, but it beats failing the box outright).
      const existing = await this.probeRemoteRunner(cfg);
      if (existing) {
        this.log(`${cfg.boxId} no local runner binary; using the one already on the box (${existing})`);
        return;
      }
      throw err;
    }
    // Skip the (slow) copy only when THIS exact binary is already deployed to THIS box. Keyed on
    // content, so a stale remote runner (e.g. one that predates --token-file) is always replaced.
    const hash = binaryDeployIdentity(local);
    if (binaryIsCurrent(cfg.deployedVersion, hash)) return;
    if (!this.live(rt, epoch)) return;
    // Upload beside the live binary, then promote atomically: an interrupted scp straight over
    // REMOTE_RUNNER_PATH would truncate the WORKING runner, and the probe fallback (or the next
    // launch) would happily execute the partial file. The staged name carries the EPOCH so a
    // superseded attempt (stopRuntime can't cancel an in-flight scp) writes to its own path and
    // can never interleave its bytes with a newer attempt's upload. The liveness check immediately
    // before promotion prevents an already-superseded attempt from launching `mv`; a remote `mv`
    // already in flight is not cancellable, but normally completes before a newer full scp.
    // Abandoned staged files from superseded attempts are swept before each upload.
    const staged = stagedRunnerPath(epoch);
    // The sweep must not use a shell glob: SSH remote commands run in the target user's LOGIN
    // shell, and zsh (unlike bash) hard-errors on an unmatched glob ("no matches found"),
    // failing the whole deploy on any box whose default shell is zsh. find's quoted -name
    // pattern never touches shell expansion and succeeds when nothing matches.
    //
    // `-mmin +60`: only STALE staged files are swept. Sweeps from different epochs are
    // independent SSH processes a superseding attempt cannot cancel, so an unconditioned
    // delete from a slow, superseded epoch could land AFTER a newer epoch staged its upload
    // and unlink it mid-deploy (review-caught race). An in-flight upload is always minutes
    // old at most; hour-old staged files are abandoned by definition. (Residual: an scp that
    // takes >1h could still be swept — accepted; deploys are ~100MB over LAN/tailnet.)
    await this.runCmd(
      "ssh",
      this.sshArgs(cfg, buildStageSweepCommand()),
    );
    await this.runCmd("scp", ["-P", String(cfg.sshPort), ...SSH_BASE_OPTS, "--", local.path, `${cfg.sshTarget}:${staged}`]);
    if (!this.live(rt, epoch)) return; // superseded mid-upload — leave the live binary alone
    await this.runCmd("ssh", this.sshArgs(cfg, buildPromoteCommand(epoch)));
    if (!this.live(rt, epoch)) return; // never persist a hash a newer attempt may have replaced
    this.deps.db.setBoxDeployedVersion(cfg.boxId, hash, Date.now());
  }

  /** Write the registration token to a mode-600 file on the box over SSH stdin, so the secret
   * never appears in argv (the launch command references only the FILE path). */
  private deployTokenFile(cfg: BoxConfig, secret: RunnerCredentialSecret): Promise<void> {
    return this.runWithStdin(
      "ssh",
      this.sshArgs(cfg, buildTokenDeployCommand(secret.credential.credentialId)),
      secret.token,
    );
  }

  private probeRemoteRunner(cfg: BoxConfig): Promise<string | null> {
    return new Promise((resolve) => {
      execFile("ssh", this.sshArgs(cfg, `${REMOTE_RUNNER_PATH} --version`), { timeout: 20_000 }, (err, stdout) =>
        resolve(err ? null : stdout.trim() || "unknown"),
      );
    });
  }

  private runCmd(cmd: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { timeout: 120_000 }, (err, _out, stderr) => {
        if (err) return reject(new Error(`${cmd} failed: ${(stderr || "").trim() || err.message}`));
        resolve();
      });
    });
  }

  private runWithStdin(cmd: string, args: string[], input: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
      let stderr = "";
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error ? reject(error) : resolve();
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* process already exited */ }
        finish(new Error(`${cmd} timed out while deploying the runner credential`));
      }, 120_000);
      child.stderr?.on("data", (b: Buffer) => {
        stderr = (stderr + b.toString()).slice(-1000);
      });
      child.on("error", (e) => finish(new Error(`${cmd} failed: ${e.message}`)));
      child.on("exit", (code) => finish(code === 0 ? undefined : new Error(`${cmd} exited ${code}: ${stderr.trim()}`)));
      child.stdin?.write(input);
      child.stdin?.end();
    });
  }
}
