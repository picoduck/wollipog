import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { SessionView } from "@wollipog/protocol";
import { formatDuration, formatRecordedRelativeTime } from "../format.js";
import {
  IncrementalSubagentProjector,
  selectedSubagentId,
  subagentTokenTotal,
  type SubagentDescriptor,
  type SubagentLifecycle,
} from "../subagents.js";
import type { TimelineItem } from "../timeline.js";
import { isTimelineSessionActive, useTimelineClock } from "../timeline-clock.js";
import { EventTimeline } from "./EventTimeline.js";

const LIFECYCLE_LABELS: Record<SubagentLifecycle, string> = {
  starting: "Starting",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  interrupted: "Interrupted",
  unreachable: "No Longer Reachable",
  unknown: "Unknown",
};

function elapsed(descriptor: SubagentDescriptor, now: number): string {
  if (descriptor.directUsage?.durationMs != null) return formatDuration(descriptor.directUsage.durationMs);
  if (descriptor.startedAt == null) return "";
  const end = descriptor.completedAt ??
    (["starting", "running"].includes(descriptor.lifecycle) ? now : descriptor.lastActivityAt);
  return end == null ? "" : formatDuration(Math.max(0, end - descriptor.startedAt));
}

export function subagentEmptyMessage(
  session: Pick<SessionView, "driver" | "status">,
  runnerOnline: boolean,
): string {
  if (session.driver === "codex" || session.driver === "codex-app-server") {
    return runnerOnline && isTimelineSessionActive(session.status)
      ? "Codex does not currently expose live subagent identity or parent linkage, so Wollipog cannot show independently selectable live output."
      : "Recorded Codex transcripts retain subagent completion summaries in the parent activity. Independently selectable output requires structured parent linkage.";
  }
  return "No subagents have been recorded for this session.";
}

export function subagentOutputLabel(
  descriptor: Pick<SubagentDescriptor, "availability" | "lifecycle">,
  runnerOnline: boolean,
): "Current Activity" | "Recorded Activity" | "Subagent Activity" {
  if (descriptor.availability === "recorded") return "Recorded Activity";
  return runnerOnline && (descriptor.lifecycle === "starting" || descriptor.lifecycle === "running")
    ? "Current Activity"
    : "Subagent Activity";
}

