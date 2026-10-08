import type { RunnerToControlPlane } from "@wollipog/protocol";
import { MAX_RUNNER_CLIENT_MESSAGE_BYTES } from "./runner-channel.js";

/** Stateful runner frames stay FIFO while registration yields. Liveness and correlated replies
 * bypass this queue at the authenticated route. Disconnected sockets drop unprocessed frames. */
// These are liveness/credential handshakes and correlated request replies, not unsolicited
// authoritative session state. Keep HTTP/Agent Control round-trips live during the inventory.
// Durable command/status receipts deliberately remain FIFO with the snapshots.
const INVENTORY_BYPASS_TYPES = new Set([
  "heartbeat", "agent_control_credential", "policy_hook_credential",
  "policy_hook_decision_recorded", "workflow_action_admission_recorded", "workflow_action_reconciliation_result",
  "git_result", "session_history_result", "session_history_page_result", "reprocess_session_result",
  "list_external_sessions_result", "adopt_session_result", "list_directory_result", "list_session_files_result",
  "read_session_file_result", "search_workspace_references_result", "create_workspace_reference_result",
  "shell_open_result", "rewind_result", "fork_result", "session_worktree_result", "workspace_worktree_setup_result",
  "logout_agent_result", "switch_session_provider_account_result", "inspect_provider_authentication_result",
  "select_provider_authentication_account_result", "acp_registry_approval_result", "host_action_result",
  "interrupt_turn_result", "stop_background_job_result", "read_queued_prompt_result", "edit_queued_prompt_result",
  "provider_login_result", "remove_provider_account_result", "session_worktree_progress",
  "campaign_forge_observe_result",
]);

export function runnerFrameBypassesInventory(type: string): boolean {
  return INVENTORY_BYPASS_TYPES.has(type);
}

/** The session a queued runner frame acts on, or null for a frame about the runner as a whole. */
export function runnerFrameSessionKey(message: RunnerToControlPlane): string | null {
  // Frames are cast, not validated, until their handler runs; a malformed one must not throw here.
  const fields = message as { sessionId?: unknown; snapshot?: { id?: unknown } | null };
  const sessionId = message.type === "session_runtime_updated" ? fields.snapshot?.id : fields.sessionId;
  return typeof sessionId === "string" ? sessionId : null;
}

/** Kept separate from queue accounting so the actual WebSocket close handshake can be tested. */
export function setRunnerReceivePressure(
  socket: { readyState: number; pause(): void; resume(): void }, paused: boolean,
): boolean {
  // A graceful close still needs to read the peer's acknowledgement. ws permits resume() in
  // CLOSING; skipping it strands a pressure-paused close until the transport's close timer.
  if (socket.readyState !== 1 && (paused || socket.readyState !== 2)) return false;
  if (paused) socket.pause();
  else socket.resume();
  return true;
}

/** Starts work a frame needs before it can be handled (a large event payload being made durable
 * off the event loop, #2794) while earlier frames are still queued, so that work overlaps. Frames
 * are still handled strictly in arrival order. */
export interface RunnerFramePreparation<T, P> {
  /** Whether a frame acts on the runner as a whole; no later frame is prepared before it is handled. */
  runnerWide(message: T): boolean;
  /** Called once per frame, in arrival order; the result is passed to handle. */
  prepare(message: T): P | undefined;
  /** Releases the prepared value of a frame that close() dropped. */
  discard(prepared: P): void;
}

interface QueuedFrame<T, P> {
  message: T;
  bytes: number;
  runnerWide: boolean;
  prepared?: P;
}

export class RunnerFrameQueue<T, P = never> {
  private pending: Array<QueuedFrame<T, P>> = [];
  private bytes = 0;
  private draining = false;
  private closed = false;
  private pressured = false;
  private inventoryFrameReserve = 0;
  /** Queued frames are prepared as a prefix of `pending`; this is its length. */
  private preparedCount = 0;
  /** The frame being handled is runner-wide, so nothing behind it may be prepared yet. */
  private handlingRunnerWide = false;

  constructor(
    private readonly handle: (message: T, prepared?: P) => Promise<void>,
    private readonly onFailure: () => void,
    private limits = { frames: 4096, bytes: 2 * MAX_RUNNER_CLIENT_MESSAGE_BYTES },
    private readonly afterDrain: () => Promise<void> = async () => {},
    private readonly onPressure: (paused: boolean) => void = () => {},
    private readonly preparation?: RunnerFramePreparation<T, P>,
  ) {}

