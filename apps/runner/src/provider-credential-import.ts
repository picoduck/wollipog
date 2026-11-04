import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, renameSync, rmSync, writeSync, type BigIntStats } from "node:fs";
import { release as osRelease } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";

/**
 * #3719: copy an existing Codex API-key sign-in into a new managed provider profile.
 *
 * Only Codex's file-backed `auth.json` whose active record is an API key alone is importable: an
 * OAuth (ChatGPT) record carries a refresh token that rotates, and two HOMEs holding one refresh
 * token can invalidate each other (`refresh_token_reused` is permanent). The source JSON is never
 * copied: the destination receives a fresh record holding only the API key, in the shape
 * `codex login --with-api-key` writes (measured against codex-cli 0.165.0 in a throwaway
 * `CODEX_HOME` with a fake key). Configuration, transcripts, plugins and skills are not read or
 * copied; `config.toml` is read only to prove that Codex uses file storage for credentials.
 *
 * These helpers run inside the provider-HOME lease worker while it holds the source HOME's lease.
 * Every refusal is a fixed code, so no path or credential content crosses the worker boundary.
 */
export const CODEX_CREDENTIAL_FILE = "auth.json";
export const CODEX_CONFIG_FILE = "config.toml";
export const PROVIDER_CREDENTIAL_IMPORT_LIMITS = { credentialBytes: 16 * 1024, configBytes: 1024 * 1024, apiKeyBytes: 4096 } as const;

/**
 * Whether this runner's host can import at all: native Linux or macOS only. Windows cannot verify
 * a profile marker; a Linux runner inside WSL or a container is excluded because its HOME's
 * relation to the Machine (another distribution, mounted storage, a disposable filesystem) cannot
 * be verified, and container execution targets never bind host accounts.
 */
export function providerCredentialImportHostSupported(host: {
  platform?: NodeJS.Platform; release?: string; env?: NodeJS.ProcessEnv; exists?: (path: string) => boolean;
} = {}): boolean {
  const platform = host.platform ?? process.platform;
  if (platform === "darwin") return true;
  if (platform !== "linux") return false;
  const exists = host.exists ?? ((path: string) => { try { lstatSync(path); return true; } catch { return false; } });
  const env = host.env ?? process.env;
  const release = host.release ?? osRelease();
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP || /microsoft|wsl/iu.test(release) || exists("/proc/sys/fs/binfmt_misc/WSLInterop")) return false;
  return !exists("/.dockerenv") && !exists("/run/.containerenv");
}

/** Where the source's Codex credential directory sits relative to its lease HOME: an account HOME
 * (or an explicit `CODEX_HOME`) is the credential directory itself; the runner user's default HOME
 * keeps it in `.codex`. */
export type CodexCredentialLayout = "codex_home" | "user_home";

export type ProviderCredentialImportRefusalCode =
  | "import_source_missing" | "import_source_held" | "import_source_unsafe" | "import_source_foreign"
  | "import_source_unsupported" | "import_source_changed";

export class ProviderCredentialImportRefusal extends Error {
  constructor(readonly code: ProviderCredentialImportRefusalCode) {
    super(`provider credential import refused (${code})`);
    this.name = "ProviderCredentialImportRefusal";
  }
}

