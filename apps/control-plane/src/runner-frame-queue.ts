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

/** The session a queued runner frame acts on, or null for a frame about the runner as a whole.
 * A frame keeps its order against its own session's frames and every keyless frame. */
export function runnerFrameSessionKey(message: RunnerToControlPlane): string | null {
  if (message.type === "session_runtime_updated") return message.snapshot.id;
  const sessionId = (message as { sessionId?: unknown }).sessionId;
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

/** Lets frames for one session wait for asynchronous preparation (a large event payload being
 * made durable, #2794) without holding up other sessions' frames. */
export interface RunnerFrameLanes<T, P> {
  /** The session a frame belongs to, or null for a frame that waits for every earlier frame. */
  key(message: T): string | null;
  /** Called once per frame at its turn in arrival order. A promise holds that frame, and every
   * later frame with the same key, until it settles; the settled value is passed to handle. A
   * promise must not reject; a synchronous throw leaves the frame unprepared. */
  prepare(message: T): P | Promise<P> | undefined;
  /** Releases the prepared value of a frame that close() dropped. */
  discard(prepared: P): void;
}

interface QueuedFrame<T, P> {
  message: T;
  bytes: number;
  key: string | null;
  turned: boolean;
  waiting: boolean;
  prepared?: P;
}

export class RunnerFrameQueue<T, P = never> {
  private pending: Array<QueuedFrame<T, P>> = [];
  private bytes = 0;
  private draining = false;
  private closed = false;
  private pressured = false;
  private inventoryFrameReserve = 0;
  private wake: (() => void) | null = null;

  constructor(
    private readonly handle: (message: T, prepared?: P) => Promise<void>,
    private readonly onFailure: () => void,
    private limits = { frames: 4096, bytes: 2 * MAX_RUNNER_CLIENT_MESSAGE_BYTES },
    private readonly afterDrain: () => Promise<void> = async () => {},
    private readonly onPressure: (paused: boolean) => void = () => {},
    private readonly lanes?: RunnerFrameLanes<T, P>,
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
    this.pending.push({
      message, bytes, key: this.lanes ? this.lanes.key(message) : null, turned: false, waiting: false,
    });
    this.bytes += bytes;
    this.updatePressure();
    this.signal();
    if (!this.draining) void this.drain();
  }

  close(): void {
    this.closed = true;
    const dropped = this.pending;
    this.pending = [];
    this.bytes = 0;
    this.updatePressure();
    this.signal();
    // A frame still preparing is discarded when its preparation settles (see turn).
    for (const frame of dropped) {
      if (frame.turned && !frame.waiting && frame.prepared !== undefined) this.lanes?.discard(frame.prepared);
    }
  }

  private signal(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  private updatePressure(): void {
    // Pause well below the hard ceiling, leaving room for the socket's already-buffered data
    // and one full legal frame. Hysteresis prevents pause/resume chatter on a busy stream.
    // The early ACK permits an entire advertised inventory to arrive before registration has
    // finished. Do not pause that legitimate metadata burst and strand liveness frames behind it.
    // Byte pressure still paces large snapshots/output at the same fixed memory ceiling.
    // Frames held behind a preparing frame stay counted, so they are paced the same way.
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

  private turn(frame: QueuedFrame<T, P>): void {
    frame.turned = true;
    let prepared: P | Promise<P> | undefined;
    try {
      prepared = this.lanes?.prepare(frame.message);
    } catch {
      // A malformed frame runs unprepared, so its handler rejects it the usual way.
      return;
    }
    if (!(prepared instanceof Promise)) {
      frame.prepared = prepared;
      return;
    }
    frame.waiting = true;
    void prepared.then((value) => {
      frame.prepared = value;
      frame.waiting = false;
      if (!this.pending.includes(frame)) this.lanes?.discard(value);
      this.signal();
    });
  }

  /** The earliest frame that may run: frames run in arrival order, except that a frame whose key
   * has an earlier frame still waiting waits too, and a keyless frame waits for every earlier one.
   * Every frame before a keyless one is prepared at its turn, held or not, so consecutive large
   * payloads of one session are made durable in parallel. */
  private nextRunnable(): number {
    const held = new Set<string>();
    for (let index = 0; index < this.pending.length; index++) {
      const frame = this.pending[index]!;
      if (frame.key === null) {
        if (index > 0) return -1;
      } else if (held.has(frame.key)) {
        if (!frame.turned) this.turn(frame);
        continue;
      }
      if (!frame.turned) this.turn(frame);
      if (!frame.waiting) return index;
      if (frame.key === null) return -1;
      held.add(frame.key);
    }
    return -1;
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (!this.closed) {
        const index = this.nextRunnable();
        if (index < 0) {
          await this.afterDrain();
          if (this.closed) break;
          if (this.pending.length === 0) break;
          if (this.nextRunnable() < 0) {
            await new Promise<void>((resolve) => { this.wake = resolve; });
          }
          continue;
        }
        const [next] = this.pending.splice(index, 1);
        this.bytes -= next!.bytes;
        this.updatePressure();
        await this.handle(next!.message, next!.prepared);
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
