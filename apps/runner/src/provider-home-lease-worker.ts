import { parentPort, workerData } from "node:worker_threads";
import { leaseWorkerDelay, leaseWorkerNow, parseLeaseWorkerDeadline } from "./provider-home-lease-clock.js";
import { ProviderHomeLeaseRegistry, providerHomeLeaseRefusalKind, type ProviderHomeLeaseOptions, type ProviderHomeLeaseRefusalKind } from "./provider-home-lease.js";
import { adoptProviderProfileMarker, createProviderProfileMarker, revokeProviderProfileMarkerGrant } from "./provider-profile.js";
import { isLeaseRunnerMarker } from "./provider-home-lease-evidence.js";
import { isLeaseContainmentEvidence } from "./provider-home-lease-containment.js";
import { LeaseIoError } from "./provider-home-lease-io.js";
import { boundedLeaseWorkerFrame, isLeaseWorkerAcquisition, leaseWorkerFrameKeys, LEASE_WORKER_CLOCK, LEASE_WORKER_LIMITS, LEASE_WORKER_REFERENCE_LIMIT, validLeaseWorkerOperation, type LeaseWorkerExecute, type LeaseWorkerAccept, type LeaseWorkerError, type LeaseWorkerReply } from "./provider-home-lease-worker-protocol.js";