function refuse(code: ProviderCredentialImportRefusalCode): never {
  throw new ProviderCredentialImportRefusal(code);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** The identity a source node must keep from admission through publication. */
interface Pin { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }
function pin(stat: BigIntStats): Pin {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
}
function sameNode(left: Pin, right: Pin): boolean { return left.dev === right.dev && left.ino === right.ino; }
function sameFile(left: Pin, right: Pin): boolean {
  return sameNode(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
function uid(): bigint {
  if (typeof process.getuid !== "function" || constants.O_NOFOLLOW === undefined) refuse("import_source_unsupported");
  return BigInt(process.getuid());
}

/** A real directory (never a link) owned by the runner's user and not writable by group or others. */
export function pinCredentialDirectory(path: string): Pin {
  let stat: BigIntStats;
  try { stat = lstatSync(path, { bigint: true }); } catch (error) {
    refuse(errorCode(error) === "ENOENT" ? "import_source_missing" : "import_source_unsafe");
  }
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== uid() || (stat.mode & 0o022n) !== 0n) refuse("import_source_unsafe");
  // Only the node identity is pinned: the provider may add unrelated files (logs) meanwhile.
  return pin(stat);
}

/**
 * Read one bounded regular file without following links: owned by the runner's user, one link,
 * `forbidden` mode bits clear, and unchanged (identity, size and times) across the read. Undefined
 * only when the file is absent and `optional`.
 */
function readPinnedFile(path: string, maxBytes: number, forbidden: bigint, optional: boolean): { bytes: Buffer; pin: Pin } | undefined {
  let named: BigIntStats;
  try { named = lstatSync(path, { bigint: true }); } catch (error) {
    if (errorCode(error) === "ENOENT") { if (optional) return undefined; refuse("import_source_missing"); }
    refuse("import_source_unsafe");
  }
  if (named.isSymbolicLink() || !named.isFile()) refuse("import_source_unsafe");
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW! | (constants.O_NONBLOCK ?? 0)); } catch { refuse("import_source_unsafe"); }
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.uid !== uid() || (stat.mode & forbidden) !== 0n || !sameFile(pin(named), pin(stat))) refuse("import_source_unsafe");
    if (stat.size > BigInt(maxBytes)) refuse("import_source_unsupported");
    const bytes = Buffer.alloc(Number(stat.size) + 1);
    let offset = 0;
    for (;;) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
      // A file that grew past its stat size changed while it was read.
      if (offset > Number(stat.size)) refuse("import_source_changed");
    }
    const after = lstatSync(path, { bigint: true });
    if (offset !== Number(stat.size) || !sameFile(pin(after), pin(stat)) || !sameFile(pin(fstatSync(fd, { bigint: true })), pin(stat))) refuse("import_source_changed");
    return { bytes: bytes.subarray(0, offset), pin: pin(stat) };
  } finally { closeSync(fd); }
}

const RECORD_KEYS = new Set(["auth_mode", "OPENAI_API_KEY", "tokens", "last_refresh"]);
const API_KEY = /^[\x21-\x7e]+$/u;

/**
 * The API key of an API-key-only Codex record, or undefined for anything else: OAuth tokens, a
 * refresh time, another `auth_mode`, unknown keys (newer authentication types), or a key that is
 * empty, oversized or not printable ASCII. Both the current shape (`auth_mode: "apikey"`) and the
 * older one (`tokens: null`, `last_refresh: null`, no mode) are accepted.
 */
export function codexApiKeyFromRecord(bytes: Buffer): string | undefined {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return undefined; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !RECORD_KEYS.has(key))) return undefined;
  if (Object.hasOwn(record, "auth_mode") && record.auth_mode !== "apikey") return undefined;
  if (Object.hasOwn(record, "tokens") && record.tokens !== null) return undefined;
  if (Object.hasOwn(record, "last_refresh") && record.last_refresh !== null) return undefined;
  const key = record.OPENAI_API_KEY;
  if (typeof key !== "string" || !API_KEY.test(key) || key.length > PROVIDER_CREDENTIAL_IMPORT_LIMITS.apiKeyBytes) return undefined;
  return key;
}

/** The record `codex login --with-api-key` writes, holding only the key. */
export function codexApiKeyRecord(apiKey: string): Buffer {
  if (!API_KEY.test(apiKey) || apiKey.length > PROVIDER_CREDENTIAL_IMPORT_LIMITS.apiKeyBytes) throw new Error("invalid API key record");
  return Buffer.from(JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: apiKey }, null, 2));
}

/**
 * Whether Codex keeps credentials in `auth.json` under this configuration. Absent configuration
 * and `cli_auth_credentials_store = "file"` do; `keyring`, `auto` and `ephemeral` may not (Codex
 * 0.165.0 reports "Not logged in" for keyring and ephemeral storage with an `auth.json` present,
 * and `auto` prefers the keyring), so any setting other than `file`, at any level including
 * profiles, refuses. Unparseable configuration refuses too: Codex itself would not start with it.
 */
