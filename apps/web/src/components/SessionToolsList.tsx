import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  runnerSupportsProtocol,
  type CampaignWorkSummary,
  type ChildSessionRegistryPage,
  type DescendantRequestView,
  type SessionView,
} from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { backgroundJobCurrentState } from "../background-job-stop.js";
import { workspaceFolderName } from "../files-panel.js";
import { runnerDisplay } from "../runners.js";
import { shortcutDisplay } from "../shortcuts.js";
import { statusMeta } from "../status-meta.js";
import { useOptionalStoreSelector } from "../store.js";
import { IncrementalSubagentProjector } from "../subagents.js";
import type { TimelineItem } from "../timeline.js";
import { isCurrentWorker, workerRoster, type WorkerState } from "../worker-roster.js";
import {
  SESSION_TOOL_GROUPS,
  SESSION_TOOLS,
  SIDE_CHAT_FACT,
  TERMINAL_FACT,
  agentsFact,
  backgroundFact,
  backgroundInventoryGap,
  browserFact,
  campaignFact,
  decisionsFact,
  filesFact,
  requestsFact,
  reviewFact,
  sessionToolAvailability,
  type SessionTool,
  type SessionToolContext,
  type SessionToolId,
} from "../session-tools.js";
import { durableAgentDescriptors, mergeCompactAttentionOwners, mergeDurableAgents } from "./AgentsPanel.js";
import { CountBadge } from "./CountBadge.js";
import {
  BotIcon,
  CampaignIcon,
  CommandLineIcon,
  DiffIcon,
  FolderIcon,
  GlobeIcon,
  GridIcon,
  HistoryIcon,
  InboxIcon,
  JobsIcon,
  MessageSquareIcon,
} from "./Icons.js";
import { Notice } from "./Notice.js";
import { StatusBadge } from "./StatusBadge.js";
import type { DescendantRequestStatus } from "./SessionRequestPanel.js";
import type { GitStatus } from "./useGitStatus.js";
import { useIsCoarsePointer } from "./useIsMobile.js";

/**
 * Each tool's one glyph wherever it is named (§18, #1955): the switcher, its title, and the Session
 * Tools list. Keyed by `SESSION_TOOLS` ids, so a tool without a glyph is a compile error.
 */
export const SESSION_TOOL_ICONS: Record<SessionToolId, (props: { size?: number }) => ReactNode> = {
  launcher: GridIcon,
  review: DiffIcon,
  files: FolderIcon,
  browser: GlobeIcon,
  terminal: CommandLineIcon,
  subagents: BotIcon,
  sidechat: MessageSquareIcon,
  background: JobsIcon,
  campaign: CampaignIcon,
  requests: InboxIcon,
  decisions: HistoryIcon,
};

export function SessionToolIcon({ id, size = 16 }: { id: SessionToolId; size?: number }) {
  const Icon = SESSION_TOOL_ICONS[id];
  return <Icon size={size} />;
}

export interface SessionToolsListProps {
  session: SessionView;
  runnerOnline: boolean;
  runnerProtocolVersion: number | null | undefined;
  /** Why the omitted job inventory could not be loaded, if it could not. */
  backgroundInventoryError: string | null;
  git: GitStatus;
  items: TimelineItem[];
  context: SessionToolContext;
  decisionCount: number;
  decisionsHaveMore: boolean;
  decisionStatus: "loading" | "error" | "ready";
  descendantRequests: readonly DescendantRequestView[];
  descendantRequestStatus: DescendantRequestStatus;
  /** `keyboard` when Enter or Space chose the tool, rather than a pointer. */
  onChoose: (tool: SessionToolId, keyboard: boolean) => void;
}

/**
 * Session Tools (#2844; docs/design-system.md §4.9, §5.2): the panel's landing list, from the same
 * `SESSION_TOOLS` the tool switcher renders, top-aligned, under the Code, Work and Decisions group
 * labels. Each row is a two-line row: its name, and a live fact about what is inside, or, for a
 * tool that cannot open, why, as visible text and the row's description. An unavailable row stays
 * focusable (`aria-disabled`), so keyboard, touch and screen-reader users reach the reason (#1261).
 */
export function SessionToolsList(props: SessionToolsListProps) {
  const availability = props.context.campaignAvailability;
  const campaignSessionId = availability.kind === "available" ? availability.campaignSessionId : null;
  // The campaign's summary rides on its root session's projection, which the server re-sends on
  // every ledger write (useCampaignStatus); a member reads it when this browser holds the root.
  // Harness pages render the panel without a store; their rows then read no campaign or machine.
  const storedWork = useOptionalStoreSelector((s) => campaignSessionId && campaignSessionId !== props.session.id
    ? s.sessions.get(campaignSessionId)?.orchestratorCampaign?.work ?? null
    : null);
  const runner = useOptionalStoreSelector((s) => s.runners.get(props.session.runnerId));
  const campaignWork = campaignSessionId === props.session.id ? props.session.orchestratorCampaign?.work ?? null : storedWork ?? null;
  const machine = runnerDisplay(runner, undefined, props.session.runnerId).name || null;
  return <SessionToolsListView {...props} campaignWork={campaignWork} machine={machine} />;
}

