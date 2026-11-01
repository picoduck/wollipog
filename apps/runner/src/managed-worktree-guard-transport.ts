/** Shared socket framing and judge, used only by the fixed verdict worker. */
import type { Socket } from "node:net";
import { managedWorktreeGuardDecision, managedWorktreeGuardOutcome, parseManagedWorktreeGuardVerdictRequest, type ManagedWorktreeGuardOutcome } from "./managed-worktree-guard.js";
import type { ManagedWorktreeProtection } from "./managed-worktree-protection.js";
import { parsePolicyHookRelayRequest, policyHookRelayAnswer, type PolicyHookRelayRequest } from "./policy-hook-relay.js";
type GuardProtectionsLoader = () => ManagedWorktreeProtection[];
// The hook payload (at most 1 MB, up to six bytes per byte once JSON-escaped) plus the sidecar's
// environment, bounded at MAX_FORWARDED_ENVIRONMENT_BYTES serialized, fits in this original cap.
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

function judge(request: string, loadProtections: GuardProtectionsLoader, guardStateDirectory: string): ManagedWorktreeGuardOutcome {
  let parsed: ReturnType<typeof parseManagedWorktreeGuardVerdictRequest>;
  try {
    parsed = parseManagedWorktreeGuardVerdictRequest(request);
  } catch (error) {
    return {
      stdout: "",
      stderr: `Wollipog could not inspect this tool call (managed worktree guard received an unreadable verdict request: ${(error as Error).message}), so it was not run.\n`,
      exitCode: 2,
    };
  }
  // Judged in the SIDECAR's environment, which is the provider's, never the runner's own (#1324).
  return managedWorktreeGuardOutcome(
    managedWorktreeGuardDecision(parsed.hookInput, loadProtections, guardStateDirectory, parsed.environment),
  );
}

export function serveVerdict(
  socket: Socket,
  loadProtections: GuardProtectionsLoader,
  guardStateDirectory: string,
  relay?: (request: PolicyHookRelayRequest, signal: AbortSignal) => Promise<string>,
  beforeSend: () => void = () => {},
): void {
  const chunks: Buffer[] = [];
  let total = 0;
  let relaying = false;
  socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy());
  socket.on("error", () => socket.destroy());
  socket.on("data", (chunk: Buffer) => {
    if (relaying) return;
    total += chunk.length;
    // An oversized payload gets no verdict at all; the sidecar reads that as a refusal.
    if (total > MAX_REQUEST_BYTES) {
      socket.destroy();
      return;
    }
    chunks.push(chunk);
    // The two requests are framed differently, on purpose. A guard request ends with the client's
    // FIN. A relay request ends with a NEWLINE and the client keeps its side open, because a
    // relayed ask can park and the runner has to learn when its sidecar goes away: measured on
    // Linux, a peer that has already sent FIN and then dies produces no further event here, so a
    // FIN-framed relay could never be abandoned (review CR-1.1). Serialized JSON holds no raw
    // newline, so a newline before FIN cannot be a guard request.
    if (!chunk.includes(0x0a)) return;
    const received = Buffer.concat(chunks);
    let request: PolicyHookRelayRequest | null = null;
    try {
      if (relay) request = parsePolicyHookRelayRequest(JSON.parse(received.subarray(0, received.indexOf(0x0a)).toString("utf8")));
    } catch {
      // A broken relay request is refused like any other below.
    }
    if (!request || !relay) {
      // Newline-framed but not a relay request this socket serves (a path socket relays nothing):
      // closed without an answer, which the sidecar reads as its fail-closed outcome. Waiting for a
      // FIN that a relay client never sends would only hold the connection until the idle timeout.
      socket.destroy();
      return;
    }
    relaying = true;
    // A relayed `PreToolUse` may park for as long as a human takes to answer, so the idle timeout
    // that bounds a guard verdict does not apply once the request is in.
    socket.setTimeout(0);
    const abort = new AbortController();
    socket.once("close", () => abort.abort());
    relay(request, abort.signal).then(
      (output) => { if (!socket.destroyed) socket.end(policyHookRelayAnswer(output)); },
      () => socket.destroy(),
    );
  });
  socket.on("end", () => {
    if (socket.destroyed) return;
    if (relaying) {
      // The sidecar went away before its answer (Claude killed it): stop on its behalf.
      socket.destroy();
      return;
    }
    try {
      let loaded = false;
      const outcome = judge(Buffer.concat(chunks).toString("utf8"), () => {
        loaded = true;
        return loadProtections();
      }, guardStateDirectory);
      if (loaded) beforeSend();
      socket.end(JSON.stringify(outcome));
    } catch {
      socket.destroy(); // A concurrent list change must never send the old allow.
    }
  });
}

