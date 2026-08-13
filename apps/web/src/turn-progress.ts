import type {
  PendingApproval,
  PlanEntry,
  SessionEvent,
  SessionStatus,
} from "@wollipog/protocol";

const ACTIVE_TURN_STATUSES = new Set<SessionStatus>(["starting", "running", "input_required"]);
const ACTIVE_TOOL_STATUSES = new Set(["pending", "in_progress", "running"]);
const FAILED_TOOL_STATUSES = new Set(["failed", "error", "rejected", "cancelled", "canceled"]);
const RETRYABLE_FAILURE_STATUSES = new Set(["failed", "error", "rejected"]);
const RETRY_ERROR_LIMIT = 512;

interface ObservedToolCall {
  eventId: number;
  toolCallId: string;
  title: string;
  toolKind?: string;
  parentToolUseId?: string;
  status: string;
  latestEvidence: string;
  startedAt?: number;
  lastActivityAt?: number;
  index: number;
  retryKey?: string;
  retryRunLength: number;
}

export interface CurrentOperation {
  eventId: number;
  title: string;
  toolKind?: string;
  /** Nearest proven agent/spawning ancestor, including the operation itself when appropriate. */
  subagentId?: string;
  startedAt?: number;
  lastActivityAt?: number;
}

export interface RetryGroup {
  eventId: number;
  title: string;
  attempts: number;
  retries: number;
  latestError: string;
}

export interface WaitingReason {
  kind: "approval" | "question";
  label: "Waiting for Approval" | "Waiting for Answer to Question";
  title: string;
}

export interface ActiveTurnProgress {
  turnEventId: number;
  turnStartedAt?: number;
  lastActivityAt?: number;
  currentOperation?: CurrentOperation;
  completedTools: number;
  failedTools: number;
  currentPlanStep?: PlanEntry;
  retryGroup?: RetryGroup;
  waitingReason?: WaitingReason;
}

export interface ActiveTurnProgressInput {
  status: SessionStatus;
  pendingApproval: PendingApproval | null;
  events: readonly SessionEvent[];
  /** Session/store activity covers event kinds whose projected timeline item intentionally omits time. */
  observedLastActivityAt?: number;
}

export interface ActiveTurnProgressProjection {
  progress: ActiveTurnProgress | null;
  /** Events folded by this call. Pure appended streams report only the appended suffix. */
  processedEvents: number;
  rebuilt: boolean;
  /** Retry-chain slots recomputed while folding this generation. */
  retryScannedTools: number;
}

export interface ActiveTurnProgressProjectionOptions {
  scopeKey: string;
  status: SessionStatus;
  /** Authoritative runner turn coordinate when protocol support is available. */
  activeTurnId?: string;
  pendingApproval: PendingApproval | null;
  observedLastActivityAt?: number;
  /** True when store recovery/reset replaced history rather than appending live events. */
  historyRebuilt?: boolean;
}

