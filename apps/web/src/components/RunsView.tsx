import { RunsIcon } from "./Icons.js";
import { Notice } from "./Notice.js";
import { State } from "./State.js";
import { StatusBadge } from "./StatusBadge.js";
import { statusMeta } from "../status-meta.js";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { RunView, WorkflowArtifactView, WorkflowInstanceDetail } from "@wollipog/protocol";
import { useStoreActions, useStoreSelector } from "../store.js";
import { relativeTime, titleCaseLabel } from "../format.js";
import { useApi } from "../api-context.js";
import { SessionStatusIndicators } from "./common.js";
import { EventTimeline } from "./EventTimeline.js";
import { useTimeline } from "./useTimeline.js";
import { sessionAgentLabel } from "./agent-options.js";
import { nextWorkflowRetryAt, workflowRetryTimerDelay } from "../workflow-retry.js";
import { subscriptionRecoveryRevision } from "../ui-subscriptions.js";
import { recoverSessionHistories, sessionHistoryEpochKey } from "../history-recovery.js";
import { detailPlaceholder, listPlaceholder } from "../detail-placeholder.js";
import { selectComparisonEvents, selectComparisonHistory, selectComparisonSession } from "../comparison-selectors.js";
import { transcriptPresentation } from "../transcript-presentation.js";
import { ArtifactPreviewDialog, ArtifactRow } from "./ArtifactPreview.js";
import { ListFoot } from "./ListFoot.js";
import { BusyButton } from "./ui/BusyButton.js";
import { DetailBar, PageHeader } from "./PageHeader.js";
import { backLabel, destination, viewTitle } from "../navigation.js";
import { isTimelineSessionActive, useTimelineClock } from "../timeline-clock.js";

const EMPTY_SESSION_IDS: string[] = [];
const sameSessionIds = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((id, index) => id === right[index]);

/** One member's live column. Its own component so each member subscribes to ITS event slice
 * and folds incrementally — a 4-agent compare no longer re-derives four full timelines per
 * streamed chunk of any one of them. */
function MemberColumn({ sessionId }: { sessionId: string }) {
  const { navigate } = useStoreActions();
  const session = useStoreSelector((state) => selectComparisonSession(state, sessionId));
  const evs = useStoreSelector((state) => selectComparisonEvents(state, sessionId));
  const history = useStoreSelector((state) => selectComparisonHistory(state, sessionId));
  const runnerOnline = useStoreSelector((state) => session
    ? state.runners.get(session.runnerId)?.status === "online"
    : true);
  const conn = useStoreSelector((state) => state.conn);
  const items = useTimeline(sessionId, evs, session?.eventEpoch ?? 0);
  const scrollRef = useRef<HTMLDivElement>(null);
  if (!session) return null;
  const presentation = transcriptPresentation({ itemCount: items.length, hasOptimistic: false, working: false, history, conn });
  const agentLabel = sessionAgentLabel(session.agentName, session.driver, session.agentId);
  return (
    <div className="compare-col">
      <button className="compare-head" type="button" onClick={() => navigate({ name: "session", id: sessionId })}>
        <div className="compare-agent">{agentLabel}</div>
        <SessionStatusIndicators session={session} disconnected={!runnerOnline} />
      </button>
      <div className="compare-body measured-virtual-scroll" ref={scrollRef} role="region" aria-label={`${agentLabel} activity`} aria-busy={presentation.busy} tabIndex={0}>
        {presentation.notice === "refreshing" && <div className="muted sm" role="status">Checking for missed activity…</div>}
        {presentation.notice === "stale" && <div className="muted sm" role="status">Showing cached activity.</div>}
        {presentation.notice === "error" && <div className="muted sm" role="status">Activity refresh failed.</div>}
        {presentation.body === "timeline" ? (
          <EventTimeline
            items={items}
            driver={session.driver}
            sessionActive={isTimelineSessionActive(session.status)}
            scrollRef={scrollRef}
            historyKey={`${sessionId}:${session.eventEpoch ?? 0}`}
          />
        ) : presentation.body === "empty" ? <div className="muted sm" role="status">No activity yet.</div>
          : presentation.body === "skeleton" ? <div className="muted sm" role="status">Loading activity…</div>
            : <div className="muted sm" role="status">Activity unavailable.</div>}
      </div>
    </div>
  );
}