/** Only the fixed source/SEA entry starts this worker; there is no public RPC/CLI entry. */
export function runProviderHomeLeaseWorker(): void {
  if (!parentPort || workerData?.clock !== LEASE_WORKER_CLOCK || typeof workerData.epoch !== "string" || !/^[a-f0-9-]{36}$/u.test(workerData.epoch)) throw new Error("invalid lease worker startup");
  const instance: unknown = workerData.controlPlaneInstanceId;
  if (instance !== undefined && (typeof instance !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(instance))) throw new Error("invalid lease worker startup");
  const marker: unknown = workerData.runnerMarker;
  if (marker !== undefined && !isLeaseRunnerMarker(marker)) throw new Error("invalid lease worker startup");
  const containment: unknown = workerData.containment;
  if (containment !== undefined && (!isLeaseContainmentEvidence(containment) || marker === undefined)) throw new Error("invalid lease worker startup");
  const port = parentPort, epoch: string = workerData.epoch;
  const options: ProviderHomeLeaseOptions = { helperDataDir: workerData.helperDataDir,
    ...(instance === undefined ? {} : { controlPlaneInstanceId: instance.toLowerCase() }),
    ...(marker === undefined ? {} : { runnerMarker: marker }),
    ...(containment === undefined ? {} : { containment }),
    ...workerData.tests,
    onDiagnostic: d => send({ kind: "diagnostic", epoch, ...d }),
  };
  const registry = new ProviderHomeLeaseRegistry(workerData.ownerHash, options);
  let prepared: { request: LeaseWorkerExecute; deadline: bigint; reply: Extract<LeaseWorkerReply, { kind: "receipt" | "done" }>; cancel?: () => boolean } | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  function timely(deadline: bigint): void {
    if (leaseWorkerNow() >= deadline) throw new Error("lease worker deadline exceeded; preserve all evidence");
  }
  function watchDeadline(deadline: bigint): void {
    watchdog = setTimeout(() => {
      if (leaseWorkerDelay(deadline) > 0) { watchDeadline(deadline); return; }
      // Failure exits this worker. Termination proves neither release nor rollback.
      timely(deadline);
    }, Math.max(1, leaseWorkerDelay(deadline)));
  }
  let lastId: string | undefined;
  let completedAcquisition: { id: string; home: string; deadline: bigint; cancel: () => boolean } | undefined;
  // Exact-entry release handles for completed acquire_reference operations, keyed by their id.
  const references = new Map<string, { home: string; release: () => boolean }>();
  function send(reply: LeaseWorkerReply): void {
    if (!boundedLeaseWorkerFrame(reply, LEASE_WORKER_LIMITS.responseBytes)) throw new Error("lease worker response limit");
    port.postMessage(reply);
  }
  const code = (kind: ProviderHomeLeaseRefusalKind | null): LeaseWorkerError | undefined =>
    kind === "unverifiable" ? "invalid_journal" :
    kind === "holder_alive" || kind === "boundary_survivor" || kind === "process_survivor" || kind === "boundary_unverifiable" ||
    kind === "process_uninspectable" || kind === "process_uninspectable_not_delegated" ? kind :
    kind === "busy" || kind === "foreign_owner" || kind === "foreign_host" || kind === "profile_unsupported_control_plane" ||
    kind === "profile_unverifiable" || kind === "profile_not_granted" || kind === "profile_changed" || kind === "profile_grant_limit" ||
    kind === "stale_tip_changed" || kind === "no_reboot_proof" || kind === "recovery_unconfirmed" ? kind : undefined;
  const fail = (error: unknown): LeaseWorkerError => {
    const known = code(providerHomeLeaseRefusalKind(error));
    if (known) return known;
    if (error instanceof LeaseIoError) return error.kind === "refusal" ? "invalid_journal" : error.kind;
    return "refusal";
  };
  port.on("message", (message: LeaseWorkerExecute | LeaseWorkerAccept) => {
    if (!boundedLeaseWorkerFrame(message, LEASE_WORKER_LIMITS.requestBytes) || message?.epoch !== epoch ||
        typeof message.id !== "string" || !/^[a-f0-9-]{36}$/u.test(message.id)) throw new Error("invalid lease worker control frame");
    if (message.kind === "execute") {
      const deadline = parseLeaseWorkerDeadline(message.deadline), now = leaseWorkerNow();
      if (!leaseWorkerFrameKeys(message, ["kind", "epoch", "id", "deadline", "operation"]) || prepared || message.id === lastId || !validLeaseWorkerOperation(message.operation) || deadline === undefined ||
          deadline > now + BigInt(LEASE_WORKER_LIMITS.deadlineMs) * 1_000_000n) throw new Error("invalid lease worker execution receipt");
      const reply: Extract<LeaseWorkerReply, { kind: "receipt" | "done" }> = { kind: "receipt", epoch, id: message.id, ok: false, value: false };
      prepared = { request: message, deadline, reply };
      if (deadline <= now) reply.error = "expired";
      else try {
        const op = message.operation;
        if (op.method === "cancel") {
          if (completedAcquisition?.id !== op.completedId || completedAcquisition.home !== op.home || completedAcquisition.deadline !== deadline) throw new Error("unproved cancellation receipt");
          references.delete(op.completedId);
          reply.value = completedAcquisition.cancel();
          if (!reply.value) reply.error = "cancel_release_failed";
        } else if (op.method === "acquire" || op.method === "acquire_reference") {
          if (op.method === "acquire_reference" && references.size >= LEASE_WORKER_REFERENCE_LIMIT) reply.error = "busy";
          else {
            const acquisition = registry.acquireHomeWithReceipt(op.home, op.provider, op.profile);
            reply.value = acquisition.first; prepared.cancel = acquisition.cancel;
          }
        } else if (op.method === "profile_adopt" || op.method === "profile_revoke" || op.method === "profile_retire" || op.method === "profile_create") {
          // Grants name the attested instance this worker was started for, never a frame value.
          const controlPlaneInstanceId = options.controlPlaneInstanceId;
          if (!controlPlaneInstanceId) throw new Error("provider profile changes require an attested control-plane instance");
          if (op.method === "profile_adopt") {
            const grant = { controlPlaneInstanceId, grantId: op.grantId, grantedAt: new Date().toISOString() };
            const { marker } = registry.changeProfileMarkerWhileHeld(op.home, op.provider,
              read => adoptProviderProfileMarker(read, { provider: op.provider, grant }));
            reply.value = true; reply.profileId = marker.profileId;
          } else if (op.method === "profile_create") {
            const grant = { controlPlaneInstanceId, grantId: op.grantId, grantedAt: new Date().toISOString() };
            registry.changeProfileMarkerWhileHeld(op.home, op.provider,
              read => createProviderProfileMarker(read, { provider: op.provider, profileId: op.profileId, grant }));
            reply.value = true;
          } else if (op.method === "profile_retire") {
            reply.value = registry.retireProfileHomeWhileHeld(op.home, op.provider, controlPlaneInstanceId, op.profileId);
          } else {
            reply.value = registry.changeProfileMarkerWhileHeld(op.home, op.provider, read =>
              revokeProviderProfileMarkerGrant(read, { profileId: op.profileId, controlPlaneInstanceId, grantId: op.grantId })).changed;
          }
        } else if (op.method === "lease_inspect") {
          const found = registry.inspectHome(op.home, op.profile);
          reply.value = true;
          reply.inspection = found.state !== "stale" ? { state: found.state } : {
            state: "stale", tipHash: found.tipHash!,
            // The record's own timestamp, from the stale writer; omitted unless it is exact ISO time.
            ...(found.createdAt && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(found.createdAt) ? { createdAt: found.createdAt } : {}),
            sameHost: found.sameHost === true, hasEvidence: found.hasEvidence === true,
            refusal: found.refusal === null ? null : code(found.refusal ?? null) ?? "refusal",
            ...(found.blockingProcess ? { blockingProcess: found.blockingProcess } : {}),
          };
        } else if (op.method === "lease_recover") {
          registry.recoverStaleLease(op.home, op.provider, { staleTipHash: op.staleTipHash, authorizationId: op.authorizationId }, op.profile);
          reply.value = true;
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
        if (!reply.error) reply.ok = true;
      } catch (error) { reply.error = fail(error); }
      // Sync execution cannot be interrupted by a timer. Refuse late completion after any
      // possible publication, preserving canonical proof instead of inferring rollback.
      if (deadline > now) timely(deadline);
      send(reply);
      watchDeadline(deadline);
    } else if (message.kind === "accept") {
      if (!leaseWorkerFrameKeys(message, ["kind", "epoch", "id", "cancel"]) || !prepared || prepared.request.id !== message.id || typeof message.cancel !== "boolean") throw new Error("unproved lease worker acceptance");
      const { request, deadline, reply, cancel } = prepared;
      timely(deadline);
      // No second operation can interleave between completion and this exact reference unwind.
      if (message.cancel && reply.ok && isLeaseWorkerAcquisition(request.operation.method)) {
        const released = cancel?.() === true;
        reply.ok = false; reply.value = false; reply.error = released ? "cancelled" : "cancel_release_failed";
      }
      timely(deadline);
      send({ ...reply, kind: "done" });
      clearTimeout(watchdog); watchdog = undefined;
      const op = request.operation;
      completedAcquisition = undefined;
      if (reply.ok && (op.method === "acquire" || op.method === "acquire_reference")) {
        completedAcquisition = { id: request.id, home: op.home, deadline, cancel: cancel! };
        if (op.method === "acquire_reference") references.set(request.id, { home: op.home, release: cancel! });
      }
      prepared = undefined; lastId = request.id;
      if (request.operation.method === "close" && reply.ok && reply.value) port.close();
    } else throw new Error("unknown lease worker control frame");
  });
  send({ kind: "ready", epoch, pid: process.pid, clock: LEASE_WORKER_CLOCK });
}

runProviderHomeLeaseWorker();
