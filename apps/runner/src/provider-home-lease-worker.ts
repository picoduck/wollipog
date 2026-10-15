import { parentPort, workerData } from "node:worker_threads";
import { ProviderHomeLeaseRegistry, providerHomeLeaseRefusalKind, type ProviderHomeLeaseOptions } from "./provider-home-lease.js";
import { boundedLeaseWorkerFrame, isLeaseWorkerAcquisition, leaseWorkerFrameKeys, LEASE_WORKER_LIMITS, LEASE_WORKER_REFERENCE_LIMIT, validLeaseWorkerOperation, type LeaseWorkerExecute, type LeaseWorkerAccept, type LeaseWorkerError, type LeaseWorkerReply } from "./provider-home-lease-worker-protocol.js";

/** Only the fixed source/SEA entry starts this worker; there is no public RPC/CLI entry. */
export function runProviderHomeLeaseWorker(): void {
  if (!parentPort || typeof workerData?.epoch !== "string" || !/^[a-f0-9-]{36}$/u.test(workerData.epoch)) throw new Error("invalid lease worker startup");
  const port = parentPort, epoch: string = workerData.epoch;
  const options: ProviderHomeLeaseOptions = { helperDataDir: workerData.helperDataDir,
    ...workerData.tests,
    onDiagnostic: d => send({ kind: "diagnostic", epoch, ...d }),
  };
  const registry = new ProviderHomeLeaseRegistry(workerData.ownerHash, options);
  let prepared: { request: LeaseWorkerExecute; reply: Extract<LeaseWorkerReply, { kind: "receipt" | "done" }>; cancel?: () => boolean } | undefined;
  let lastId: string | undefined;
  let completedAcquisition: { id: string; home: string; cancel: () => boolean } | undefined;
  // Exact-entry release handles for completed acquire_reference operations, keyed by their id.
  const references = new Map<string, { home: string; release: () => boolean }>();
  function send(reply: LeaseWorkerReply): void {
    if (!boundedLeaseWorkerFrame(reply, LEASE_WORKER_LIMITS.responseBytes)) throw new Error("lease worker response limit");
    port.postMessage(reply);
  }
  const fail = (error: unknown): LeaseWorkerError => {
    const kind = providerHomeLeaseRefusalKind(error);
    if (kind === "busy" || kind === "foreign_owner" || kind === "foreign_host") return kind;
    const message = error instanceof Error ? error.message : "";
    return message.includes("helper unavailable") ? "unavailable" : /already in use|publication is in progress/u.test(message) ? "busy" : "refusal";
  };
  port.on("message", (message: LeaseWorkerExecute | LeaseWorkerAccept) => {
    if (!boundedLeaseWorkerFrame(message, LEASE_WORKER_LIMITS.requestBytes) || message?.epoch !== epoch ||
        typeof message.id !== "string" || !/^[a-f0-9-]{36}$/u.test(message.id)) throw new Error("invalid lease worker control frame");
    if (message.kind === "execute") {
      if (!leaseWorkerFrameKeys(message, ["kind", "epoch", "id", "deadline", "operation"]) || prepared || message.id === lastId || !validLeaseWorkerOperation(message.operation) || !Number.isSafeInteger(message.deadline) ||
          message.deadline > Date.now() + LEASE_WORKER_LIMITS.deadlineMs) throw new Error("invalid lease worker execution receipt");
      const reply: Extract<LeaseWorkerReply, { kind: "receipt" | "done" }> = { kind: "receipt", epoch, id: message.id, ok: false, value: false };
      prepared = { request: message, reply };
      if (message.deadline <= Date.now()) reply.error = "expired";
      else try {
        const op = message.operation;
        if (op.method === "cancel") {
          if (completedAcquisition?.id !== op.completedId || completedAcquisition.home !== op.home) throw new Error("unproved cancellation receipt");
          references.delete(op.completedId);
          reply.value = completedAcquisition.cancel();
          if (!reply.value) reply.error = "cancel_release_failed";
        } else if (op.method === "acquire" || op.method === "acquire_reference") {
          if (op.method === "acquire_reference" && references.size >= LEASE_WORKER_REFERENCE_LIMIT) reply.error = "busy";
          else {
            const acquisition = registry.acquireHomeWithReceipt(op.home, op.provider);
            reply.value = acquisition.first; prepared.cancel = acquisition.cancel;
          }
        } else if (op.method === "release_reference" || op.method === "retain_reference") {
          const reference = references.get(op.referenceId);
          if (!reference || reference.home !== op.home) throw new Error("unproved reference release");
          references.delete(op.referenceId);
          reply.value = op.method === "release_reference" ? reference.release() : true;
        } else if (op.method === "release") reply.value = registry.releaseHome(op.home);
        else {
          reply.value = registry.releaseAll();
          if (reply.value) references.clear();
        }
        if (reply.error) { send(reply); return; }
        reply.ok = true;
      } catch (error) { reply.error = fail(error); }
      send(reply);
    } else if (message.kind === "accept") {
      if (!leaseWorkerFrameKeys(message, ["kind", "epoch", "id", "cancel"]) || !prepared || prepared.request.id !== message.id || typeof message.cancel !== "boolean") throw new Error("unproved lease worker acceptance");
      const { request, reply, cancel } = prepared;
      // No second operation can interleave between completion and this exact reference unwind.
      if (message.cancel && reply.ok && isLeaseWorkerAcquisition(request.operation.method)) {
        const released = cancel?.() === true;
        reply.ok = false; reply.value = false; reply.error = released ? "cancelled" : "cancel_release_failed";
      }
      send({ ...reply, kind: "done" });
      const op = request.operation;
      completedAcquisition = undefined;
      if (reply.ok && (op.method === "acquire" || op.method === "acquire_reference")) {
        completedAcquisition = { id: request.id, home: op.home, cancel: cancel! };
        if (op.method === "acquire_reference") references.set(request.id, { home: op.home, release: cancel! });
      }
      prepared = undefined; lastId = request.id;
      if (request.operation.method === "close" && reply.ok && reply.value) port.close();
    } else throw new Error("unknown lease worker control frame");
  });
  send({ kind: "ready", epoch, pid: process.pid });
}

runProviderHomeLeaseWorker();
