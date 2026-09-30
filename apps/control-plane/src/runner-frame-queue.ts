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

export class RunnerFrameQueue<T> {
  private pending: Array<{ message: T; bytes: number }> = [];
  private bytes = 0;
  private draining = false;
  private closed = false;

  constructor(
    private readonly handle: (message: T) => Promise<void>,
    private readonly onFailure: () => void,
    private readonly limits = { frames: 4096, bytes: 64 * 1024 * 1024 },
  ) {}

  enqueue(message: T, bytes: number): void {
    if (this.closed) return;
    if (this.pending.length >= this.limits.frames || this.bytes + bytes > this.limits.bytes) {
      this.close();
      this.onFailure();
      return;
    }
    this.pending.push({ message, bytes });
    this.bytes += bytes;
    if (!this.draining) void this.drain();
  }

  close(): void {
    this.closed = true;
    this.pending = [];
    this.bytes = 0;
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (!this.closed && this.pending.length) {
        const next = this.pending.shift()!;
        this.bytes -= next.bytes;
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
