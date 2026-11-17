import {
  ASSISTANT_THREAD_CREDENTIAL_TTL_MS,
  ASSISTANT_THREAD_HARNESSES,
  ASSISTANT_THREAD_LIMITS,
  resolveAgentHarnessRow,
  runnerCapabilityRequirementError,
  runnerSupportsProtocol,
  type AgentDefinition,
  type AgentDriverKind,
  type AssistantOwnerConfirmation,
  type AssistantThread,
  type AssistantThreadDefaultsResponse,
  type AssistantThreadHarness,
  type AssistantThreadStatus,
  type CreateSessionRequest,
  type RunnerView,
  type SessionView,
} from "@wollipog/protocol";
import type { HumanPrincipal } from "./identity.js";
import type { AssistantConnections, AssistantOperations } from "./assistant-connections.js";
import { AssistantCommandReceipts } from "./assistant-command-receipts.js";
import { AssistantOwnerConfirmationService } from "./assistant-owner-confirmations.js";
import type { AssistantThreadStore, StoredThreadState, ThreadRow } from "./assistant-thread-store.js";
import type { ControlPlaneDb } from "./db.js";
import type { Hub } from "./hub.js";
import { UNTITLED, type SessionsService } from "./sessions.js";
import { failureBody } from "./capability-refusal.js";

const DEFAULT_THREAD_TITLE = "New Thread";
const HARNESS_LABELS: Record<AssistantThreadHarness, string> = { "claude-code": "Claude Code", codex: "Codex" };
/** Codex App Server is preferred where both Codex drivers are installed. */
const HARNESS_DRIVERS: Record<AssistantThreadHarness, AgentDriverKind[]> = {
  "claude-code": ["claude-code"],
  codex: ["codex-app-server", "codex"],
};

export class AssistantThreadRefusal extends Error {
  constructor(message: string, readonly status: number, readonly details: Record<string, unknown> = {}) { super(message); }
}

function threadTitle(value: unknown): string {
  // Same rule as other owner-named resources: visible text only, bounded.
  if (typeof value !== "string" || !value.trim() || value.length > 120 || /[\p{Cc}\p{Cf}]/u.test(value.replace(/‍/gu, ""))) {
    throw new AssistantThreadRefusal("A thread title must contain 1–120 characters without control or hidden formatting characters.", 400);
  }
  return value.trim();
}

function harnessOf(value: unknown): AssistantThreadHarness {
  if (typeof value !== "string" || !(ASSISTANT_THREAD_HARNESSES as readonly string[]).includes(value)) {
    throw new AssistantThreadRefusal("harness must be claude-code or codex.", 400);
  }
  return value as AssistantThreadHarness;
}

/** The native installation this Machine launches for a harness: its selected installation first,
 * never one its installation choice excludes, the same rule every other launch uses. */
function harnessAgent(runner: RunnerView, harness: AssistantThreadHarness): AgentDefinition | undefined {
  for (const driver of HARNESS_DRIVERS[harness]) {
    const agent = resolveAgentHarnessRow(runner.agents, { agentId: driver, driver, context: { kind: "native" } });
    if (agent) return agent;
  }
  return undefined;
}

/** What a thread's status shows, from its stored state and its backing session. */
export function assistantThreadStatus(state: StoredThreadState, session: SessionView | null, pendingConfirmations = 0): AssistantThreadStatus {
  if (state === "archived" || !session || session.archived) return "archived";
  if (session.status === "input_required" || session.pendingApproval || pendingConfirmations > 0) return "needs_you";
  if (session.status === "queued" || session.status === "starting" || session.status === "running") return "working";
  return "done";
}

export interface AssistantThreadDeps {
  connections: AssistantConnections;
  /** The thread owner as an active owner now, or null; a thread credential never outlives it. */
  ownerPrincipal(userId: string, organizationId: string): HumanPrincipal | null;
  listRunners(owner: HumanPrincipal): RunnerView[];
  isRunnerOnline(runnerId: string): boolean;
  getSession(sessionId: string): SessionView | null;
  /** The owner's saved Orchestrator Child Harness driver, or null for Automatic. */
  savedChildHarnessDriver(owner: HumanPrincipal): AgentDriverKind | null;
  /** Creates the backing session exactly as an owner's New Session would, with the trusted
   * assistant marker. Never accepts the marker from request JSON. */
  createBackingSession(owner: HumanPrincipal, request: CreateSessionRequest, threadId: string):
    { ok: boolean; status: number; data?: SessionView; error?: string; [key: string]: unknown };
  archiveBackingSession(sessionId: string): { ok: boolean; status: number; error?: string };
  broadcast(userId: string, thread: AssistantThread): void;
  /** The thread's owner confirmations waiting for its owner (#4665). */
  pendingConfirmations?(threadId: string): AssistantOwnerConfirmation[];
  now?(): number;
}

