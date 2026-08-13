import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GitStatusInfo, GitSummaryInfo, SessionView } from "@wollipog/protocol";
import { ApiError } from "../api.js";
import { useApi } from "../api-context.js";
import { isGitNoRepositoryError } from "../pinned-summary.js";

interface TaggedGitRead<T> {
  sessionId: string;
  value: T | null;
  observation: number;
  observedAt: number | null;
  settled: boolean;
  busy: boolean;
  error: string | null;
  errorCode: string | null;
}

let observationSequence = 0;

function nextObservation(): number {
  observationSequence += 1;
  return observationSequence;
}

function emptyRead<T>(sessionId: string): TaggedGitRead<T> {
  return {
    sessionId,
    value: null,
    observation: 0,
    observedAt: null,
    settled: false,
    busy: false,
    error: null,
    errorCode: null,
  };
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const GIT_STATUS_POLL_MS = 60_000;
const GIT_ACTIVE_STATUSES = new Set(["queued", "starting", "running", "input_required"]);

function isGitTurnActive(session: SessionView | undefined): boolean {
  return Boolean(session && GIT_ACTIVE_STATUSES.has(session.status));
}

export interface GitStatus {
  status: GitStatusInfo | null;
  observation: number;
  observedAt: number | null;
  settled: boolean;
  busy: boolean;
  error: string | null;
  errorCode: string | null;
  refresh: () => Promise<void>;
  /** Status half of a caller-orchestrated paired refresh. Does not trigger summary itself. */
  refreshStatusOnly: () => Promise<void>;
  /** Install a status a mutation reply carried (stage-hunk returns a fresh read). */
  install: (status: GitStatusInfo) => void;
  /** Changes for imperative status refreshes and mutation-carried status, so the richer summary
   * follows Review actions without duplicating its ordinary paired mount request. */
  mutationRevision: number;
}

export interface GitSummary {
  summary: GitSummaryInfo | null;
  observation: number;
  observedAt: number | null;
  settled: boolean;
  busy: boolean;
  error: string | null;
  errorCode: string | null;
  refresh: () => Promise<void>;
}

/**
 * One status reader for the mounted session. A linked worktree is readable on every supported
 * runner generation; a primary checkout is readable only after the v76 gitVisibility proof.
 *
 * State is tagged with its session id. React may render a new session before effects clean up the
 * old request, so untagged state clearing is not sufficient: an old value must be impossible to
 * project during that render, and a late response must fail the active-session check.
 */
export function useGitStatus(
  session: SessionView | undefined,
  runnerOnline: boolean,
  richGitSupported = false,
  reconnectRevision = 0,
): GitStatus {
  const api = useApi();
  const sessionId = session?.id ?? "";
  const worktreePath = session?.worktreePath ?? null;
  const readable = Boolean(session && (worktreePath || richGitSupported));
  const enabled = readable && runnerOnline;
  const [read, setRead] = useState<TaggedGitRead<GitStatusInfo>>(() => emptyRead(sessionId));
  const [mutationRevision, setMutationRevision] = useState(0);
  const [cadenceRevision, setCadenceRevision] = useState(0);
  const requestRef = useRef(0);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const trailingRef = useRef(false);
  const trailingForegroundRef = useRef(false);
  const pollDeadlineRef = useRef(0);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const activeSessionRef = useRef(sessionId);
  const enabledRef = useRef(enabled);
  const richGitSupportedRef = useRef(richGitSupported);
  const turnActive = isGitTurnActive(session);
  const turnActiveRef = useRef(turnActive);
  const lifecycleRef = useRef<{
    enabled: boolean;
    reconnectRevision: number;
    sessionId: string;
    turnActive: boolean;
    worktreePath: string | null;
  } | null>(null);
  activeSessionRef.current = sessionId;
  enabledRef.current = enabled;
  richGitSupportedRef.current = richGitSupported;
  turnActiveRef.current = turnActive;

  const clearPollTimer = useCallback(() => {
    if (pollTimerRef.current === null) return;
    clearTimeout(pollTimerRef.current);
    pollTimerRef.current = null;
  }, []);

  const resetPollWindow = useCallback(() => {
    clearPollTimer();
    pollDeadlineRef.current = Date.now() + GIT_STATUS_POLL_MS;
    if (mountedRef.current) setCadenceRevision((value) => value + 1);
  }, [clearPollTimer]);

  const requestStatus = useCallback((queueIfBusy: boolean, background = false): Promise<void> => {
    if (!sessionId || !enabledRef.current || activeSessionRef.current !== sessionId) {
      return Promise.resolve();
    }
    if (inFlightRef.current) {
      if (queueIfBusy) {
        trailingRef.current = true;
        if (!background) {
          trailingForegroundRef.current = true;
          setRead((current) => ({
            ...(current.sessionId === sessionId ? current : emptyRead<GitStatusInfo>(sessionId)),
            busy: true,
            error: null,
            errorCode: null,
          }));
        }
      } else {
        resetPollWindow();
      }
      return inFlightRef.current;
    }

    const launch = (backgroundRead = false): Promise<void> => {
      clearPollTimer();
      pollDeadlineRef.current = Date.now() + GIT_STATUS_POLL_MS;
      const requestId = ++requestRef.current;
      if (!backgroundRead) {
        setRead((current) => ({
          ...(current.sessionId === sessionId ? current : emptyRead<GitStatusInfo>(sessionId)),
          busy: true,
          error: null,
          errorCode: null,
        }));
      }

      let requestPromise: Promise<void>;
      requestPromise = (async () => {
        try {
          const data = await api.git(sessionId, { action: "status" });
          if (
            requestRef.current !== requestId ||
            activeSessionRef.current !== sessionId ||
            !enabledRef.current
          ) return;
          setRead({
            sessionId,
            value: data.status ?? null,
            observation: nextObservation(),
            observedAt: Date.now(),
            settled: true,
            busy: trailingRef.current && trailingForegroundRef.current,
            error: null,
            errorCode: null,
          });
        } catch (error) {
          if (
            requestRef.current !== requestId ||
            activeSessionRef.current !== sessionId ||
            !enabledRef.current
          ) return;
          const errorCode = error instanceof ApiError ? error.code ?? null : null;
          if (backgroundRead && !isGitNoRepositoryError(messageFor(error), errorCode)) return;
          setRead((current) => ({
            ...(current.sessionId === sessionId ? current : emptyRead<GitStatusInfo>(sessionId)),
            settled: true,
            busy: trailingRef.current && trailingForegroundRef.current,
            error: messageFor(error),
            errorCode,
          }));
        }
      })().finally(async () => {
        if (inFlightRef.current !== requestPromise) return;
        inFlightRef.current = null;
        if (
          trailingRef.current &&
          enabledRef.current &&
          activeSessionRef.current === sessionId
        ) {
          const backgroundTail = !trailingForegroundRef.current;
          trailingRef.current = false;
          trailingForegroundRef.current = false;
          await launch(backgroundTail);
          return;
        }
        trailingRef.current = false;
        trailingForegroundRef.current = false;
        resetPollWindow();
      });
      inFlightRef.current = requestPromise;
      return requestPromise;
    };

    return launch(background);
  }, [api, clearPollTimer, resetPollWindow, sessionId, worktreePath]);

  const refreshStatusOnly = useCallback(
    () => requestStatus(true),
    [requestStatus],
  );
  const refresh = useCallback(async () => {
    await requestStatus(true);
    if (enabledRef.current && activeSessionRef.current === sessionId) {
      setMutationRevision((value) => value + 1);
    }
  }, [requestStatus, sessionId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
      inFlightRef.current = null;
      trailingRef.current = false;
      trailingForegroundRef.current = false;
      clearPollTimer();
    };
  }, [clearPollTimer]);

  useEffect(() => {
    if (!enabled) {
      requestRef.current += 1;
      inFlightRef.current = null;
      trailingRef.current = false;
      trailingForegroundRef.current = false;
      pollDeadlineRef.current = 0;
      clearPollTimer();
      setRead((current) => current.sessionId === sessionId
        ? current.busy ? { ...current, busy: false } : current
        : emptyRead(sessionId));
    }
  }, [clearPollTimer, enabled, sessionId]);

  useEffect(() => () => {
    requestRef.current += 1;
    inFlightRef.current = null;
    trailingRef.current = false;
    trailingForegroundRef.current = false;
    pollDeadlineRef.current = 0;
    clearPollTimer();
  }, [clearPollTimer, sessionId]);

  // Mount/session, runner recovery, dashboard reconnect, and active-to-idle boundaries all
  // refresh. Active turns suppress automatic reads; the explicit Refresh control remains usable.
  useEffect(() => {
    const previous = lifecycleRef.current;
    lifecycleRef.current = { enabled, reconnectRevision, sessionId, turnActive, worktreePath };
    if (!enabled) return;
    const enteredActiveWithoutAnotherBoundary = Boolean(
      previous && previous.enabled && previous.sessionId === sessionId &&
      previous.reconnectRevision === reconnectRevision && previous.worktreePath === worktreePath &&
      !previous.turnActive && turnActive,
    );
    if (enteredActiveWithoutAnotherBoundary) return;
    const background = read.sessionId === sessionId && read.settled;
    void requestStatus(true, background);
  }, [enabled, reconnectRevision, requestStatus, sessionId, turnActive, worktreePath]);

  // A single timeout is owned only while this rich session is online, idle, and visible.
  // Hiding preserves the deadline; foregrounding immediately catches up only when overdue.
  useEffect(() => {
    clearPollTimer();
    const noRepository = read.sessionId === sessionId &&
      isGitNoRepositoryError(read.error, read.errorCode);
    if (!enabled || !richGitSupported || turnActive || session?.archived || noRepository) return;

    const schedule = () => {
      clearPollTimer();
      if (
        !enabledRef.current ||
        !richGitSupportedRef.current ||
        turnActiveRef.current ||
        document.visibilityState !== "visible"
      ) return;
      const remaining = pollDeadlineRef.current - Date.now();
      if (remaining <= 0) {
        void requestStatus(false, true);
        return;
      }
      pollTimerRef.current = setTimeout(() => {
        pollTimerRef.current = null;
        if (
          !enabledRef.current ||
          !richGitSupportedRef.current ||
          turnActiveRef.current ||
          document.visibilityState !== "visible"
        ) return;
        void requestStatus(false, true);
      }, remaining);
    };
    const onVisibilityChange = () => schedule();
    document.addEventListener("visibilitychange", onVisibilityChange);
    schedule();
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      clearPollTimer();
    };
  }, [
    cadenceRevision,
    clearPollTimer,
    enabled,
    requestStatus,
    richGitSupported,
    read.errorCode,
    read.error,
    read.sessionId,
    session?.archived,
    sessionId,
    turnActive,
  ]);

  const install = useCallback((status: GitStatusInfo) => {
    if (!sessionId || activeSessionRef.current !== sessionId) return;
    requestRef.current += 1;
    trailingRef.current = false;
    trailingForegroundRef.current = false;
    setRead({
      sessionId,
      value: status,
      observation: nextObservation(),
      observedAt: Date.now(),
      settled: true,
      busy: false,
      error: null,
      errorCode: null,
    });
    setMutationRevision((value) => value + 1);
    resetPollWindow();
  }, [resetPollWindow, sessionId]);

  const current = read.sessionId === sessionId ? read : emptyRead<GitStatusInfo>(sessionId);
  return useMemo(
    () => ({
      status: current.value,
      observation: current.observation,
      observedAt: current.observedAt,
      settled: current.settled,
      busy: current.busy,
      error: current.error,
      errorCode: current.errorCode,
      refresh,
      refreshStatusOnly,
      install,
      mutationRevision,
    }),
    [current, install, mutationRevision, refresh, refreshStatusOnly],
  );
}

