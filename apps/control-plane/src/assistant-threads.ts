import {
  ASSISTANT_THREAD_HARNESSES,
  runnerCapabilityRequirementError,
  runnerSupportsProtocol,
  type AgentDefinition,
  type AgentDriverKind,
  type AssistantThread,
  type AssistantThreadDefaultsResponse,
  type AssistantThreadHarness,
  type AssistantThreadStatus,
  type CreateSessionRequest,
  type RunnerView,
  type SessionView,
} from "@wollipog/protocol";
import type { HumanPrincipal } from "./identity.js";
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

function harnessAgent(runner: RunnerView, harness: AssistantThreadHarness): AgentDefinition | undefined {
  const native = runner.agents.filter((agent) => agent.available !== false && (agent.context?.kind ?? "native") === "native");
  for (const driver of HARNESS_DRIVERS[harness]) {
    const agent = native.find((candidate) => candidate.driver === driver);
    if (agent) return agent;
  }
  return undefined;
}

/** What a thread's status shows, from its stored state and its backing session. */
export function assistantThreadStatus(state: StoredThreadState, session: SessionView | null): AssistantThreadStatus {
  if (state === "archived" || !session || session.archived) return "archived";
  if (session.status === "input_required" || session.pendingApproval) return "needs_you";
  if (session.status === "queued" || session.status === "starting" || session.status === "running") return "working";
  return "done";
}

export interface AssistantThreadDeps {
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
    return {
      id: row.id,
      assistant: row.assistant,
      // An untitled session is named by its first message; the thread shows that name once it exists.
      title: row.title ?? (session && session.title !== UNTITLED ? session.title : DEFAULT_THREAD_TITLE),
      harness: row.harness,
      sessionId: row.session_id ?? "",
      status: assistantThreadStatus(row.state, session),
      access: { level: "full_access", destructive: "ask" },
      connectionId: row.connection_id,
      launchedSessionIds: [],
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
      }, threadId);
    } catch (error) {
      this.store.abandon(threadId);
      throw error;
    }
    if (!created.ok || !created.data) {
      this.store.abandon(threadId);
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
  });
  hub.onAssistantSessionUpsert((view) => threads.sessionChanged(view));
  return threads;
}