/**
 * Review's required findings, as its findings section counts them (open or sent, and required).
 * Read when the list opens and again after each git status read, which follows every turn, so a
 * finding resolved elsewhere shows here while the list stays open.
 */
function useRequiredFindings(sessionId: string, observation: number): number {
  const api = useApi();
  const [required, setRequired] = useState<{ sessionId: string; count: number } | null>(null);
  useEffect(() => {
    let current = true;
    api.reviewFindings(sessionId).then(
      (response) => { if (current) setRequired({ sessionId, count: response.summary.requiredUnresolved }); },
      () => { /* the fact then names the changes alone */ },
    );
    return () => { current = false; };
  }, [api, sessionId, observation]);
  return required?.sessionId === sessionId ? required.count : 0;
}

/** The session's artifacts on its first page, read on the same cadence as the findings. */
function useArtifactCount(sessionId: string, observation: number): { count: number; more: boolean } | null {
  const api = useApi();
  const [artifacts, setArtifacts] = useState<{ sessionId: string; count: number; more: boolean } | null>(null);
  useEffect(() => {
    let current = true;
    api.sessionWorkflowArtifacts(sessionId).then(
      (page) => { if (current) setArtifacts({ sessionId, count: page.artifacts.length, more: Boolean(page.nextCursor) }); },
      () => { /* the fact then offers a web preview alone */ },
    );
    return () => { current = false; };
  }, [api, sessionId, observation]);
  return artifacts?.sessionId === sessionId ? artifacts : null;
}

/**
 * The first page of the session's durable child-session registry, the Agents panel's authority for
 * subagents whose launch is outside the loaded transcript. Null until read, and on a control plane
 * that has none, where the list counts the transcript's agents as the panel then does.
 */