/** Owner operations on Wollipog Assistant threads. The thread record is authoritative for the
 * thread's lifecycle; the backing session is authoritative for its live status and transcript. */
export class AssistantThreads {
  constructor(private readonly store: AssistantThreadStore, private readonly deps: AssistantThreadDeps) {}

  private now(): number { return this.deps.now?.() ?? Date.now(); }

  private owned(owner: HumanPrincipal, id: string): ThreadRow {
    const row = this.store.get(id);
    if (!row || row.state === "creating" || row.owner_user_id !== owner.userId || row.organization_id !== owner.organizationId) {
      throw new AssistantThreadRefusal("Assistant thread not found for this owner.", 404);
    }
    return row;
  }

  view(row: ThreadRow, session = row.session_id ? this.deps.getSession(row.session_id) : null): AssistantThread {
    const launched = this.store.launchedSessionIds(row.id);
    const confirmations = row.state === "active" ? this.deps.pendingConfirmations?.(row.id) ?? [] : [];
    return {
      id: row.id,
      assistant: row.assistant,
      // An untitled session is named by its first message; the thread shows that name once it exists.
      title: row.title ?? (session && session.title !== UNTITLED ? session.title : DEFAULT_THREAD_TITLE),
      harness: row.harness,
      sessionId: row.session_id ?? "",
      status: assistantThreadStatus(row.state, session, confirmations.length),
      access: { level: "full_access", destructive: "ask" },
      connectionId: row.connection_id,
      launchedSessionIds: launched,
      usage: {
        launchedSessions: { used: launched.length, limit: ASSISTANT_THREAD_LIMITS.launchedSessions },
        costUsd: { used: Math.round(this.store.costs(row.id).spentUsd * 10_000) / 10_000, limit: ASSISTANT_THREAD_LIMITS.costUsd },
      },
      confirmations,
      lastActivityAt: Math.max(row.updated_at, session?.updatedAt ?? 0),
      createdAt: row.created_at,
      archivedAt: row.archived_at,
    };
  }

  list(owner: HumanPrincipal, includeArchived: boolean): AssistantThread[] {
    return this.store.listForOwner(owner.userId, owner.organizationId, includeArchived)
      .map((row) => this.view(row))
      // A backing session archived or deleted outside the thread reads as archived, so it is listed only on request.
      .filter((thread) => includeArchived || thread.status !== "archived")
      .sort((left, right) => right.lastActivityAt - left.lastActivityAt || right.createdAt - left.createdAt);
  }

  defaultHarness(owner: HumanPrincipal): AssistantThreadHarness {
    const driver = this.deps.savedChildHarnessDriver(owner);
    return driver === "codex" || driver === "codex-app-server" ? "codex" : "claude-code";
  }

  defaults(owner: HumanPrincipal): AssistantThreadDefaultsResponse {
    const online = this.deps.listRunners(owner).filter((runner) => this.deps.isRunnerOnline(runner.runnerId));
    const capable = online.filter((runner) => runnerSupportsProtocol(runner.protocolVersion, "assistantRole"));
    return {
      harness: this.defaultHarness(owner),
      harnesses: ASSISTANT_THREAD_HARNESSES.map((id) => {
        const label = HARNESS_LABELS[id];
        if (capable.some((runner) => harnessAgent(runner, id))) return { id, label, available: true };
        const reason = online.length === 0 ? "Connect a Machine to start a thread."
          : capable.length === 0 ? "Update a Machine's runner to start Wollipog Assistant threads."
          : `Install ${label} on an online Machine to start a thread with it.`;
        return { id, label, available: false, reason };
      }),
    };
  }