function normalizedIdentity(value: string | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizedFailure(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function retryKey(tool: ObservedToolCall): string | undefined {
  const error = normalizedFailure(tool.latestEvidence);
  if (!RETRYABLE_FAILURE_STATUSES.has(normalizedIdentity(tool.status)) || !error) return undefined;
  // The normalized transcript does not preserve tool input as a separate field. Exact unchanged
  // failure output is therefore required in addition to title and kind; title alone would group
  // legitimate repeated operations and overstate retry churn.
  return JSON.stringify([
    normalizedIdentity(tool.title),
    normalizedIdentity(tool.toolKind),
    error,
  ]);
}

function waitingReason(pendingApproval: PendingApproval | null): WaitingReason | undefined {
  if (!pendingApproval) return undefined;
  if (pendingApproval.kind === "question") {
    return {
      kind: "question",
      label: "Waiting for Answer to Question",
      title: pendingApproval.title,
    };
  }
  return {
    kind: "approval",
    label: "Waiting for Approval",
    title: pendingApproval.title,
  };
}

/**
 * Retained active-turn projection. Ordinary streamed arrays extend the previously folded tail, so
 * each event is processed once. Session/epoch changes and store-tagged history replacement rebuild
 * defensively, preserving correctness across navigation, reconnect backfill, and reset.
 */
export class IncrementalActiveTurnProgress {
  private scopeKey: string | null = null;
  private previousStatus: SessionStatus | null = null;
  private awaitingActiveTurnStart = false;
  private count = 0;
  private lastEvent: SessionEvent | null = null;
  private lastEvents: readonly SessionEvent[] | null = null;
  private turnStart: SessionEvent | null = null;
  private latestActivity: SessionEvent | null = null;
  private currentPlanStep: PlanEntry | undefined;
  private latestPlanSeq = -1;
  private readonly tools = new Map<string, ObservedToolCall>();
  private readonly firstToolEventIds = new Map<string, number>();
  private readonly toolOrder: ObservedToolCall[] = [];
  private readonly toolsWithChildren = new Set<string>();
  private readonly activeToolIds = new Set<string>();
  private readonly activeToolHeap: number[] = [];
  private currentOperationId: string | null = null;
  private currentSubagentId: string | undefined;
  private retryGroup: RetryGroup | undefined;
  private completedTools = 0;
  private failedTools = 0;
  private retryScannedTools = 0;

  project(
    events: readonly SessionEvent[],
    options: ActiveTurnProgressProjectionOptions,
  ): ActiveTurnProgressProjection {
    this.retryScannedTools = 0;
    const untrustworthy = events !== this.lastEvents && options.historyRebuilt === true;
    const extendsPrior = !untrustworthy &&
      this.scopeKey === options.scopeKey &&
      events.length >= this.count &&
      (this.count === 0 || events[this.count - 1] === this.lastEvent);
    const rebuilt = !extendsPrior;
    if (rebuilt) {
      this.firstToolEventIds.clear();
      this.resetTurn();
      this.previousStatus = null;
      this.awaitingActiveTurnStart = ACTIVE_TURN_STATUSES.has(options.status);
      this.scopeKey = options.scopeKey;
      this.count = 0;
      this.lastEvent = null;
      this.lastEvents = null;
    } else if (ACTIVE_TURN_STATUSES.has(options.status) &&
        this.previousStatus != null && !ACTIVE_TURN_STATUSES.has(this.previousStatus)) {
      // Status can lead the canonical user-message event briefly. Hide the completed prior turn
      // until the new turn boundary arrives instead of repainting stale elapsed/count state.
      this.awaitingActiveTurnStart = true;
    }

    const start = this.count;
    for (let index = start; index < events.length; index += 1) this.push(events[index]!);
    if (events.length > start) this.refreshCurrentSubagent();
    const turnPayload = this.turnStart?.payload;
    const foldedTurnId = turnPayload?.kind === "user_message" ? turnPayload.turnId : undefined;
    if (ACTIVE_TURN_STATUSES.has(options.status) && options.activeTurnId && foldedTurnId) {
      this.awaitingActiveTurnStart = foldedTurnId !== options.activeTurnId;
    }
    this.count = events.length;
    this.lastEvent = events.at(-1) ?? null;
    this.lastEvents = events;
    this.previousStatus = options.status;

    return {
      progress: this.snapshot(options),
      processedEvents: events.length - start,
      rebuilt,
      retryScannedTools: this.retryScannedTools,
    };
  }

  private resetTurn(): void {
    this.turnStart = null;
    this.latestActivity = null;
    this.currentPlanStep = undefined;
    this.latestPlanSeq = -1;
    this.tools.clear();
    this.toolOrder.length = 0;
    this.toolsWithChildren.clear();
    this.activeToolIds.clear();
    this.activeToolHeap.length = 0;
    this.currentOperationId = null;
    this.currentSubagentId = undefined;
    this.retryGroup = undefined;
    this.completedTools = 0;
    this.failedTools = 0;
  }

  private push(event: SessionEvent): void {
    const payload = event.payload;
    if (payload.kind === "user_message" && payload.deliveryIntent !== "steer") {
      this.resetTurn();
      this.awaitingActiveTurnStart = false;
      this.turnStart = event;
    }
    if (!this.turnStart || event.seq < this.turnStart.seq) return;

    if (Number.isFinite(event.ts) && (!this.latestActivity || event.seq > this.latestActivity.seq)) {
      this.latestActivity = event;
    }
    if (payload.kind === "plan" && !payload.parentToolUseId && event.seq > this.latestPlanSeq) {
      this.currentPlanStep = payload.entries.find((entry) => entry.status === "in_progress");
      this.latestPlanSeq = event.seq;
    }
    const parentToolUseId = "parentToolUseId" in payload ? payload.parentToolUseId : undefined;
    if (parentToolUseId) this.toolsWithChildren.add(parentToolUseId);

    if (payload.kind === "tool_call") {
      const existing = this.tools.get(payload.toolCallId);
      if (existing) {
        this.updateTool(existing, payload.status, payload.text, event.ts, payload.title, payload.toolKind, parentToolUseId);
        return;
      }
      const firstEventId = this.firstToolEventIds.get(payload.toolCallId) ?? event.seq;
      this.firstToolEventIds.set(payload.toolCallId, firstEventId);
      const tool: ObservedToolCall = {
        eventId: firstEventId,
        toolCallId: payload.toolCallId,
        title: payload.title,
        toolKind: payload.toolKind,
        ...(parentToolUseId ? { parentToolUseId } : {}),
        status: payload.status,
        latestEvidence: payload.text && FAILED_TOOL_STATUSES.has(normalizedIdentity(payload.status))
          ? payload.text
          : "",
        ...(Number.isFinite(event.ts) ? { startedAt: event.ts, lastActivityAt: event.ts } : {}),
        index: this.toolOrder.length,
        retryRunLength: 0,
      };
      this.tools.set(tool.toolCallId, tool);
      this.toolOrder.push(tool);
      this.addStatus(tool.status);
      this.updateCurrentOperation(tool);
      this.refreshRetryFrom(tool.index);
      return;
    }
    if (payload.kind !== "tool_call_update") return;
    const existing = this.tools.get(payload.toolCallId);
    // A partial history that lacks the invocation cannot provide a semantic reveal target or a
    // trustworthy title/kind identity. Leave that update out rather than inventing a tool card.
    if (!existing) return;
    this.updateTool(existing, payload.status, payload.text, event.ts, payload.title, undefined, parentToolUseId);
  }

  private updateTool(
    tool: ObservedToolCall,
    status: string,
    text: string | undefined,
    timestamp: number,
    title?: string,
    toolKind?: string,
    parentToolUseId?: string,
  ): void {
    const wasFailed = FAILED_TOOL_STATUSES.has(normalizedIdentity(tool.status));
    this.removeStatus(tool.status);
    tool.title = title || tool.title;
    tool.toolKind = toolKind ?? tool.toolKind;
    tool.parentToolUseId = parentToolUseId ?? tool.parentToolUseId;
    tool.status = status;
    if (FAILED_TOOL_STATUSES.has(normalizedIdentity(status))) {
      if (text) tool.latestEvidence = text;
      else if (!wasFailed) tool.latestEvidence = "";
    } else {
      // Progress/success output is not failure evidence and must never make a later textless
      // terminal update look like an equivalent retry.
      tool.latestEvidence = "";
    }
    if (Number.isFinite(timestamp)) tool.lastActivityAt = timestamp;
    this.addStatus(tool.status);
    this.updateCurrentOperation(tool);
    this.refreshRetryFrom(tool.index);
  }

  private addStatus(status: string): void {
    const normalized = normalizedIdentity(status);
    if (normalized === "completed") this.completedTools += 1;
    if (FAILED_TOOL_STATUSES.has(normalized)) this.failedTools += 1;
  }

  private removeStatus(status: string): void {
    const normalized = normalizedIdentity(status);
    if (normalized === "completed") this.completedTools -= 1;
    if (FAILED_TOOL_STATUSES.has(normalized)) this.failedTools -= 1;
  }

  private updateCurrentOperation(tool: ObservedToolCall): void {
    const active = ACTIVE_TOOL_STATUSES.has(normalizedIdentity(tool.status));
    if (active && !this.activeToolIds.has(tool.toolCallId)) {
      this.activeToolIds.add(tool.toolCallId);
      this.heapPush(tool.index);
    } else if (!active) {
      this.activeToolIds.delete(tool.toolCallId);
    }
    this.discardInactiveHeapHead();
    const currentIndex = this.activeToolHeap[0];
    this.currentOperationId = currentIndex == null ? null : this.toolOrder[currentIndex]!.toolCallId;
  }

  private heapPush(index: number): void {
    let cursor = this.activeToolHeap.push(index) - 1;
    while (cursor > 0) {
      const parent = Math.floor((cursor - 1) / 2);
      if (this.activeToolHeap[parent]! >= index) break;
      this.activeToolHeap[cursor] = this.activeToolHeap[parent]!;
      cursor = parent;
    }
    this.activeToolHeap[cursor] = index;
  }

  private discardInactiveHeapHead(): void {
    while (this.activeToolHeap.length > 0) {
      const head = this.activeToolHeap[0]!;
      if (this.activeToolIds.has(this.toolOrder[head]!.toolCallId)) return;
      const tail = this.activeToolHeap.pop()!;
      if (this.activeToolHeap.length === 0) return;
      let cursor = 0;
      while (true) {
        const left = cursor * 2 + 1;
        if (left >= this.activeToolHeap.length) break;
        const right = left + 1;
        const child = right < this.activeToolHeap.length && this.activeToolHeap[right]! > this.activeToolHeap[left]!
          ? right
          : left;
        if (this.activeToolHeap[child]! <= tail) break;
        this.activeToolHeap[cursor] = this.activeToolHeap[child]!;
        cursor = child;
      }
      this.activeToolHeap[cursor] = tail;
    }
  }

  private refreshRetryFrom(start: number): void {
    for (let index = start; index < this.toolOrder.length; index += 1) {
      const tool = this.toolOrder[index]!;
      const previousKey = tool.retryKey;
      const previousRunLength = tool.retryRunLength;
      const key = retryKey(tool);
      const previous = index > 0 ? this.toolOrder[index - 1]! : undefined;
      tool.retryKey = key;
      tool.retryRunLength = key
        ? (previous?.retryKey === key ? previous.retryRunLength + 1 : 1)
        : 0;
      this.retryScannedTools += 1;
      if (tool.retryKey === previousKey && tool.retryRunLength === previousRunLength) break;
    }
    this.retryGroup = this.buildRetryGroup();
  }

  private nearestSubagent(tool: ObservedToolCall): string | undefined {
    let current: ObservedToolCall | undefined = tool;
    const visited = new Set<string>();
    while (current && !visited.has(current.toolCallId)) {
      visited.add(current.toolCallId);
      if (normalizedIdentity(current.toolKind) === "agent" || this.toolsWithChildren.has(current.toolCallId)) {
        return current.toolCallId;
      }
      current = current.parentToolUseId ? this.tools.get(current.parentToolUseId) : undefined;
    }
    return undefined;
  }

  private refreshCurrentSubagent(): void {
    const current = this.currentOperationId ? this.tools.get(this.currentOperationId) : undefined;
    this.currentSubagentId = current ? this.nearestSubagent(current) : undefined;
  }

  private buildRetryGroup(): RetryGroup | undefined {
    const finalAttempt = this.toolOrder.at(-1);
    if (!finalAttempt?.retryKey || finalAttempt.retryRunLength < 2) return undefined;
    const recordedError = finalAttempt.latestEvidence.trim();
    return {
      eventId: finalAttempt.eventId,
      title: finalAttempt.title,
      attempts: finalAttempt.retryRunLength,
      retries: finalAttempt.retryRunLength - 1,
      // The raw tool cards retain the complete output. Keep the compact summary and tooltip bounded
      // even when a provider records a very large terminal payload.
      latestError: recordedError.length > RETRY_ERROR_LIMIT
        ? `${recordedError.slice(0, RETRY_ERROR_LIMIT - 1)}…`
        : recordedError,
    };
  }

  private snapshot(options: ActiveTurnProgressProjectionOptions): ActiveTurnProgress | null {
    if (!ACTIVE_TURN_STATUSES.has(options.status) || this.awaitingActiveTurnStart || !this.turnStart) return null;
    const currentOperation = this.currentOperationId ? this.tools.get(this.currentOperationId) : undefined;
    const lastActivityAt = [this.latestActivity?.ts, options.observedLastActivityAt]
      .filter((value): value is number => Number.isFinite(value))
      .reduce<number | undefined>((latest, value) => latest == null ? value : Math.max(latest, value), undefined);
    const waiting = waitingReason(options.pendingApproval);
    return {
      turnEventId: this.turnStart.seq,
      ...(Number.isFinite(this.turnStart.ts) ? { turnStartedAt: this.turnStart.ts } : {}),
      ...(lastActivityAt != null ? { lastActivityAt } : {}),
      ...(currentOperation ? {
        currentOperation: {
          eventId: currentOperation.eventId,
          title: currentOperation.title,
          toolKind: currentOperation.toolKind,
          ...(this.currentSubagentId
            ? { subagentId: this.currentSubagentId }
            : {}),
          startedAt: currentOperation.startedAt,
          lastActivityAt: currentOperation.lastActivityAt,
        },
      } : {}),
      completedTools: this.completedTools,
      failedTools: this.failedTools,
      ...(this.currentPlanStep ? { currentPlanStep: this.currentPlanStep } : {}),
      ...(this.retryGroup ? { retryGroup: this.retryGroup } : {}),
      ...(waiting ? { waitingReason: waiting } : {}),
    };
  }
}

/**
 * One-shot derivation for pure callers and fixtures. Production uses the retained projector so
 * streamed events do not re-fold the transcript on every render.
 */
export function deriveActiveTurnProgress({
  status,
  pendingApproval,
  events,
  observedLastActivityAt,
}: ActiveTurnProgressInput): ActiveTurnProgress | null {
  return new IncrementalActiveTurnProgress().project(events, {
    scopeKey: "one-shot",
    status,
    pendingApproval,
    observedLastActivityAt,
  }).progress;
}