function useChildRegistry(session: Pick<SessionView, "id" | "eventEpoch">, observation: number): ChildSessionRegistryPage | null {
  const api = useApi();
  const generation = `${session.id}:${session.eventEpoch ?? 0}`;
  const [read, setRead] = useState<{ generation: string; page: ChildSessionRegistryPage | null } | null>(null);
  useEffect(() => {
    let current = true;
    api.childSessions(session.id, session.eventEpoch ?? 0, 0, CHILD_REGISTRY_PAGE).then(
      (page) => { if (current) setRead({ generation, page }); },
      () => { if (current) setRead({ generation, page: null }); },
    );
    return () => { current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, generation, observation]);
  return read?.generation === generation ? read.page : null;
}
const CHILD_REGISTRY_PAGE = 50;

/**
 * The Files and Terminal rows' reasons on an older runner: short enough to read whole on one line at
 * phone width, beside the notice above the list that says which machine to update and how. The
 * switcher keeps the full sentence as its item description.
 */
const OLDER_RUNNER_REASONS: Partial<Record<SessionToolId, string>> = {
  files: "Needs a newer runner to browse files",
  terminal: "Needs a newer runner to open a terminal",
};

/** The most urgent current state first, for the Agents row's one status badge (§11.1). */
const AGENT_URGENCY: readonly WorkerState[] = ["input_required", "working", "waiting"];

interface RowFact {
  text: string;
  badge?: ReactNode;
}

function SessionToolsListView({
  session,
  runnerOnline,
  runnerProtocolVersion,
  backgroundInventoryError,
  git,
  items,
  context,
  decisionCount,
  decisionsHaveMore,
  decisionStatus,
  descendantRequests,
  descendantRequestStatus,
  onChoose,
  campaignWork,
  machine,
}: SessionToolsListProps & { campaignWork: CampaignWorkSummary | null; machine: string | null }) {
  const coarsePointer = useIsCoarsePointer();
  const groupId = useId();
  const requiredFindings = useRequiredFindings(session.id, git.observation);
  const artifacts = useArtifactCount(session.id, git.observation);

  const registry = useChildRegistry(session, git.observation);

  // The Agents panel's own agents and roster rules (AgentsPanel.tsx, worker-roster.ts), limited to
  // subagents: the transcript's projection joined with the durable registry when it has one.
  const projector = useRef(new IncrementalSubagentProjector());
  const subagents = useMemo(() => {
    const projection = projector.current.project(items, {
      sessionStatus: session.status, runnerOnline, availability: runnerOnline ? "live" : "recorded",
    });
    const unresolved = new Set(mergeCompactAttentionOwners(registry?.attentionOwners ?? [], session.attentionOwners ?? [])
      .filter((owner) => !owner.resolved).map((owner) => owner.toolCallId));
    const agents = registry
      ? mergeDurableAgents(durableAgentDescriptors(registry.children, session.status, runnerOnline), projection.descriptors, unresolved)
      : projection.descriptors.filter((agent) => !unresolved.has(agent.id));
    return workerRoster(session, agents, [], () => runnerOnline)
      .filter((row) => row.target.kind === "subagent");
  }, [items, registry, runnerOnline, session]);
  const urgent = AGENT_URGENCY.find((state) => subagents.some((row) => isCurrentWorker(row) && row.state === state));
  const agentsBadge = urgent && (() => {
    const meta = statusMeta("job", urgent);
    const n = subagents.filter((row) => row.state === urgent).length;
    return <StatusBadge meta={meta} label={`${n} ${meta.label}`} />;
  })();

  const waitingForYou = descendantRequests.filter((request) => request.responseOwner === "human").length;

  const changes = git.status
    ? { files: git.status.files.length, truncated: git.status.filesTruncated === true, staged: git.status.stagedCount ?? 0 }
    : git.busy ? "checking" as const : "unknown" as const;
  const fact = (id: SessionToolId): RowFact => {
    switch (id) {
      case "review": return { text: reviewFact(changes, requiredFindings) };
      case "files": return { text: filesFact(workspaceFolderName(session.worktreePath, session.workspaceName)) };
      case "browser": return { text: browserFact(artifacts) };
      case "terminal": return { text: TERMINAL_FACT };
      case "subagents": return { text: agentsFact(subagents.length, registry?.nextAfter != null), badge: agentsBadge || undefined };
      case "sidechat": return { text: SIDE_CHAT_FACT };
      case "background": {
        // No jobs to count: an inventory still loading, a server that does not report one, or only
        // the runner's aggregate state, as the Background Work panel says. Never "nothing has run".
        const gap = backgroundInventoryGap(session, backgroundInventoryError);
        if (gap) return { text: backgroundFact(gap) };
        // The Background Work panel's own job states, so only a verified job counts as running.
        const inventorySupported = runnerSupportsProtocol(runnerProtocolVersion, "managedBackgroundInventory");
        const states = (session.backgroundJobs ?? []).map((job) => backgroundJobCurrentState(
          job, session.backgroundWorkState, runnerOnline, inventorySupported, Date.now()));
        return { text: backgroundFact(states) };
      }
      case "campaign": return { text: campaignFact(campaignWork) };
      case "requests": return {
        text: requestsFact(descendantRequests, descendantRequestStatus),
        badge: waitingForYou > 0 ? <CountBadge count={waitingForYou} /> : undefined,
      };
      case "decisions": return { text: decisionsFact(decisionCount, decisionsHaveMore, decisionStatus) };
      case "launcher": return { text: "" };
    }
  };

  // One neutral notice explains an older machine once; the rows keep their own reasons (#2844).
  const missing = [
    !context.filesSupported && "browse files",
    !context.terminalSupported && "open a terminal",
  ].filter((part): part is string => Boolean(part));

  return (
    <div className="session-tools">
      {missing.length > 0 && (
        <Notice tone="neutral" compact role="status">
          {`${machine ?? "This machine"} runs an older Wollipog. Update it to ${missing.join(" and ")}.`}
        </Notice>
      )}
      {SESSION_TOOL_GROUPS.map((group, index) => (
        <div key={group} className="session-tools-group" role="group" aria-labelledby={`${groupId}-${index}`}>
          <h3 className="group-label" id={`${groupId}-${index}`}>{group}</h3>
          {SESSION_TOOLS.filter((tool) => tool.group === group).map((tool) => {
            const availability = sessionToolAvailability(tool.id, context);
            if (!availability.listed) return null;
            const reason = availability.unavailableReason && (OLDER_RUNNER_REASONS[tool.id] ?? availability.unavailableReason);
            return (
              <SessionToolRow
                key={tool.id}
                tool={tool}
                reason={reason}
                fact={fact(tool.id)}
                keycaps={!coarsePointer}
                onChoose={onChoose}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

function SessionToolRow({
  tool,
  reason,
  fact,
  keycaps,
  onChoose,
}: {
  tool: SessionTool;
  reason: string | null;
  fact: RowFact;
  keycaps: boolean;
  onChoose: (tool: SessionToolId, keyboard: boolean) => void;
}) {
  const id = useId();
  const unavailable = reason !== null;
  const badge = unavailable ? undefined : fact.badge;
  return (
    <button
      type="button"
      className="row row-2 session-tool"
      data-tool={tool.id}
      aria-labelledby={`${id}-name`}
      aria-describedby={badge ? `${id}-badge ${id}-fact` : `${id}-fact`}
      aria-disabled={unavailable ? "true" : undefined}
      // A click from Enter or Space carries no pointer press count (the switcher's rule, #2852).
      onClick={unavailable ? undefined : (event) => onChoose(tool.id, event.detail === 0)}
    >
      <span className="session-tool-tile" aria-hidden="true"><SessionToolIcon id={tool.id} /></span>
      <span className="row-body">
        <span className="row-line">
          <span className="row-title" id={`${id}-name`}>{tool.name}</span>
          {badge && <span className="session-tool-badge" id={`${id}-badge`}>{badge}</span>}
          {/* Trailing on the name's line, so the fact below keeps the row's whole width. */}
          {keycaps && tool.shortcut && !unavailable && <kbd>{shortcutDisplay(tool.shortcut)}</kbd>}
        </span>
        <span className="row-sub" id={`${id}-fact`}>{unavailable ? reason : fact.text}</span>
      </span>
    </button>
  );
}