  /** Picks the Machine, harness installation and Location, then launches the backing session.
   * An unsupported Machine or harness is refused with guidance; it never falls back to an
   * ordinary session. */
  create(owner: HumanPrincipal, body: unknown): AssistantThread {
    const input = (body ?? {}) as Record<string, unknown>;
    if (typeof input !== "object" || Array.isArray(input)) throw new AssistantThreadRefusal("A thread request object is required.", 400);
    const unknown = Object.keys(input).filter((key) => !["harness", "title", "runnerId", "workspaceId"].includes(key));
    if (unknown.length) throw new AssistantThreadRefusal(`Unsupported thread fields: ${unknown.join(", ")}.`, 400);
    const harness = input.harness === undefined ? this.defaultHarness(owner) : harnessOf(input.harness);
    const title = input.title === undefined ? null : threadTitle(input.title);
    for (const key of ["runnerId", "workspaceId"] as const) {
      if (input[key] !== undefined && (typeof input[key] !== "string" || !input[key])) throw new AssistantThreadRefusal(`${key} must be a non-empty string.`, 400);
    }
    const runnerId = input.runnerId as string | undefined;
    const workspaceId = input.workspaceId as string | undefined;
    const label = HARNESS_LABELS[harness];

    const runners = this.deps.listRunners(owner);
    let runner: RunnerView;
    if (runnerId !== undefined) {
      const chosen = runners.find((candidate) => candidate.runnerId === runnerId);
      if (!chosen) throw new AssistantThreadRefusal("Machine not found.", 404);
      if (!this.deps.isRunnerOnline(chosen.runnerId)) throw new AssistantThreadRefusal("This Machine is offline. Connect it, or choose another Machine.", 409);
      if (!runnerSupportsProtocol(chosen.protocolVersion, "assistantRole")) {
        const { error, ...details } = runnerCapabilityRequirementError(chosen.protocolVersion, "assistantRole", "Wollipog assistant threads");
        throw new AssistantThreadRefusal(error, 409, details);
      }
      if (!harnessAgent(chosen, harness)) throw new AssistantThreadRefusal(`${label} is not available on this Machine. Install it there, or choose another harness or Machine.`, 409);
      runner = chosen;
    } else {
      const online = runners.filter((candidate) => this.deps.isRunnerOnline(candidate.runnerId));
      const capable = online.filter((candidate) => runnerSupportsProtocol(candidate.protocolVersion, "assistantRole"));
      const usable = capable.filter((candidate) => harnessAgent(candidate, harness) &&
        (workspaceId === undefined ? candidate.workspaces.length > 0 : candidate.workspaces.some((workspace) => workspace.id === workspaceId)));
      if (!usable.length) {
        if (!online.length) throw new AssistantThreadRefusal("No Machine is online. Connect a Machine to start a thread.", 409);
        if (!capable.length) {
          const { error, ...details } = runnerCapabilityRequirementError(online[0]!.protocolVersion, "assistantRole", "Wollipog assistant threads");
          throw new AssistantThreadRefusal(error, 409, details);
        }
        throw new AssistantThreadRefusal(`No online Machine can start a ${label} thread. Install ${label} on a Machine with a Location, or choose another harness.`, 409);
      }
      runner = usable[0]!;
    }
    const workspace = workspaceId === undefined ? runner.workspaces[0] : runner.workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) {
      throw new AssistantThreadRefusal(workspaceId === undefined ? "This Machine has no Location. Add one, or choose another Machine." : "Location not found on this Machine.", workspaceId === undefined ? 409 : 404);
    }
    const agent = harnessAgent(runner, harness)!;