export function RunsView({ onNewRun }: { onNewRun: () => void }) {
  const runsDestination = destination("runs");
  const { navigate } = useStoreActions();
  const runs = useStoreSelector((s) => s.runs);
  const conn = useStoreSelector((s) => s.conn);
  const snapshotLoaded = useStoreSelector((s) => s.snapshotLoaded);
  const list = useMemo(
    () => [...runs.values()].sort((a, b) => b.createdAt - a.createdAt),
    [runs],
  );

  let body: ReactNode;
  if (list.length === 0 && (!snapshotLoaded || conn !== "online")) {
    // An empty map proves nothing before the first snapshot or while disconnected (§12.5).
    const placeholder = listPlaceholder("runs", conn);
    body = <State variant={placeholder.variant} icon={<RunsIcon />} title={placeholder.title}>{placeholder.hint}</State>;
  } else if (list.length === 0) {
    body = (
      <State
        icon={<RunsIcon />}
        title={`No ${runsDestination.name} Yet`}
        actions={<button type="button" className="btn primary" onClick={onNewRun}>New Multi-Agent Run</button>}
      >
        Start one to compare several agents on the same task.
      </State>
    );
  } else {
    body = <RunList runs={list} onOpen={(runId) => navigate({ name: "run", id: runId })} />;
  }

  return (
    <div className="page">
      <PageHeader
        title={runsDestination.name}
        description={runsDestination.description}
        primary={{ label: "New Multi-Agent Run", onClick: onNewRun }}
      />
      {body}
    </div>
  );
}

function RunList({ runs, onOpen }: { runs: RunView[]; onOpen: (runId: string) => void }) {
  return (
    <div className="runs-list surface">
      {runs.map((run) => (
        <button key={run.id} type="button" className="row row-2" onClick={() => onOpen(run.id)}>
          <span className="row-body">
            <span className="row-line">
              <span className="row-title">{run.title}</span>
              <span className="count">
                {run.sessionIds.length} Agent{run.sessionIds.length === 1 ? "" : "s"}
              </span>
            </span>
            <span className="row-sub">{run.prompt}</span>
          </span>
          <span className="row-trail">
            {run.workspaceName ? `${run.workspaceName} · ` : ""}Created {relativeTime(run.createdAt)}
          </span>
        </button>
      ))}
    </div>
  );
}

/** Keyed by run: the route renders this in place, so a direct run-to-run change would otherwise
 * reuse one instance and show the previous run's workflow, artifacts and errors. */
export function RunDetail({ runId }: { runId: string }) {
  return <RunDetailContent key={runId} runId={runId} />;
}