export function SubagentsPanel({
  session,
  items,
  runnerOnline,
  requestedId,
  focusRequest,
  onFocusRequestHandled,
  onSelect,
}: {
  session: SessionView;
  items: TimelineItem[];
  runnerOnline: boolean;
  requestedId?: string | null;
  focusRequest?: number;
  onFocusRequestHandled?: (request: number) => void;
  onSelect: (id: string) => void;
}) {
  const projector = useRef<IncrementalSubagentProjector | null>(null);
  if (!projector.current) projector.current = new IncrementalSubagentProjector();
  const projection = useMemo(() => projector.current!.project(items, {
    sessionStatus: session.status,
    runnerOnline,
    availability: runnerOnline && isTimelineSessionActive(session.status) ? "live" : "recorded",
  }), [items, runnerOnline, session.status]);
  const descriptors = projection.descriptors;
  const selectionScope = `${session.id}:${session.eventEpoch ?? 0}`;
  const automaticSelection = useRef<{ scope: string; id: string | null }>({ scope: selectionScope, id: null });
  if (automaticSelection.current.scope !== selectionScope) {
    automaticSelection.current = { scope: selectionScope, id: null };
  }
  const selectedId = selectedSubagentId(descriptors, requestedId, automaticSelection.current.id);
  if (requestedId == null) automaticSelection.current.id = selectedId;
  const selected = descriptors.find((descriptor) => descriptor.id === selectedId);
  const selectionUnavailable = requestedId != null && !selected;
  const selectionAmbiguous = requestedId != null && projection.ambiguousIds.has(requestedId);
  const output = useMemo(
    () => projector.current!.timeline(selectedId),
    [projection, selectedId],
  );
  const outputScrollRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const unavailableRef = useRef<HTMLDivElement>(null);
  const [internalFocusRequest, setInternalFocusRequest] = useState(0);
  const handledInternalFocusRequest = useRef(0);
  const labelId = `subagents-detail-${useId().replace(/:/g, "")}`;
  const metaId = `${labelId}-meta`;
  const clockEnabled = descriptors.some((descriptor) =>
    descriptor.lifecycle === "starting" || descriptor.lifecycle === "running");
  const now = useTimelineClock(clockEnabled);

  useEffect(() => {
    const internalPending = internalFocusRequest > handledInternalFocusRequest.current;
    if (focusRequest === undefined && !internalPending) return;
    const focusTarget = selected ? detailRef.current : unavailableRef.current;
    if (!focusTarget) return;
    focusTarget.focus();
    if (internalPending) handledInternalFocusRequest.current = internalFocusRequest;
    if (focusRequest !== undefined) onFocusRequestHandled?.(focusRequest);
  }, [focusRequest, internalFocusRequest, onFocusRequestHandled, selected, selectionUnavailable]);

  const openNestedSubagent = useCallback((id: string) => {
    setInternalFocusRequest((request) => request + 1);
    onSelect(id);
  }, [onSelect]);

  if (descriptors.length === 0 && !selectionUnavailable) {
    return (
      <div className="subagents-empty" role="status">
        <div className="subagents-empty-title">No Selectable Subagents</div>
        <p>{subagentEmptyMessage(session, runnerOnline)}</p>
      </div>
    );
  }

  return (
    <div className="subagents-panel">
      {session.status === "input_required" && (
        <div className="hint warn subagents-session-note" role="status">
          The parent session needs input. Current protocol data cannot attribute that request to a specific subagent.
        </div>
      )}
      <div className="subagents-list" role="list" aria-label="Subagents">
        {descriptors.map((descriptor) => {
          const selectedRow = descriptor.id === selectedId;
          const tokens = subagentTokenTotal(descriptor.directUsage);
          const duration = elapsed(descriptor, now);
          const activity = formatRecordedRelativeTime(descriptor.lastActivityAt, now);
          const cappedDepth = Math.min(descriptor.depth, 1);
          return (
            <div key={descriptor.id} role="listitem">
              <button
                type="button"
                className={`subagent-list-row${selectedRow ? " selected" : ""}`}
                style={{ paddingLeft: 12 + cappedDepth * 18 }}
                aria-current={selectedRow ? "true" : undefined}
                onClick={() => onSelect(descriptor.id)}
              >
                <span className="subagent-state-dot" data-lifecycle={descriptor.lifecycle} aria-hidden="true" />
                <span className="subagent-list-copy">
                  <span className="subagent-list-title">{descriptor.title}</span>
                  <span className="subagent-list-meta">
                    <span>{LIFECYCLE_LABELS[descriptor.lifecycle]}</span>
                    {descriptor.availability === "recorded" && <span>Recorded</span>}
                    {duration && <span>{duration}</span>}
                    {tokens != null && <span>{tokens.toLocaleString()} Tokens</span>}
                    {activity && <span>Last Activity {activity}</span>}
                    {descriptor.depth > 1 && <span>Depth {descriptor.depth + 1}</span>}
                  </span>
                </span>
              </button>
            </div>
          );
        })}
      </div>
      {selectionUnavailable && (
        <div
          ref={unavailableRef}
          className="hint warn subagent-selection-unavailable"
          role="status"
          tabIndex={-1}
        >
          {selectionAmbiguous
            ? "Multiple recorded subagents share this provider identity, so Wollipog cannot select one safely."
            : "The requested subagent is no longer available in this session."}
        </div>
      )}
      {selected && (
        <section
          ref={detailRef}
          className="subagent-detail"
          role="region"
          tabIndex={-1}
          aria-labelledby={labelId}
          aria-describedby={metaId}
        >
          <div className="subagent-detail-head">
            <div>
              <div id={labelId} className="subagent-detail-title">{selected.title}</div>
              <div id={metaId} className="subagent-detail-meta">
                {LIFECYCLE_LABELS[selected.lifecycle]}
                {` · ${subagentOutputLabel(selected, runnerOnline)}`}
                {selected.childIds.length > 0 ? ` · ${selected.childIds.length} Nested` : ""}
              </div>
            </div>
            {subagentTokenTotal(selected.inclusiveUsage) !== subagentTokenTotal(selected.directUsage) && (
              <span className="subagent-inclusive-usage">
                {subagentTokenTotal(selected.inclusiveUsage)?.toLocaleString()} Tokens Including Nested
              </span>
            )}
          </div>
          <div
            key={`${session.id}:${session.eventEpoch ?? 0}:${selected.id}`}
            ref={outputScrollRef}
            className="subagent-output"
            tabIndex={0}
          >
            {output.length > 0 ? (
              <EventTimeline
                items={output}
                scrollRef={outputScrollRef}
                historyKey={`${session.id}:${session.eventEpoch ?? 0}:${selected.id}`}
                sessionActive={selected.lifecycle === "starting" || selected.lifecycle === "running"}
                ariaLabel="Subagent Activity"
                onOpenSubagent={openNestedSubagent}
              />
            ) : (
              <div className="subagent-output-empty">No Output Recorded Yet</div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