    const now = this.now();
    const threadId = this.store.reserve(owner, harness, title, now);
    // The thread's own Assistant connection. It authenticates nothing until the session's runner
    // proxy binds a credential it minted and keeps in memory.
    const connection = this.deps.connections.createForThread(owner, threadId);
    this.store.setConnection(threadId, connection.id);
    let created: ReturnType<AssistantThreadDeps["createBackingSession"]>;
    try {
      created = this.deps.createBackingSession(owner, {
        runnerId: runner.runnerId,
        workspaceId: workspace.id,
        agentId: agent.id,
        // Without a title the session names itself from the first message, and the thread follows it.
        ...(title === null ? {} : { title }),
        useWorktree: false,
        role: "normal",
        // The assistant's own spend counts against the thread's budget too.
        config: { costBudgetUsd: ASSISTANT_THREAD_LIMITS.costUsd },
      }, threadId);
    } catch (error) {
      this.store.abandon(threadId);
      this.deps.connections.deleteUnboundThreadConnection(connection.id);
      throw error;
    }
    if (!created.ok || !created.data) {
      this.store.abandon(threadId);
      this.deps.connections.deleteUnboundThreadConnection(connection.id);
      const { ok: _ok, status, error, data: _data, ...details } = created;
      throw new AssistantThreadRefusal(error ?? "The thread's session could not be started.", status >= 400 ? status : 409, details);
    }
    this.store.activate(threadId, created.data.id, this.now());
    return this.publish(this.store.get(threadId)!);
  }

  rename(owner: HumanPrincipal, id: string, body: unknown): AssistantThread {
    const row = this.owned(owner, id);
    const input = (body ?? {}) as { title?: unknown };
    this.store.rename(row.id, threadTitle(input.title), this.now());
    return this.publish(this.store.get(row.id)!);
  }

  /** Records the archive first, so a later failure to archive the session never leaves the thread
   * usable. Repeating it retries the session archive. */
  archive(owner: HumanPrincipal, id: string): AssistantThread {
    const row = this.owned(owner, id);
    this.store.archive(row.id, this.now());
    this.revokeCredential(row.id);
    if (row.session_id) {
      const session = this.deps.getSession(row.session_id);
      if (session && !session.archived) {
        const archived = this.deps.archiveBackingSession(row.session_id);
        if (!archived.ok) throw new AssistantThreadRefusal(`The thread was archived, but its session was not: ${archived.error ?? "unknown error"}. Archive the thread again to retry.`, archived.status >= 400 ? archived.status : 409);
      }
    }
    return this.publish(this.store.get(row.id)!);
  }

  get(owner: HumanPrincipal, id: string): AssistantThread {
    return this.view(this.owned(owner, id));
  }

  /** Revokes the thread's connection, which also tells its runner to drop the credential and stop
   * the proxy (see createAssistantThreads). Idempotent. */
  revokeCredential(threadId: string): void {
    const connection = this.deps.connections.forThread(threadId);
    if (connection && !connection.revoked) this.deps.connections.revoke(connection.id);
  }

  /** The backing session was archived or deleted outside the thread: the thread ends with it. */
  sessionRetired(sessionId: string): void {
    const row = this.store.forSession(sessionId);
    if (!row || row.state === "creating") return;
    this.store.archive(row.id, this.now());
    this.revokeCredential(row.id);
    this.publish(this.store.get(row.id)!);
  }

  /** Binds a credential the session's runner proxy minted. Only the runner hosting the live
   * backing session of an active thread, whose owner is still an active owner, may bind one. */
  registerCredential(runnerId: string, sessionId: string, tokenHash: string): { accepted: boolean; expiresAt?: number; error?: string } {
    const session = this.deps.getSession(sessionId);
    const row = this.store.forSession(sessionId);
    if (!session || !row || session.runnerId !== runnerId || session.role !== "assistant") {
      return { accepted: false, error: "this session is not an Assistant thread's session on this runner" };
    }
    if (row.state !== "active" || session.archived) return { accepted: false, error: "the Assistant thread is archived" };
    if (!this.deps.ownerPrincipal(row.owner_user_id, row.organization_id)) {
      return { accepted: false, error: "the thread's owner is no longer an active owner" };
    }
    let connection = this.deps.connections.forThread(row.id);
    if (!connection) {
      // A thread created before its connection existed gets one at its first launch.
      const owner = this.deps.ownerPrincipal(row.owner_user_id, row.organization_id)!;
      connection = this.deps.connections.createForThread(owner, row.id);
      this.store.setConnection(row.id, connection.id);
    }
    if (connection.revoked) return { accepted: false, error: "the thread's Assistant connection is revoked" };
    const expiresAt = this.now() + ASSISTANT_THREAD_CREDENTIAL_TTL_MS;
    if (!this.deps.connections.bindThreadCredential(connection.id, tokenHash, expiresAt)) {
      return { accepted: false, error: "the thread credential could not be bound" };
    }
    return { accepted: true, expiresAt };
  }

  /** Republishes a thread when one of its owner confirmations changes (#4665). */
  confirmationsChanged(threadId: string): void {
    const row = this.store.get(threadId);
    if (row && row.state !== "creating") this.publish(row);
  }

  /** Republishes a thread when its backing session changes (status, title, activity). */
  sessionChanged(session: SessionView): void {
    const row = this.store.forSession(session.id);
    if (row && row.state !== "creating") this.deps.broadcast(row.owner_user_id, this.view(row, session));
  }

  private publish(row: ThreadRow): AssistantThread {
    const thread = this.view(row);
    this.deps.broadcast(row.owner_user_id, thread);
    return thread;
  }
}

