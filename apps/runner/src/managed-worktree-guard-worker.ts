import { createServer, type Socket } from "node:net";
import { parentPort, receiveMessageOnPort, workerData, type MessagePort } from "node:worker_threads";
import { managedWorktreeGuardSocketAddress, parseManagedWorktreeGuardProtections, readManagedWorktreeGuardProtections } from "./managed-worktree-guard.js";
import { serveVerdict } from "./managed-worktree-guard-transport.js";
import type { ManagedWorktreeProtection } from "./managed-worktree-protection.js";
import type { GuardSocketWorkerData } from "./managed-worktree-guard-worker-client.js";
import { policyHookRelayRequest } from "./policy-hook-relay.js";

/** Versioned in-memory authority; an unknown, missing, invalidated or racing list refuses. */
export class GuardWorkerProtectionList {
  private current = 0;
  private protections: ManagedWorktreeProtection[] | null = null;
  private judged = 0;
  constructor(private readonly expected: Int32Array, private readonly updates: MessagePort) {
    updates.on("message", (message: unknown) => this.receive(message));
  }
  private receive(message: unknown): void {
    const value = message as { version?: unknown; protections?: unknown } | null;
    if (!value || !Number.isSafeInteger(value.version) || (value.version as number) !== this.current + 1 ||
        (value.version as number) >= 0x7fffffff) throw new Error("unknown guard protection list version");
    const protections = value.protections === null ? null :
      parseManagedWorktreeGuardProtections(JSON.stringify({ version: 1, protections: value.protections }));
    this.protections = protections;
    this.current = value.version as number;
  }
  read(): ManagedWorktreeProtection[] {
    // Queued messages need not have reached their event-loop callback before a socket's FIN.
    // Drain synchronously, then check the shared publication counter. No main-thread RPC.
    let queued: ReturnType<typeof receiveMessageOnPort>;
    while ((queued = receiveMessageOnPort(this.updates))) this.receive(queued.message);
    this.judged = Atomics.load(this.expected, 0);
    if (this.judged <= 0 || this.judged !== this.current) throw new Error("unknown guard protection list version");
    if (!this.protections) throw new Error("the runner holds no protected worktree list for this session");
    return this.protections;
  }
  verify(): void {
    if (this.judged !== Atomics.load(this.expected, 0)) throw new Error("guard protection list changed during judgment");
  }
}

if (parentPort) {
  const port = parentPort;
  const data = workerData as GuardSocketWorkerData;
  const memory = data.protectionsFile ? null : new GuardWorkerProtectionList(new Int32Array(data.version), data.updates);
  const pending = new Map<number, { resolve: (output: string) => void; reject: () => void }>();
  let nextId = 0;
  port.on("message", (message: unknown) => {
    const reply = message as { kind?: unknown; id?: unknown; output?: unknown } | null;
    if (!reply || reply.kind !== "relayAnswer" || !Number.isSafeInteger(reply.id) ||
        (reply.output !== null && typeof reply.output !== "string")) throw new Error("invalid guard relay answer");
    const waiting = pending.get(reply.id as number);
    if (!waiting) return; // A sidecar can disconnect while its answer crosses the port.
    pending.delete(reply.id as number);
    if (typeof reply.output === "string") waiting.resolve(reply.output);
    else waiting.reject();
  });
  const server = createServer((socket: Socket) => serveVerdict(socket,
    () => data.protectionsFile ? readManagedWorktreeGuardProtections(data.protectionsFile) : memory!.read(),
    data.guardStateDirectory,
    data.protectionsFile ? undefined : (request, signal) => new Promise<string>((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      signal.addEventListener("abort", () => {
        pending.delete(id);
        port.postMessage({ kind: "abandon", id });
        reject(new Error("sidecar disconnected"));
      }, { once: true });
      port.postMessage({ kind: "relay", id, request: JSON.parse(policyHookRelayRequest(request)) });
    }),
    () => memory?.verify(),
  ));
  // Startup or runtime listener failure exits this worker. No fallback judge or allow exists.
  server.on("error", (error) => { throw error; });
  server.listen(managedWorktreeGuardSocketAddress(data.address, data.platform), () => {
    port.postMessage({ kind: "ready", address: data.address });
  });
  port.on("close", () => process.exit(1));
}
