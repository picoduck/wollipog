/** System identity evidence for the user-private-group trust exception. */
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync } from "node:fs";

export interface GroupDatabase {
  read(path: string): string;
  entries(path: string): string[];
  exists(path: string): boolean;
  lookup(database: "passwd" | "group", key?: string): string;
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
const systemDatabase: GroupDatabase = {
  read: (path) => readFileSync(path, "utf8"),
  entries: (path) => readdirSync(path),
  exists: (path) => { try { lstatSync(path); return true; } catch (error) { if (missing(error)) return false; throw error; } },
  lookup: (database, key) => execFileSync("/usr/bin/getent", [database, ...(key ? [key] : [])], {
    encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024,
    env: { PATH: "/usr/bin:/bin", LANG: "C" },
  }),
};

/** Absence must be proven, including config fragments, activation sockets and live daemons. */
function inactiveSssd(db: GroupDatabase): boolean {
  for (const path of ["/etc/sssd/sssd.conf", "/var/lib/sss/pipes/nss", "/run/sssd", "/run/sssd.pid"]) {
    if (db.exists(path)) return false;
  }
  for (const directory of ["/etc/sssd/conf.d", "/etc/sssd/sssd.conf.d"]) {
    if (db.exists(directory) && db.entries(directory).length) return false;
  }
  const proc = db.read("/proc/mounts").split("\n").map((line) => line.split(" "))
    .find((fields) => fields[1] === "/proc" && fields[2] === "proc");
  if (!proc || proc[3]!.split(",").some((option) => option.startsWith("hidepid=") && !["hidepid=0", "hidepid=off"].includes(option))) {
    throw new Error("cannot prove NSS source sss inactive: the process table is hidden or unavailable");
  }
  for (const pid of db.entries("/proc")) {
    if (!/^\d+$/u.test(pid)) continue;
    try { if (/^sssd(?:_|$)/u.test(db.read(`/proc/${pid}/comm`).trim())) return false; }
    catch (error) { if (!missing(error)) throw error; }
  }
  return true;
}

function assertEnumerable(db: GroupDatabase): void {
  const config = db.read("/etc/nsswitch.conf");
  for (const database of ["passwd", "group", "initgroups"]) {
    const lines = config.split("\n").map((line) => line.split("#")[0]!.trim())
      .filter((line) => line.startsWith(`${database}:`));
    // NSS defaults initgroups to the group database only when it has no separate declaration.
    if (!lines.length && database === "initgroups") continue;
    if (lines.length !== 1) throw new Error(`cannot prove complete ${database} membership from NSS configuration`);
    const sources = lines[0]!.slice(database.length + 1).replace(/\[[^\]]*\]/gu, "").trim().split(/\s+/u);
    if (!sources.includes("files")) throw new Error(`cannot prove complete ${database} membership without NSS files`);
    for (const source of sources) {
      if (source === "files" || source === "systemd") continue;
      if (source === "sss" && inactiveSssd(db)) continue;
      throw new Error(`cannot prove complete group membership: NSS source ${source} is configured, active, or unknown`);
    }
  }
}

/** Check explicit members and other users' primary groups; never trust environment variables. */
export function isUserPrivateGroup(uid: number, gid: number, db: GroupDatabase = systemDatabase): boolean {
  if (process.platform !== "linux" && db === systemDatabase) throw new Error("complete local group membership proof is unavailable on this platform");
  assertEnumerable(db);
  const users = db.lookup("passwd").trim().split("\n").filter(Boolean).map((line) => line.split(":"));
  const owners = db.lookup("passwd", String(uid)).trim().split("\n").filter(Boolean).map((line) => line.split(":"));
  const groups = db.lookup("group", String(gid)).trim().split("\n").filter(Boolean).map((line) => line.split(":"));
  const allGroups = db.lookup("group").trim().split("\n").filter(Boolean).map((line) => line.split(":"));
  if (owners.length !== 1 || groups.length !== 1 || users.some((fields) => fields.length !== 7) ||
      owners[0]!.length !== 7 || groups[0]!.length !== 4 || allGroups.some((fields) => fields.length !== 4)) {
    throw new Error("system passwd/group lookup returned incomplete membership");
  }
  const owner = owners[0]!, group = groups[0]!;
  if (owner[2] !== String(uid) || owner[3] !== String(gid) || group[2] !== String(gid)) return false;
  if (!users.some((user) => user[0] === owner[0] && user[2] === owner[2] && user[3] === owner[3])) {
    throw new Error("system passwd enumeration omitted the owning user");
  }
  if (users.some((user) => user[3] === String(gid) && user[2] !== String(uid))) return false;
  if (!allGroups.some((entry) => entry.join(":") === group.join(":"))) {
    throw new Error("system group enumeration omitted the owning group");
  }
  // initgroups can grant membership from every same-gid entry, not only getgrgid's first match.
  return allGroups.filter((entry) => entry[2] === String(gid))
    .every((entry) => entry[3]!.split(",").filter(Boolean).every((member) => member === owner[0]));
}