export function codexUsesFileCredentialStore(config: Buffer | undefined): boolean {
  if (config === undefined) return true;
  let parsed: unknown;
  try { parsed = parseToml(new TextDecoder("utf-8", { fatal: true }).decode(config)); } catch { return false; }
  const settingsOk = (value: unknown, depth: number): boolean => {
    if (!value || typeof value !== "object") return true;
    if (depth > 32) return false;
    if (Array.isArray(value)) return value.every((item) => settingsOk(item, depth + 1));
    return Object.entries(value).every(([key, item]) =>
      key === "cli_auth_credentials_store" ? item === "file" : settingsOk(item, depth + 1));
  };
  return settingsOk(parsed, 0);
}

/** An admitted source credential: the key, and a check that its directory, record and
 * configuration are still the nodes that were read. */
export interface CodexCredentialSource {
  apiKey: string;
  verifyUnchanged(): void;
}

/**
 * Read the Codex credential in `credentialDirectory` (the caller holds its HOME's lease): a private
 * (0600 or stricter), bounded, single-link regular `auth.json` holding an API-key-only record,
 * under file credential storage. Refusals: no directory or record is `import_source_missing`; a
 * link, another owner, loose permissions or an irregular file is `import_source_unsafe`; any other
 * record or storage is `import_source_unsupported`; a concurrent change is `import_source_changed`.
 */
export function readCodexCredentialSource(credentialDirectory: string): CodexCredentialSource {
  const directory = pinCredentialDirectory(credentialDirectory);
  const authPath = join(credentialDirectory, CODEX_CREDENTIAL_FILE);
  const configPath = join(credentialDirectory, CODEX_CONFIG_FILE);
  const auth = readPinnedFile(authPath, PROVIDER_CREDENTIAL_IMPORT_LIMITS.credentialBytes, 0o077n, false)!;
  const config = readPinnedFile(configPath, PROVIDER_CREDENTIAL_IMPORT_LIMITS.configBytes, 0o022n, true);
  if (!codexUsesFileCredentialStore(config?.bytes)) refuse("import_source_unsupported");
  const apiKey = codexApiKeyFromRecord(auth.bytes);
  if (apiKey === undefined) refuse("import_source_unsupported");
  const verifyUnchanged = () => {
    let current: Pin;
    try { current = pinCredentialDirectory(credentialDirectory); } catch { refuse("import_source_changed"); }
    if (!sameNode(current, directory)) refuse("import_source_changed");
    const still = (path: string, expected: Pin | undefined) => {
      let stat: BigIntStats;
      try { stat = lstatSync(path, { bigint: true }); } catch (error) {
        if (errorCode(error) === "ENOENT" && expected === undefined) return;
        refuse("import_source_changed");
      }
      if (expected === undefined || stat.isSymbolicLink() || !sameFile(pin(stat), expected)) refuse("import_source_changed");
    };
    still(authPath, auth.pin);
    still(configPath, config?.pin);
  };
  verifyUnchanged();
  return { apiKey, verifyUnchanged };
}

/**
 * Publish `record` as `<home>/auth.json` of a fresh managed profile HOME the caller holds the lease
 * of: an exclusive 0600 temporary file, fsync, a rename that refuses an existing credential, and a
 * directory fsync. Only the lease worker calls this.
 */
export function publishCodexCredential(home: string, record: Buffer): void {
  const target = join(home, CODEX_CREDENTIAL_FILE);
  let exists = true;
  try { lstatSync(target); } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    exists = false;
  }
  if (exists) throw new Error("the new profile already holds a credential");
  const temporary = join(home, `.auth.json.${randomUUID()}.tmp`);
  let fd: number | undefined;
  let committed = false;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW!, 0o600);
    let offset = 0;
    while (offset < record.length) {
      const written = writeSync(fd, record, offset, record.length - offset);
      if (written < 1) throw new Error("short credential write");
      offset += written;
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, target);
    committed = true;
    const directory = openSync(home, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | constants.O_NOFOLLOW!);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch (error) {
    if (!committed) throw error;
    // The rename already committed; the directory fsync is a best-effort durability barrier, as
    // for profile markers.
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (!committed) rmSync(temporary, { force: true });
  }
}