/** Rich status + PR/checks reader with the same session-tagged and late-response guarantees. */
export function useGitSummary(
  session: SessionView | undefined,
  runnerOnline: boolean,
  richGitSupported = false,
  mutationRevision = 0,
  reconnectRevision = 0,
): GitSummary {
  const api = useApi();
  const sessionId = session?.id ?? "";
  const worktreePath = session?.worktreePath ?? null;
  const readable = Boolean(session && (worktreePath || richGitSupported));
  const enabled = readable && runnerOnline;
  const [read, setRead] = useState<TaggedGitRead<GitSummaryInfo>>(() => emptyRead(sessionId));
  const requestRef = useRef(0);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const trailingRef = useRef(false);
  const trailingForegroundRef = useRef(false);
  const activeSessionRef = useRef(sessionId);
  const enabledRef = useRef(enabled);
  const turnActive = isGitTurnActive(session);
  const seenMutationRevisionRef = useRef(mutationRevision);
  const lifecycleRef = useRef<{
    enabled: boolean;
    reconnectRevision: number;
    sessionId: string;
    turnActive: boolean;
    worktreePath: string | null;
  } | null>(null);
  activeSessionRef.current = sessionId;
  enabledRef.current = enabled;

  const requestSummary = useCallback((background = false): Promise<void> => {
    if (!sessionId || !enabledRef.current || activeSessionRef.current !== sessionId) {
      return Promise.resolve();
    }
    if (inFlightRef.current) {
      trailingRef.current = true;
      if (!background) {
        trailingForegroundRef.current = true;
        setRead((current) => ({
          ...(current.sessionId === sessionId ? current : emptyRead<GitSummaryInfo>(sessionId)),
          busy: true,
          error: null,
          errorCode: null,
        }));
      }
      return inFlightRef.current;
    }

    const launch = (backgroundRead = false): Promise<void> => {
      const requestId = ++requestRef.current;
      if (!backgroundRead) {
        setRead((current) => ({
          ...(current.sessionId === sessionId ? current : emptyRead<GitSummaryInfo>(sessionId)),
          busy: true,
          error: null,
          errorCode: null,
        }));
      }

      let requestPromise: Promise<void>;
      requestPromise = (async () => {
        try {
          const data = await api.gitSummary(sessionId);
          if (
            requestRef.current !== requestId ||
            activeSessionRef.current !== sessionId ||
            !enabledRef.current
          ) return;
          setRead({
            sessionId,
            value: data.summary ?? null,
            observation: nextObservation(),
            observedAt: Date.now(),
            settled: true,
            busy: trailingRef.current && trailingForegroundRef.current,
            error: null,
            errorCode: null,
          });
        } catch (error) {
          if (
            requestRef.current !== requestId ||
            activeSessionRef.current !== sessionId ||
            !enabledRef.current
          ) return;
          const errorCode = error instanceof ApiError ? error.code ?? null : null;
          if (backgroundRead && !isGitNoRepositoryError(messageFor(error), errorCode)) return;
          setRead((current) => ({
            ...(current.sessionId === sessionId ? current : emptyRead<GitSummaryInfo>(sessionId)),
            settled: true,
            busy: trailingRef.current && trailingForegroundRef.current,
            error: messageFor(error),
            errorCode,
          }));
        }
      })().finally(async () => {
        if (inFlightRef.current !== requestPromise) return;
        inFlightRef.current = null;
        if (
          trailingRef.current &&
          enabledRef.current &&
          activeSessionRef.current === sessionId
        ) {
          const backgroundTail = !trailingForegroundRef.current;
          trailingRef.current = false;
          trailingForegroundRef.current = false;
          await launch(backgroundTail);
          return;
        }
        trailingRef.current = false;
        trailingForegroundRef.current = false;
      });
      inFlightRef.current = requestPromise;
      return requestPromise;
    };

    return launch(background);
  }, [api, sessionId, worktreePath]);

  const refresh = useCallback(
    () => requestSummary(false),
    [requestSummary],
  );

  useEffect(() => {
    if (!enabled) {
      requestRef.current += 1;
      inFlightRef.current = null;
      trailingRef.current = false;
      trailingForegroundRef.current = false;
      setRead((current) => current.sessionId === sessionId
        ? current.busy ? { ...current, busy: false } : current
        : emptyRead(sessionId));
      return;
    }
  }, [enabled, sessionId]);

  useEffect(() => () => {
    requestRef.current += 1;
    inFlightRef.current = null;
    trailingRef.current = false;
    trailingForegroundRef.current = false;
  }, [sessionId]);

  useEffect(() => {
    const previous = lifecycleRef.current;
    lifecycleRef.current = { enabled, reconnectRevision, sessionId, turnActive, worktreePath };
    if (!enabled) return;
    const enteredActiveWithoutAnotherBoundary = Boolean(
      previous && previous.enabled && previous.sessionId === sessionId &&
      previous.reconnectRevision === reconnectRevision && previous.worktreePath === worktreePath &&
      !previous.turnActive && turnActive,
    );
    if (enteredActiveWithoutAnotherBoundary) return;
    const background = read.sessionId === sessionId && read.settled;
    void requestSummary(background);
  }, [enabled, reconnectRevision, requestSummary, sessionId, turnActive, worktreePath]);

  // A mutation-carried status is already the latest local read. It refreshes only the unique
  // summary/forge fields once, even during an active turn, and never couples polling to gh.
  useEffect(() => {
    if (seenMutationRevisionRef.current === mutationRevision) return;
    seenMutationRevisionRef.current = mutationRevision;
    if (enabled) void requestSummary(false);
  }, [enabled, mutationRevision, requestSummary]);

  const current = read.sessionId === sessionId ? read : emptyRead<GitSummaryInfo>(sessionId);
  return useMemo(
    () => ({
      summary: current.value,
      observation: current.observation,
      observedAt: current.observedAt,
      settled: current.settled,
      busy: current.busy,
      error: current.error,
      errorCode: current.errorCode,
      refresh,
    }),
    [current, refresh],
  );
}
