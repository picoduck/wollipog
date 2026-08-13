/**
 * Durable per-session terminal registry. The runner owns processes; the control plane owns
 * bounded output history and reconnect state. Runner snapshots are idempotent by sequence and an
 * inventory fence resolves processes that disappeared while the transport was down.
 */

import type {
  ShellHistoryPage,
  ShellKind,
  ShellOutputChunk,
  ShellSnapshotMessage,
  ShellView,
} from "@wollipog/protocol";
import { runnerSupportsProtocol } from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";

export class ShellRegistry {
  constructor(private readonly db: ControlPlaneDb) {}

  nextName(sessionId: string): string {
    return this.db.nextShellName(sessionId);
  }

  create(input: {
    shellId: string;
    sessionId: string;
    runnerId: string;
    name: string;
    createdAt: number;
    pty?: boolean;
    kind?: ShellKind;
  }): ShellView {
    return this.db.createShell(input);
  }

  setPty(shellId: string, pty: boolean, now: number): ShellView | null {
    return this.db.setShellPty(shellId, pty, now);
  }

  get(shellId: string): (ShellView & { runnerId: string }) | undefined {
    return this.db.getShell(shellId) ?? undefined;
  }

  list(sessionId: string): ShellView[] {
    return this.db.listShells(sessionId);
  }

  history(shellId: string, after: number, limit: number): ShellHistoryPage | null {
    return this.db.shellHistory(shellId, after, limit);
  }

  output(
    runnerId: string,
    shellId: string,
    stream: "stdout" | "stderr",
    data: string,
    seq: number | undefined,
    now: number,
  ): ShellOutputChunk | null {
    return this.db.appendShellOutput(runnerId, shellId, { seq, stream, data }, now);
  }

  snapshot(runnerId: string, snapshot: ShellSnapshotMessage, now: number): ShellView | null {
    return this.db.applyShellSnapshot(runnerId, snapshot, now);
  }

  inventoryComplete(runnerId: string, shellIds: string[], now: number): ShellView[] {
    return this.db.completeShellInventory(runnerId, shellIds, now);
  }

  markReconnecting(runnerId: string, now: number): ShellView[] {
    return this.db.markRunnerShellsReconnecting(runnerId, now);
  }

  reconcileStartup(now: number): number {
    return this.db.markAllRunningShellsReconnecting(now);
  }

  /** Pre-v57 runners cannot close an authoritative inventory after reconnect. Resolve any rows
   * left reconnecting by a control-plane restart instead of presenting permanent ghost shells. */
  reconcileRegistration(runnerId: string, protocolVersion: number | null | undefined, now: number): ShellView[] {
    return runnerSupportsProtocol(protocolVersion, "durableSessionShells")
      ? []
      : this.inventoryComplete(runnerId, [], now);
  }

  exit(
    runnerId: string,
    shellId: string,
    code: number | null,
    outputSeq: number | undefined,
    now: number,
  ): ShellView | null {
    return this.db.exitShell(runnerId, shellId, code, outputSeq, now);
  }

  remove(shellId: string, runnerId: string, now: number): void {
    this.db.deleteShell(shellId, runnerId, now);
  }

  discardUnopened(shellId: string, runnerId: string): void {
    this.db.discardUnopenedShell(shellId, runnerId);
  }

  pendingCloseIds(runnerId: string): string[] {
    return this.db.pendingShellCloseIds(runnerId);
  }

  removeForSession(sessionId: string): void {
    this.db.deleteShellsForSession(sessionId);
  }
}
