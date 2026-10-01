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
]);

export function runnerFrameBypassesInventory(type: string): boolean {
  return INVENTORY_BYPASS_TYPES.has(type);
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

export class RunnerFrameQueue<T> {
  private pending: Array<{ message: T; bytes: number }> = [];
  private bytes = 0;
  private draining = false;
  private closed = false;
  private pressured = false;
  private inventoryFrameReserve = 0;

  constructor(
    private readonly handle: (message: T) => Promise<void>,
    private readonly onFailure: () => void,
    private limits = { frames: 4096, bytes: 2 * MAX_RUNNER_CLIENT_MESSAGE_BYTES },
    private readonly afterDrain: () => Promise<void> = async () => {},
    private readonly onPressure: (paused: boolean) => void = () => {},
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
    this.pending.push({ message, bytes });
    this.bytes += bytes;
    this.updatePressure();
    if (!this.draining) void this.drain();
  }

  close(): void {
    this.closed = true;
    this.pending = [];
    this.bytes = 0;
    this.updatePressure();
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
        const next = this.pending.shift()!;
        this.bytes -= next.bytes;
        this.updatePressure();
        await this.handle(next.message);
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
