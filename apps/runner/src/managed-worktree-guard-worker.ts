import { createServer, type Server, type Socket } from "node:net";
import { parentPort, receiveMessageOnPort, workerData, MessagePort } from "node:worker_threads";
import { managedWorktreeGuardProtectionsDocument, managedWorktreeGuardSocketAddress, parseManagedWorktreeGuardProtections, readManagedWorktreeGuardProtections } from "./managed-worktree-guard.js";
import { serveVerdict } from "./managed-worktree-guard-transport.js";
import type { ManagedWorktreeProtection } from "./managed-worktree-protection.js";
import type { GuardSocketWorkerOpen } from "./managed-worktree-guard-worker-client.js";
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
    if (value.protections !== null && !Array.isArray(value.protections)) throw new Error("invalid guard protection list");
    const protections = value.protections === null ? null :
      parseManagedWorktreeGuardProtections(managedWorktreeGuardProtectionsDocument(value.protections));
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
  if (workerData?.protocol !== 1) throw new Error("invalid guard worker startup");
  const port = parentPort;
  const listeners = new Map<number, { server: Server; connections: Set<Socket>; updates: MessagePort;
    pending: Map<number, { resolve: (output: string) => void; reject: () => void }> }>();
  let lastListenerId = 0;

  function open(data: GuardSocketWorkerOpen): void {
    if (!Number.isSafeInteger(data.listenerId) || data.listenerId <= lastListenerId ||
        typeof data.address !== "string" || typeof data.guardStateDirectory !== "string" ||
        !(data.version instanceof SharedArrayBuffer) || data.version.byteLength !== 4 || !(data.updates instanceof MessagePort) ||
        (data.protectionsFile !== undefined && typeof data.protectionsFile !== "string")) throw new Error("invalid guard listener startup");
    lastListenerId = data.listenerId;
    // The closure binds this socket to this source and counter. No client request selects a list.
    const memory = data.protectionsFile ? null : new GuardWorkerProtectionList(new Int32Array(data.version), data.updates);
    const pending = new Map<number, { resolve: (output: string) => void; reject: () => void }>();
    const connections = new Set<Socket>();
    let nextRequestId = 0;
    const server = createServer((socket: Socket) => {
      connections.add(socket);
      socket.once("close", () => connections.delete(socket));
      serveVerdict(socket,
        () => data.protectionsFile ? readManagedWorktreeGuardProtections(data.protectionsFile) : memory!.read(),
        data.guardStateDirectory,
        data.protectionsFile ? undefined : (request, signal) => new Promise<string>((resolve, reject) => {
          const requestId = ++nextRequestId;
          if (!Number.isSafeInteger(requestId)) throw new Error("guard relay id exhausted");
          pending.set(requestId, { resolve, reject });
          signal.addEventListener("abort", () => {
            pending.delete(requestId);
            port.postMessage({ kind: "abandon", listenerId: data.listenerId, requestId });
            reject(new Error("sidecar disconnected"));
          }, { once: true });
          port.postMessage({ kind: "relay", listenerId: data.listenerId, requestId, request: JSON.parse(policyHookRelayRequest(request)) });
        }),
        () => memory?.verify(),
      );
    });
    listeners.set(data.listenerId, { server, connections, updates: data.updates, pending });
    // Startup/listener failure exits the shared worker: all its listeners then refuse. A transient
    // accept error on a still-listening socket preserves the old per-connection behavior.
    server.on("error", (error) => { if (!server.listening) throw error; });
    server.listen(managedWorktreeGuardSocketAddress(data.address, data.platform), () => {
      port.postMessage({ kind: "listening", listenerId: data.listenerId, address: data.address });
    });
  }

  port.on("message", (message: unknown) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("invalid guard control frame");
    const reply = message as { kind?: unknown; listenerId?: unknown; requestId?: unknown; output?: unknown };
    if (reply.kind === "open") { open(message as GuardSocketWorkerOpen); return; }
    if (!Number.isSafeInteger(reply.listenerId)) throw new Error("invalid guard listener id");
    const listener = listeners.get(reply.listenerId as number);
    // An answer may cross the close acknowledgement for a disconnected/closed listener.
    if (!listener && reply.kind === "relayAnswer") return;
    if (!listener) throw new Error("unknown guard listener");
    if (reply.kind === "close") {
      for (const socket of listener.connections) socket.destroy();
      listener.updates.close();
      listener.server.close(() => {
        listeners.delete(reply.listenerId as number);
        port.postMessage({ kind: "closed", listenerId: reply.listenerId });
      });
      return;
    }
    if (reply.kind !== "relayAnswer" || !Number.isSafeInteger(reply.requestId) || (reply.requestId as number) <= 0 ||
        (reply.output !== null && typeof reply.output !== "string")) throw new Error("invalid guard relay answer");
    const waiting = listener.pending.get(reply.requestId as number);
    if (!waiting) return;
    listener.pending.delete(reply.requestId as number);
    if (typeof reply.output === "string") waiting.resolve(reply.output);
    else waiting.reject();
  });
  port.on("close", () => process.exit(1));
  port.postMessage({ kind: "booted", protocol: 1 });
}