  /** The early registration ACK legitimately triggers one negotiated frame per retained session.
   * Reserve that finite advertised count plus ordinary replay headroom; the byte ceiling remains
   * fixed regardless of inventory size. Call only after authenticating the registration. */
  reserveInventory(snapshotCount: number): void {
    if (!Number.isSafeInteger(snapshotCount) || snapshotCount < 0) return;
    this.inventoryFrameReserve = Math.max(this.inventoryFrameReserve, snapshotCount);
    this.limits = { ...this.limits, frames: Math.max(this.limits.frames, snapshotCount + 4096) };
  }

  enqueue(message: T, bytes: number): void {
    if (this.closed) return;
    if (this.pending.length >= this.limits.frames || this.bytes + bytes > this.limits.bytes) {
      this.close();
      this.onFailure();
      return;
    }
    let runnerWide = true;
    try {
      runnerWide = this.preparation ? this.preparation.runnerWide(message) : true;
    } catch {
      // A frame that cannot be classified is treated as acting on the whole runner.
    }
    this.pending.push({ message, bytes, runnerWide });
    this.bytes += bytes;
    this.updatePressure();
    this.prepareAhead();
    if (!this.draining) void this.drain();
  }

  close(): void {
    this.closed = true;
    const dropped = this.pending.slice(0, this.preparedCount);
    this.pending = [];
    this.preparedCount = 0;
    this.bytes = 0;
    this.updatePressure();
    for (const frame of dropped) {
      if (frame.prepared !== undefined) this.discard(frame.prepared);
    }
  }

  private discard(prepared: P): void {
    try {
      this.preparation?.discard(prepared);
    } catch {
      // Releasing is best effort; startup recovery owns anything left behind.
    }
  }

  /** Prepare queued frames in arrival order, up to and including the first runner-wide one: a
   * frame after it may depend on what it changes (registration materializes sessions). */
  private prepareAhead(): void {
    if (!this.preparation || this.handlingRunnerWide) return;
    while (this.preparedCount < this.pending.length) {
      if (this.preparedCount > 0 && this.pending[this.preparedCount - 1]!.runnerWide) return;
      const frame = this.pending[this.preparedCount++]!;
      try {
        frame.prepared = this.preparation.prepare(frame.message);
      } catch {
        // A malformed frame runs unprepared, so its handler rejects it the usual way.
      }
    }
  }

  private updatePressure(): void {
    // Pause well below the hard ceiling, leaving room for the socket's already-buffered data
    // and one full legal frame. Hysteresis prevents pause/resume chatter on a busy stream.
    // The early ACK permits an entire advertised inventory to arrive before registration has
    // finished. Do not pause that legitimate metadata burst and strand liveness frames behind it.
    // Byte pressure still paces large snapshots/output at the same fixed memory ceiling.
    const highFrames = this.inventoryFrameReserve + Math.max(1,
      Math.min(1024, Math.floor((this.limits.frames - this.inventoryFrameReserve) / 2)));
    const highBytes = this.limits.bytes / 4;
    const paused = !this.closed && (this.pressured
      ? this.pending.length > highFrames / 2 || this.bytes > highBytes / 2
      : this.pending.length >= highFrames || this.bytes >= highBytes);
    if (paused === this.pressured) return;
    this.pressured = paused;
    this.onPressure(paused);
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (!this.closed) {
        if (this.pending.length === 0) {
          await this.afterDrain();
          if (this.pending.length === 0) break;
          continue;
        }
        this.prepareAhead();
        const next = this.pending.shift()!;
        this.preparedCount = Math.max(0, this.preparedCount - 1);
        this.bytes -= next.bytes;
        this.updatePressure();
        this.handlingRunnerWide = next.runnerWide;
        this.prepareAhead();
        // The handler may wait for its own preparation; frames behind it stay queued and counted.
        try {
          await this.handle(next.message, next.prepared);
        } finally {
          this.handlingRunnerWide = false;
        }
        this.prepareAhead();
        // A replay burst must not become a synchronous loop once registration completes.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } catch {
      this.close();
      this.onFailure();
    } finally {
      this.draining = false;
    }
  }
}