/** The production composition, shared with tests. */
export function createAssistantThreads(db: ControlPlaneDb, hub: Hub, svc: SessionsService): AssistantThreads {
  const threads = new AssistantThreads(db.assistantThreads, {
    connections: db.assistantConnections,
    ownerPrincipal: (userId, organizationId) => {
      const principal = db.operatingHumanPrincipal(userId, organizationId);
      return principal?.role === "owner" ? principal : null;
    },
    listRunners: (owner) => db.listRunnersForPrincipal(owner),
    isRunnerOnline: (runnerId) => hub.isRunnerOnline(runnerId),
    getSession: (sessionId) => db.getSession(sessionId),
    // Absent saved settings mean the system default, whose Child Harness is Automatic.
    savedChildHarnessDriver: (owner) => db.getOrchestratorDefaults(owner.userId)?.defaults.behavior.childHarness?.driver ?? null,
    createBackingSession: (owner, request, threadId) => {
      // The owner's New Session launch path, but never in a Project or a shared scope: the session
      // acts with the owner's Assistant authority, so it belongs to the owner alone.
      const scope = { organizationId: owner.organizationId, owner: { kind: "user" as const, userId: owner.userId } };
      const created = svc.createSession({ ...request, projectId: null, projectLocationId: null }, undefined, scope, false, false, false,
        { defaultOwnerUserId: owner.userId, assistantThread: { threadId } });
      return created.ok ? { ok: true, status: created.status, data: created.data } : { ...failureBody(created), ok: false, status: created.status };
    },
    archiveBackingSession: (sessionId) => svc.setArchived(sessionId, true),
    broadcast: (userId, thread) => hub.assistantThreadChanged(userId, thread),
    pendingConfirmations: (threadId) => db.assistantOwnerConfirmations.pendingForThread(threadId),
  });
  hub.onAssistantSessionUpsert((view) => threads.sessionChanged(view));
  db.assistantOwnerConfirmations.onChange((threadId) => threads.confirmationsChanged(threadId));
  // Archive, deletion or the owner revoking the connection: the runner forgets the credential and
  // closes the proxy. Any later proxy call is refused by the control plane regardless.
  db.assistantConnections.onChange((connectionId) => {
    const connection = db.assistantConnections.get(connectionId);
    if (!connection?.threadId || !connection.revoked) return;
    const sessionId = db.assistantThreads.get(connection.threadId)?.session_id;
    const session = sessionId ? db.getSession(sessionId) : null;
    if (session) hub.sendToRunner(session.runnerId, { type: "assistant_credential_revoked", sessionId: session.id });
  });
  svc.onAssistantSessionRetired((sessionId) => threads.sessionRetired(sessionId));
  return threads;
}

/** The production composition of thread owner confirmations (#4665), shared with tests. Approved
 * commands run through `operations`, so they take each operation's own receipt path. */
export function createAssistantOwnerConfirmationService(db: ControlPlaneDb, svc: { prompt(sessionId: string, text: string): { ok: boolean } },
  operations: Pick<AssistantOperations, "callOwnerApproved">): AssistantOwnerConfirmationService {
  const receipts = new AssistantCommandReceipts(db.raw());
  const service = new AssistantOwnerConfirmationService({
    store: db.assistantOwnerConfirmations,
    receiptStatus: (connectionId, commandId) => receipts.get(connectionId, commandId)?.status,
    run: (connectionId, operation, args, id) => operations.callOwnerApproved(connectionId, operation, args, id),
    // The outcome reaches the assistant as a message in its own conversation, queued if it is
    // busy. A refused admission (its runner offline, say) is retried until it is admitted.
    tell: (threadId, text) => {
      const row = db.assistantThreads.get(threadId);
      const session = row?.session_id ? db.getSession(row.session_id) : null;
      if (row?.state !== "active" || !session || session.archived) return "gone";
      return svc.prompt(session.id, text).ok ? "delivered" : "retry";
    },
  });
  db.assistantConnections.onChange((connectionId) => {
    if (db.assistantConnections.get(connectionId)?.revoked) service.refuseOpen(connectionId);
  });
  return service;
}