function RunDetailContent({ runId }: { runId: string }) {
  const api = useApi();
  const { eventEpoch, loadEvents, navigate, recoveryAfter, beginEventHistoryLoad, failEventHistoryLoad } = useStoreActions();
  const run = useStoreSelector((s) => s.runs.get(runId));
  const conn = useStoreSelector((s) => s.conn);
  const snapshotLoaded = useStoreSelector((s) => s.snapshotLoaded);
  const recoverySessionIds = useStoreSelector(
    (state) => state.runs.get(runId)?.sessionIds ?? EMPTY_SESSION_IDS,
    sameSessionIds,
  );
  const recoveryRevision = useStoreSelector((state) =>
    subscriptionRecoveryRevision(state.streamSubscriptions, recoverySessionIds));
  const recoveryGeneration = useStoreSelector((state) => state.snapshotRevision);
  const recoveryEpochKey = useStoreSelector((state) => sessionHistoryEpochKey(
    recoverySessionIds,
    (sessionId) => state.sessions.get(sessionId)?.eventEpoch ?? 0,
  ));
  const [artifacts, setArtifacts] = useState<WorkflowArtifactView[]>([]);
  const [artifactCursor, setArtifactCursor] = useState<string | undefined>();
  const [artifactPageBusy, setArtifactPageBusy] = useState(false);
  const [selectedArtifact, setSelectedArtifact] = useState<WorkflowArtifactView | null>(null);
  const [artifactError, setArtifactError] = useState<string | null>(null);
  const [workflow, setWorkflow] = useState<WorkflowInstanceDetail | null>(null);
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  const [workflowBusy, setWorkflowBusy] = useState<string | null>(null);
  // Retry delays are durable timestamps, not socket events. Keep a small local clock while a
  // delayed node exists so the button becomes actionable at readyAt even if nothing else renders.
  const [retryClock, setRetryClock] = useState(() => Date.now());
  const artifactListGeneration = useRef(0);

  const nextRetryAt = useMemo(
    () => nextWorkflowRetryAt(workflow?.nodeStates ?? [], retryClock),
    [workflow, retryClock],
  );

  useEffect(() => {
    if (nextRetryAt == null) return;
    const timer = window.setTimeout(
      () => setRetryClock(Date.now()),
      workflowRetryTimerDelay(nextRetryAt, Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [nextRetryAt, retryClock]);

  const refreshWorkflow = async (targetRunId: string) => {
    const instances = await api.workflowInstances(targetRunId);
    if (!instances.length) {
      setWorkflow(null);
      setWorkflowError(null);
      return;
    }
    const detail = await api.workflowInstance(instances[0]!.instanceId);
    setWorkflow(detail);
    setWorkflowError(null);
  };

  // Re-runs when the socket comes back online — outage-window events for run members never
  // arrived and nothing else refetches them (same gap-fetch contract as SessionDetail).
  useEffect(() => {
    if (!recoverySessionIds.length || conn !== "online" || recoveryRevision == null) return;
    let current = true;
    void recoverSessionHistories(
      recoverySessionIds.map((sessionId) => ({
        sessionId,
        after: recoveryAfter(sessionId),
        eventEpoch: eventEpoch(sessionId),
        recoveryRevision,
      })),
      {
        fetchPage: api.getSessionEventPage,
        applyPage: (id, events, pageEpoch, revision, complete) =>
          loadEvents(id, events, pageEpoch, revision, complete, recoveryGeneration),
        isCurrent: () => current,
        retryOnIdleTimeout: true,
        onRequestStart: (request) => beginEventHistoryLoad(request.sessionId, request.eventEpoch, request.recoveryRevision, recoveryGeneration),
        onRequestError: (request) => failEventHistoryLoad(request.sessionId, "Activity refresh failed.", request.eventEpoch, request.recoveryRevision, recoveryGeneration),
      },
    );
    return () => { current = false; };
  }, [api, recoverySessionIds, eventEpoch, loadEvents, recoveryAfter, conn, recoveryRevision, recoveryEpochKey, recoveryGeneration, beginEventHistoryLoad, failEventHistoryLoad]);

  useEffect(() => {
    if (!run || conn !== "online") return;
    let current = true;
    void api.workflowInstances(run.id)
      .then((instances) => instances[0] ? api.workflowInstance(instances[0].instanceId) : null)
      .then((detail) => {
        if (!current) return;
        setWorkflow(detail);
        setWorkflowError(null);
      })
      .catch((error: unknown) => { if (current) setWorkflowError((error as Error).message); });
    return () => { current = false; };
  }, [api, run?.id, run?.updatedAt, conn]);

  const dispatchNode = async (nodeId: string, attemptCount: number) => {
    if (!workflow || workflowBusy) return;
    setWorkflowBusy(nodeId);
    try {
      await api.dispatchWorkflowNode(workflow.instanceId, nodeId, `ui:${workflow.instanceId}:${nodeId}:${attemptCount + 1}`);
      await refreshWorkflow(workflow.runId);
    } catch (error) {
      setWorkflowError((error as Error).message);
    } finally {
      setWorkflowBusy(null);
    }
  };

  const resolveGate = async (nodeId: string, outcome: "success" | "failure") => {
    if (!workflow || workflowBusy) return;
    setWorkflowBusy(nodeId);
    try {
      setWorkflow(await api.resolveWorkflowGate(workflow.instanceId, nodeId, outcome));
      setWorkflowError(null);
    } catch (error) {
      setWorkflowError((error as Error).message);
    } finally {
      setWorkflowBusy(null);
    }
  };

  useEffect(() => {
    if (!run) return;
    let current = true;
    const generation = ++artifactListGeneration.current;
    setSelectedArtifact(null);
    setArtifactPageBusy(false);
    void api.runWorkflowArtifacts(run.id)
      .then(({ artifacts: next, nextCursor }) => {
        if (current && generation === artifactListGeneration.current) {
          setArtifacts(next);
          setArtifactCursor(nextCursor);
          setArtifactError(null);
        }
      })
      .catch((error: unknown) => { if (current) setArtifactError((error as Error).message); });
    return () => { current = false; };
  }, [api, run?.id, run?.updatedAt]);

  const loadMoreArtifacts = async () => {
    if (!run || !artifactCursor || artifactPageBusy) return;
    const generation = artifactListGeneration.current;
    setArtifactPageBusy(true);
    try {
      const page = await api.runWorkflowArtifacts(run.id, artifactCursor);
      if (generation === artifactListGeneration.current) {
        setArtifacts((prior) => {
          const merged = new Map(prior.map((artifact) => [artifact.artifactId, artifact]));
          for (const artifact of page.artifacts) merged.set(artifact.artifactId, artifact);
          return [...merged.values()];
        });
        setArtifactCursor(page.nextCursor);
        setArtifactError(null);
      }
    } catch (error) {
      if (generation === artifactListGeneration.current) setArtifactError((error as Error).message);
    } finally {
      if (generation === artifactListGeneration.current) setArtifactPageBusy(false);
    }
  };

  const back = () => navigate({ name: "runs" });
  if (!run) {
    const placeholder = detailPlaceholder("Run", { authoritative: snapshotLoaded, conn });
    return (
      <div className="run-detail">
        <DetailBar title={viewTitle({ name: "run", id: runId })} backLabel={backLabel("runs")} onBack={back} />
        <State
          variant={placeholder.variant}
          title={placeholder.title}
          actions={placeholder.actions.includes("back") && (
            <button type="button" className="btn primary" onClick={back}>{backLabel("runs")}</button>
          )}
        >
          {placeholder.hint}
        </State>
      </div>
    );
  }

  return (
    <div className="run-detail">
      <DetailBar title={viewTitle({ name: "run", id: runId }, run.title)} backLabel={backLabel("runs")} onBack={back} />
      <p className="detail-summary">{run.prompt}</p>

      {(workflow || workflowError) && (
        <section className="workflow-inspector" aria-label="Workflow Progress">
          <div className="workflow-inspector-head">
            <div>
              <strong>{workflow?.definition.name ?? "Workflow"}</strong>
              {workflow && <span> v{workflow.workflowVersion} · {workflow.transitionCount}/{workflow.definition.maxTransitions} Transitions</span>}
            </div>
            {workflow && <StatusBadge meta={statusMeta("workflow", workflow.status)} />}
          </div>
          {workflowError && <Notice tone="danger" compact>{workflowError}</Notice>}
          {workflow && (
            <div className="workflow-node-grid">
              {workflow.nodeStates.map((state) => {
                const node = workflow.definition.nodes.find((candidate) => candidate.nodeId === state.nodeId)!;
                const attempts = workflow.attempts.filter((attempt) => attempt.nodeId === state.nodeId);
                const latest = attempts.at(-1);
                const retryDelayed = Boolean(state.readyAt && state.readyAt > retryClock);
                return (
                  <article key={state.nodeId} className={`workflow-node workflow-node-${state.status}`}>
                    <div className="workflow-node-head">
                      <strong>{node.role}</strong>
                      <span>{titleCaseLabel(state.status.replace("_", " "))}</span>
                    </div>
                    <div className="muted sm">
                      {node.kind === "agent" ? `${node.agentId} · ${state.attemptCount}/${node.retry.maxAttempts} Attempts` : titleCaseLabel(node.kind.replace("_", " "))}
                    </div>
                    {state.outcome && <div className="workflow-node-outcome">Outcome: {titleCaseLabel(state.outcome.replace("_", " "))}</div>}
                    {latest && <div className="muted sm">Latest Attempt: {latest.status === "cancelled" ? "Canceled" : titleCaseLabel(latest.status.replace("_", " "))}</div>}
                    {state.error && <Notice tone="danger" compact>{state.error}</Notice>}
                    {node.kind === "agent" && state.status === "ready" && (
                      <button className="btn primary sm" disabled={Boolean(workflowBusy) || retryDelayed} onClick={() => void dispatchNode(node.nodeId, state.attemptCount)}>
                        {workflowBusy === node.nodeId ? "Dispatching…" : retryDelayed ? `Retry ${relativeTime(state.readyAt!)}` : "Dispatch Step"}
                      </button>
                    )}
                    {node.kind !== "agent" && state.status === "waiting_gate" && (
                      <div className="workflow-gate-actions">
                        <button className="btn primary sm" disabled={Boolean(workflowBusy)} onClick={() => void resolveGate(node.nodeId, "success")}>Continue</button>
                        <button className="btn ghost sm" disabled={Boolean(workflowBusy)} onClick={() => void resolveGate(node.nodeId, "failure")}>Stop Branch</button>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}

      {(artifacts.length > 0 || artifactError) && (
        <RunArtifacts
          artifacts={artifacts}
          more={Boolean(artifactCursor)}
          error={artifactError}
          pageBusy={artifactPageBusy}
          onLoadMore={() => void loadMoreArtifacts()}
          onOpen={setSelectedArtifact}
        />
      )}
      {selectedArtifact && <ArtifactPreviewDialog artifact={selectedArtifact} onClose={() => setSelectedArtifact(null)} />}

      <div className="compare-grid" style={{ gridTemplateColumns: `repeat(${Math.max(run.sessionIds.length, 1)}, minmax(320px, 1fr))` }}>
        {run.sessionIds.map((sessionId) => <MemberColumn key={sessionId} sessionId={sessionId} />)}
      </div>
    </div>
  );
}

/**
 * The run's artifacts (#2855): full-width two-line rows in one surface, each naming its kind, who
 * saved it, when and its size, with Show More for the next page. A row opens the preview dialog.
 */
function RunArtifacts({ artifacts, more, error, pageBusy, onLoadMore, onOpen }: {
  artifacts: readonly WorkflowArtifactView[];
  more: boolean;
  error: string | null;
  pageBusy: boolean;
  onLoadMore: () => void;
  onOpen: (artifact: WorkflowArtifactView) => void;
}) {
  const now = useTimelineClock(artifacts.length > 0);
  return (
    <section className="run-artifacts" aria-label="Workflow Artifacts">
      <h2 className="run-artifacts-head">Artifacts <span className="count">{artifacts.length}{more ? "+" : ""}</span></h2>
      {error && <Notice tone="danger" compact>{error}</Notice>}
      {artifacts.length > 0 && (
        <ul className="surface run-artifact-list">
          {artifacts.map((artifact) => (
            <li key={artifact.artifactId}>
              <ArtifactRow artifact={artifact} now={now} showAuthor onOpen={() => onOpen(artifact)} />
            </li>
          ))}
        </ul>
      )}
      {more && (
        <ListFoot>
          <BusyButton className="btn ghost sm" busy={pageBusy} progress="Loading more artifacts…" onClick={onLoadMore}>
            Show More
          </BusyButton>
        </ListFoot>
      )}
    </section>
  );
}
