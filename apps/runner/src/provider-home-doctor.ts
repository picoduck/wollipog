import { closeSync, constants, fstatSync, openSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { providerHomeRunnerMarker } from "./provider-home-lease-evidence.js";
import { ProviderHomeLeaseRegistry, providerHomeLeaseRefusalKind, type ProviderHomeLeaseRefusalKind } from "./provider-home-lease.js";

class DoctorRefusal extends Error {
  constructor(readonly kind: ProviderHomeLeaseRefusalKind) { super(kind); }
}

type RegistryFactory = (owner: string, dataDir: string) => ProviderHomeLeaseRegistry;
const HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** Local OS-owner maintenance, never an agent RPC. It uses the normal fenced journal API and
 * exact authorization; elevated procfs read access does not replace abandonment or profile proof.
 * No provider is launched, no process is stopped, and this command never elevates itself. */
export function runProviderHomeDoctor(
  argv: readonly string[],
  output: (value: string) => unknown,
  factory: RegistryFactory = (owner, dataDir) => new ProviderHomeLeaseRegistry(owner, {
    helperDataDir: dataDir, runnerMarker: providerHomeRunnerMarker(),
  }),
): void {
  if (process.platform !== "linux") throw new Error("Provider HOME recovery doctor requires Linux.");
  const [command, ...rest] = argv;
  if (command !== "inspect" && command !== "recover") throw new Error("Provider HOME doctor requires inspect or recover.");
  const allowed = new Set(["--data-dir", "--home", "--expected-pid-namespace", "--stale-tip-hash", "--authorization-id"]);
  const args = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]!, value = rest[i + 1];
    if (!allowed.has(key) || args.has(key) || !value || value.startsWith("--") || value.includes("\0")) {
      throw new Error("Invalid or duplicate provider HOME doctor argument.");
    }
    args.set(key, value);
  }
  const data = args.get("--data-dir"), homeArg = args.get("--home"), namespace = args.get("--expected-pid-namespace");
  if (!data || !homeArg || !namespace) throw new Error("Provider HOME doctor requires data directory, HOME, and expected host PID namespace.");
  if (!/^pid:\[[1-9][0-9]*\]$/u.test(namespace) || readlinkSync("/proc/self/ns/pid") !== namespace) {
    throw new Error("PID namespace does not match the operator's host snapshot; use the host terminal.");
  }
  const tip = args.get("--stale-tip-hash"), authorization = args.get("--authorization-id");
  if (command === "recover" && (!tip || !HASH.test(tip) || !authorization || !UUID.test(authorization))) {
    throw new Error("Recovery requires an exact stale-tip hash and authorization UUID.");
  }
  if (command === "inspect" && (tip || authorization)) throw new Error("Inspection does not accept a recovery authorization.");
  const uid = process.getuid!();
  if (process.geteuid!() !== uid) throw new Error("Recovery requires matching real and effective OS user IDs.");
  let home: string, dataDir: string, owner: string;
  try {
    home = realpathSync(homeArg); dataDir = realpathSync(data);
    for (const directory of [home, dataDir]) {
      const stat = statSync(directory);
      if (!stat.isDirectory() || stat.uid !== uid) throw new Error();
    }
    const fd = openSync(join(dataDir, ".wollipog-runner-owner-v2.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.uid !== uid || stat.nlink !== 1 || (stat.mode & 0o022) !== 0 || stat.size > 4096) throw new Error();
      const record = JSON.parse(readFileSync(fd, "utf8")) as { version?: unknown; ownerHash?: unknown };
      if (record.version !== 2 || typeof record.ownerHash !== "string" || !HASH.test(record.ownerHash)) throw new Error();
      owner = record.ownerHash;
    } finally { closeSync(fd); }
  } catch {
    throw new Error("Recovery metadata must be safe and owned by the executing OS user; do not run this command as another user.");
  }
  const registry = factory(owner, dataDir);
  try {
    const found = registry.inspectHome(home);
    if (command === "inspect") {
      const { createdAt, ...safe } = found;
      output(`${JSON.stringify({ ...safe, ...(createdAt && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(createdAt) ? { createdAt } : {}) })}\n`);
      return;
    }
    if (found.state !== "stale" || found.tipHash !== tip) throw new DoctorRefusal("stale_tip_changed");
    if (found.refusal !== null) throw new DoctorRefusal(found.refusal ?? "unverifiable");
    // The registry repeats proof and exact-tip validation while publishing; this inspection is
    // explanatory only. Do not turn the inspection result into an injected or cached proof.
    registry.recoverStaleLease(home, "skills", { staleTipHash: tip!, authorizationId: authorization! });
    output(`${JSON.stringify({ state: "released", authorizationId: authorization })}\n`);
  } catch (error) {
    const kind = providerHomeLeaseRefusalKind(error) ?? (error instanceof DoctorRefusal ? error.kind : "unverifiable");
    if (kind === "recovery_unconfirmed") {
      throw new Error("Provider HOME recovery may already have been published but could not be confirmed. Preserve the journal and inspect before retrying.");
    }
    throw new Error(`Provider HOME doctor refused: ${kind}. Preserve the journal and inspect again.`);
  }
}
