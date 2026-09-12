import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

export const LOCAL_DEVICE_TOKEN_ENV = "CONTROL_PLANE_LOCAL_TOKEN_FILE";
export const LOCAL_DEVICE_TOKEN_SUFFIX = ".local-device-token";
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function defaultLocalDeviceTokenPath(databasePath: string): string {
  return `${resolve(databasePath)}${LOCAL_DEVICE_TOKEN_SUFFIX}`;
}

export function localDeviceTokenPath(
  databasePath: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env[LOCAL_DEVICE_TOKEN_ENV]?.trim();
  return configured ? resolve(configured) : defaultLocalDeviceTokenPath(databasePath);
}

export function validLocalDeviceToken(value: string): boolean {
  return TOKEN_RE.test(value);
}

export function readLocalDeviceToken(path: string): string {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`local device credential is not a regular file: ${path}`);
  }
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const fd = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`local device credential changed while opening: ${path}`);
    }
    const raw = readFileSync(fd, "utf8");
    const token = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
    if (!validLocalDeviceToken(token)) {
      throw new Error(`local device credential has invalid contents: ${path}`);
    }
    try {
      chmodSync(path, 0o600);
    } catch {
      /* Windows ACLs are managed by the owning account. */
    }
    return token;
  } finally {
    closeSync(fd);
  }
}

function publicationPause(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}

function readPublishedToken(path: string): string | undefined {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return readLocalDeviceToken(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return undefined;
      const publishing = error instanceof Error &&
        error.message.startsWith("local device credential has invalid contents:");
      if (!publishing || attempt === 19) throw error;
      publicationPause();
    }
  }
  return undefined;
}

export interface LocalDeviceCredentialHost {
  link(staged: string, live: string): void;
}

const DEFAULT_HOST: LocalDeviceCredentialHost = {
  link: linkSync,
};

/**
 * Load the stable local-dashboard credential, or publish a freshly generated one atomically.
 * A same-directory hard link is an atomic no-replace publication on every supported desktop
 * filesystem: concurrent startup/`--print-pair-url` processes either publish or load the winner,
 * and no reader can observe a partial token.
 */
export function loadOrCreateLocalDeviceToken(
  path: string,
  host: LocalDeviceCredentialHost = DEFAULT_HOST,
): string {
  const live = resolve(path);
  const parent = dirname(live);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  try {
    chmodSync(parent, 0o700);
  } catch {
    /* Best effort on Windows. */
  }

  const existing = readPublishedToken(live);
  if (existing) return existing;

  const token = randomBytes(32).toString("base64url");
  const staged = `${live}.pending-${process.pid}-${randomUUID()}`;
  let fd: number | null = null;
  try {
    fd = openSync(staged, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(fd, `${token}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    try {
      chmodSync(staged, 0o600);
    } catch {
      /* Windows ACLs are managed by the owning account. */
    }
    try {
      host.link(staged, live);
      try {
        chmodSync(live, 0o600);
      } catch {
        /* Windows ACLs are managed by the owning account. */
      }
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const winner = readPublishedToken(live);
        if (!winner) throw error;
        return winner;
      }
      // Some removable/network filesystems do not support hard links. Preserve no-replace
      // publication with an exclusive live-file create; bounded readers retry only while the
      // 44-byte credential is being written, then malformed files still fail closed.
      let liveFd: number | null = null;
      let createdLive = false;
      try {
        liveFd = openSync(live, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        createdLive = true;
        writeFileSync(liveFd, `${token}\n`, "utf8");
        fsyncSync(liveFd);
        closeSync(liveFd);
        liveFd = null;
        try {
          chmodSync(live, 0o600);
        } catch {
          /* Windows ACLs are managed by the owning account. */
        }
        return token;
      } catch (fallbackError) {
        if ((fallbackError as NodeJS.ErrnoException).code !== "EEXIST") throw fallbackError;
        const winner = readPublishedToken(live);
        if (!winner) throw fallbackError;
        return winner;
      } finally {
        if (liveFd !== null) closeSync(liveFd);
        if (createdLive && liveFd !== null) rmSync(live, { force: true });
      }
    }
  } finally {
    if (fd !== null) closeSync(fd);
    rmSync(staged, { force: true });
  }
}

export function localPairingUrl(port: number, token: string): string {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`invalid control-plane port: ${port}`);
  }
  if (!validLocalDeviceToken(token)) throw new Error("invalid local device credential");
  return `http://127.0.0.1:${port}/#pair=${token}`;
}

export interface ProtectedCredentialAudit {
  path: string;
  safe: boolean;
  /** Human-readable problems; empty when the file is a private regular file owned by this account. */
  issues: string[];
}

/**
 * Report, without reading or revealing contents, whether the protected credential file is safe to
 * trust: it must exist as a regular non-symlink file owned by the current account with no group or
 * other access, inside a directory that likewise grants no group or other access. Mode and owner
 * checks are POSIX-only; Windows relies on ACLs. Used by `wollipog admin status` and `doctor`.
 */
export function auditProtectedCredentialFile(
  path: string,
  host: { platform?: NodeJS.Platform; uid?: number | null } = {},
): ProtectedCredentialAudit {
  const live = resolve(path);
  const platform = host.platform ?? process.platform;
  const uid = host.uid === undefined ? (typeof process.getuid === "function" ? process.getuid() : null) : host.uid;
  const issues: string[] = [];
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(live);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    issues.push(code === "ENOENT"
      ? "credential file does not exist; start the control plane once to create it"
      : `credential file could not be inspected: ${(error as Error).message}`);
    return { path: live, safe: false, issues };
  }
  if (stat.isSymbolicLink()) issues.push("credential path is a symbolic link");
  else if (!stat.isFile()) issues.push("credential path is not a regular file");
  if (platform !== "win32") {
    const mode = stat.mode & 0o777;
    if (mode & 0o077) issues.push(`credential file mode 0${mode.toString(8)} grants group or other access; expected 0600`);
    if (uid !== null && stat.uid !== uid) issues.push(`credential file is owned by uid ${stat.uid}, not the current account (uid ${uid})`);
    try {
      const parent = lstatSync(dirname(live));
      const parentMode = parent.mode & 0o777;
      if (parentMode & 0o077) issues.push(`credential directory mode 0${parentMode.toString(8)} grants group or other access; expected 0700`);
      if (uid !== null && parent.uid !== uid) issues.push(`credential directory is owned by uid ${parent.uid}, not the current account (uid ${uid})`);
    } catch (error) {
      issues.push(`credential directory could not be inspected: ${(error as Error).message}`);
    }
  }
  return { path: live, safe: issues.length === 0, issues };
}
