import { useMemo, useState, type ReactNode } from "react";
import { isPolicyApproval, isTerminal, normalizeSourcePath, sessionRole, type GitChecksSummary, type PlanEntry, type SessionView, type SourceLocation } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { useStoreActions, useStoreSelector } from "../store.js";
import { deriveSidePaneContent, type TimelineItem } from "../timeline.js";
import {
  COMMIT_ACTION_LABELS,
  deriveChanges,
  deriveCommitAction,
  deriveHost,
  deriveSubagents,
  fixChecksPrompt,
  forgeStateLabel,
  legacyLocalGitFacts,
  remoteHttpUrl,
  visibleForgeFacts,
  type GitPresentation,
} from "../pinned-summary.js";
import { statusMeta } from "../status-meta.js";
import { pullRequestStateLabel } from "../worktree-identity.js";
import type { GitStatus, GitSummary } from "./useGitStatus.js";
import { GitPinnedSection, type GitBranchFallback } from "./GitVisibility.js";
import { SummaryDisclosure, SummaryRow, SummarySection } from "./PinnedSummaryRows.js";
import { AgentIcon } from "./AgentIcon.js";
import {
  AccountIcon,
  ArrowUpIcon,
  ChildSessionRequestsIcon,
  ComputerIcon,
  DialIcon,
  DiffIcon,
  FolderIcon,
  GlobeIcon,
  JobsIcon,
  PlanInProgressIcon,
  PlanPendingIcon,
  PullRequestIcon,
  SkillsIcon,
  SuccessIcon,
  UpdatedIcon,
  WarningIcon,
  WorkflowDecisionsIcon,
} from "./Icons.js";
import { BackgroundDeliveryBadge, BackgroundNotificationBadge, Spinner } from "./common.js";
import { AccountIdentifier } from "./AccountIdentifier.js";
import { StatusBadge } from "./StatusBadge.js";
import { shownWatchdogDelivery } from "../background-delivery-status.js";
import { effortLabel, relativeTime, resolvedModelLabel, shortenPath } from "../format.js";
import { effectiveModelEffortForDisplay, resolveCaps, resolveEffectiveCaps } from "../caps.js";
import { sessionAgentLabel } from "./agent-options.js";
import { safeExternalHref } from "../external-href.js";
import { childSessionRequestsLabel, workflowDecisionsSummary } from "./OrchestratorControlsDialog.js";

const BUSY = ["queued", "starting", "running", "input_required"];

/** gh and glab report OPEN, OPENED, MERGED and CLOSED; a pull request's state is a fact (§11.2). */
function requestNoun(kind: string | undefined): string {
  return kind === "merge_request" ? "Merge Request" : "Pull Request";
}

/**
 * The Pinned Summary's contents (#2160): the session's fact sheet, in four sections of one-line
 * rows that state each fact once — Session, Environment, Git and Activity. The session bar carries
 * the session's status; every other fact about it lives here. The container (docked column, drawer
 * or phone sheet) is PinnedSummaryDock or the sheet dialog (#2147).
 */
export function PinnedSummary({
  session,
  git,
  gitSummary,
  gitPresentation,
  richGitSupported,
  items,
  onOpenReview,
  onOpenBackgroundWork,
  onOpenSourceLocation,
  onOpenOrchestratorControls,
  skillsUnavailableReason = null,
}: {
  session: SessionView;
  git: GitStatus;
  gitSummary: GitSummary;
  gitPresentation: GitPresentation;
  richGitSupported: boolean;
  items: TimelineItem[];
  onOpenReview: () => void;
  onOpenBackgroundWork?: () => void;
  onOpenSourceLocation: (location: SourceLocation) => void;
  /** Opens Orchestrator Controls, where an Orchestrator's routing facts below are changed (#2192). */
  onOpenOrchestratorControls?: () => void;
  /** Set while the session's target lacks the Machine's assigned skills (#1977): the fact the
   * dismissible session notice states, kept here after it is dismissed. */
  skillsUnavailableReason?: string | null;
}) {
  const { navigate } = useStoreActions();
  const runners = useStoreSelector((s) => s.runners);
  const boxes = useStoreSelector((s) => s.boxes);
  const runs = useStoreSelector((s) => s.runs);
  const sessions = useStoreSelector((s) => s.sessions);
  const runner = runners.get(session.runnerId);
  const runnerOnline = runner?.status === "online";
  const pickerCaps = resolveCaps(runner, session);
  const effectiveCaps = resolveEffectiveCaps(runner, session);
  const effective = effectiveModelEffortForDisplay(
    effectiveCaps, session.driver, session.model, session.effort, pickerCaps,
  );
  const effectiveModel = effective.model;
  const effectiveEffort = effective.effort;
  // SessionDetail owns both reads so compact and pinned presentations share one
  // session-tagged snapshot while status and summary keep independent refresh cycles.
  const summary = gitSummary.summary;
  const host = deriveHost(session, runner, boxes.values());
  const richFactsVisible = gitPresentation.state !== "offline" &&
    gitPresentation.state !== "loading" &&
    gitPresentation.state !== "unavailable" &&
    gitPresentation.state !== "not_repository";
  const legacyFacts = legacyLocalGitFacts(git.status, summary);
  const displayedFacts = richGitSupported
    ? richFactsVisible ? gitPresentation.facts : null
    : legacyFacts;
  // Review mutations remain linked-worktree-only even though v76 allows read-only facts for a
  // primary checkout. Never render a button that can only open Review's unavailable state.
  const reviewable = !!session.worktreePath;
  const changes = deriveChanges(displayedFacts, git.status?.files.length);
  const commitAction = deriveCommitAction(reviewable ? displayedFacts : null);
  const subagents = deriveSubagents(session, runs, sessions);
  const forgeFactsVisible = !richGitSupported || gitPresentation.state !== "not_repository";
  const { forge, remoteUrl, pr, checks } = visibleForgeFacts(
    summary,
    displayedFacts?.remoteUrl,
    forgeFactsVisible,
  );
  const pane = useMemo(() => deriveSidePaneContent(items), [items]);
  const activeWorktree = session.worktrees?.find((worktree) => worktree.path === session.worktreePath);
  const folderPath = session.worktreePath ??
    runner?.workspaces?.find((workspace) => workspace.id === session.workspaceId)?.path ??
    null;
  // The branch when no current Git read can say: a legacy runner's read, then the session record,
  // and only then the name Wollipog gives a worktree branch.
  const legacyBranch = legacyFacts?.branch ?? activeWorktree?.branch ??
    (session.worktreePath ? `agent/${session.id}` : null);
  const branchFallback: GitBranchFallback | null = !richGitSupported
    ? legacyBranch
      ? { name: legacyBranch, kind: session.worktreePath ? "Worktree" : null, title: session.worktreePath ?? undefined }
      : null
    : activeWorktree
      ? { name: activeWorktree.branch, kind: "Worktree", title: activeWorktree.path }
      : null;
  // The forge's own pull request first; the session record's link when the forge has not said.
  const pullRequest = pr
    ? {
        title: pr.title || `${pr.kind === "merge_request" ? "MR" : "PR"} #${pr.number}`,
        state: forgeStateLabel(pr.state),
        href: safeExternalHref(pr.url),
        tooltip: `${requestNoun(pr.kind)} #${pr.number}${pr.title ? `: ${pr.title}` : ""}`,
      }
    : activeWorktree?.pullRequest
      ? {
          title: requestNoun(activeWorktree.pullRequest.kind),
          state: pullRequestStateLabel(activeWorktree.pullRequest.state),
          href: safeExternalHref(activeWorktree.pullRequest.url),
          tooltip: activeWorktree.pullRequest.url,
        }
      : null;
  const canPrompt = runnerOnline && !isTerminal(session.status) && !isPolicyApproval(session.pendingApproval);
  const refreshGit = async () => {
    await Promise.all([git.refreshStatusOnly(), gitSummary.refresh()]);
  };
  const modelLabel = [
    session.resolvedModel ? resolvedModelLabel(session.resolvedModel) : (effectiveModel?.displayName ?? effectiveModel?.id),
    effectiveEffort ? effortLabel(effectiveEffort) : undefined,
  ].filter(Boolean).join(" · ");
  // Background work in the status vocabulary; untracked detached work is a fact about the provider.
  const backgroundWorkState = session.backgroundWorkState === "resumed" ? undefined : session.backgroundWorkState;
  const backgroundWorkMeta = backgroundWorkState === "running"
    ? statusMeta("job", "running")
    : backgroundWorkState === "orphaned"
      ? statusMeta("job", "lost")
      : backgroundWorkState === "continuation_pending"
        ? statusMeta("background_work", "continuation_pending")
        : null;
  const backgroundWorkUntracked = !backgroundWorkMeta && session.backgroundWorkTracking === "untracked";
  const watchdogState = shownWatchdogDelivery(session.backgroundDeliveries)?.watchdogState;
  // How an Orchestrator's requests and decisions are routed; each row opens the dialog that changes
  // it. The value is the row's second line: beside a label this long it would truncate in the column.
  const orchestrator = sessionRole(session) === "orchestrator" && onOpenOrchestratorControls !== undefined;

  return (
    <div className="ps-body">
      <SummarySection title="Session">
        <SummaryRow
          icon={<AgentIcon driver={session.driver} agentName={session.agentName} size={14} />}
          label="Agent"
          value={sessionAgentLabel(session.agentName, session.driver, session.agentId)}
        />
        {modelLabel && (
          <SummaryRow
            icon={<DialIcon className="ps-icon" size={14} aria-hidden="true" />}
            label="Model"
            value={modelLabel}
            title={session.resolvedModel ?? modelLabel}
          />
        )}
        {session.providerAccountLabel && (
          <SummaryRow
            icon={<AccountIcon className="ps-icon" size={14} aria-hidden="true" />}
            label="Account"
            value={<AccountIdentifier identity={`${session.id}:${session.providerAccountId ?? ""}`} value={session.providerAccountLabel} label="Account Email" />}
            note={session.providerAccountAutomaticallySelected ? "Chosen Automatically" : undefined}
          />
        )}
        {orchestrator && (
          <SummaryRow
            icon={<ChildSessionRequestsIcon className="ps-icon" size={14} aria-hidden="true" />}
            label="Child Session Requests"
            note={childSessionRequestsLabel(session.parentControl)}
            title="Open Orchestrator Controls"
            onClick={onOpenOrchestratorControls}
          />
        )}
        {orchestrator && session.parentControlPolicy && (
          <SummaryRow
            icon={<WorkflowDecisionsIcon className="ps-icon" size={14} aria-hidden="true" />}
            label="Workflow Decisions"
            note={workflowDecisionsSummary(session.parentControlPolicy.decisions)}
            title="Open Orchestrator Controls"
            onClick={onOpenOrchestratorControls}
          />
        )}
        <SummaryRow
          icon={<UpdatedIcon className="ps-icon" size={14} aria-hidden="true" />}
          label="Updated"
          value={relativeTime(session.updatedAt)}
        />
        {(backgroundWorkMeta || backgroundWorkUntracked) && (
          <SummaryRow
            icon={<JobsIcon className="ps-icon" size={14} aria-hidden="true" />}
            label="Background Work"
            value={backgroundWorkMeta ? <StatusBadge meta={backgroundWorkMeta} inline /> : "Not Tracked"}
            title={backgroundWorkUntracked
              ? "This provider does not expose a durable detached-work lifecycle. Wollipog cannot promise automatic completion, cancellation, or recovery."
              : "Open Background Work"}
            onClick={onOpenBackgroundWork}
          />
        )}
        {watchdogState && (
          <div className="ps-row ps-receipt">
            <BackgroundDeliveryBadge state={watchdogState} onOpen={onOpenBackgroundWork} />
          </div>
        )}
        {session.backgroundDeliveries?.flatMap((delivery) => delivery.notifications ?? []).slice(-2).map((receipt) => (
          <div className="ps-row ps-receipt" key={receipt.deliveryId}>
            <BackgroundNotificationBadge state={receipt.state} />
          </div>
        ))}
      </SummarySection>

      <SummarySection title="Environment">
        <SummaryRow
          icon={host.kind === "remote"
            ? <GlobeIcon className="ps-icon" size={14} aria-hidden="true" />
            : <ComputerIcon className="ps-icon" size={14} aria-hidden="true" />}
          label="Machine"
          value={host.name || host.detail || host.label}
          title={`${host.label} machine${host.detail ? `: ${host.detail}` : ""}`}
        />
        {folderPath && (
          <SummaryRow
            icon={<FolderIcon className="ps-icon" size={14} aria-hidden="true" />}
            label="Folder"
            value={shortenPath(folderPath)}
            title={folderPath}
          />
        )}
        {skillsUnavailableReason && (
          <SummaryRow
            icon={<SkillsIcon className="ps-icon" size={14} aria-hidden="true" />}
            label="Skills"
            value="Not Available"
            note={skillsUnavailableReason}
          />
        )}
      </SummarySection>

      <GitPinnedSection
        model={gitPresentation}
        rich={richGitSupported}
        onRefresh={refreshGit}
        folderPath={folderPath}
        remote={remoteUrl ? { url: remoteUrl, href: remoteHttpUrl(remoteUrl) } : null}
        branchFallback={branchFallback}
        checkedAt={Math.max(git.observedAt ?? 0, gitSummary.observedAt ?? 0) || null}
      >
        {changes && (
          <SummaryRow
            icon={<DiffIcon className="ps-icon" size={14} aria-hidden="true" />}
            label="Changes"
            value={changes.kind === "lines" ? (
              <>
                <span className="ps-add">+{changes.added.toLocaleString()}</span>{" "}
                <span className="ps-del">{"−"}{changes.deleted.toLocaleString()}</span>
              </>
            ) : (
              // Untracked-only / binary / pre-v20 dirty trees: numstat can't count lines.
              changes.count != null ? `${changes.count} file${changes.count === 1 ? "" : "s"}` : "Changed"
            )}
            title={reviewable ? "Open Review" : undefined}
            onClick={reviewable ? onOpenReview : undefined}
          />
        )}
        {commitAction && commitAction !== "up_to_date" && (
          <SummaryRow
            icon={<ArrowUpIcon className="ps-icon" size={14} aria-hidden="true" />}
            label={COMMIT_ACTION_LABELS[commitAction]}
            title="Open Review"
            onClick={onOpenReview}
          />
        )}
        {pullRequest && (
          <SummaryRow
            icon={<PullRequestIcon className="ps-icon" size={14} aria-hidden="true" />}
            label={pullRequest.title}
            value={pullRequest.state}
            longLabel
            href={pullRequest.href}
            title={pullRequest.tooltip}
          />
        )}
        {checks && <ChecksRow checks={checks} session={session} canPrompt={canPrompt} kind={pr?.kind} />}
        {forge?.authenticationError && (
          <SummaryRow
            icon={<WarningIcon className="ps-icon" size={14} aria-hidden="true" />}
            label="Forge Authentication Needed"
            title={forge.authenticationError}
            warning
          />
        )}
        {forge?.statusError && (
          <SummaryRow
            icon={<WarningIcon className="ps-icon" size={14} aria-hidden="true" />}
            label="Forge Status Unavailable"
            title={forge.statusError}
            warning
          />
        )}
      </GitPinnedSection>

      {(pane.plan.length > 0 || pane.artifacts.length > 0 || pane.tools.length > 0 || subagents.length > 0) && (
        <SummarySection title="Activity">
          {pane.plan.length > 0 && (
            <SummaryDisclosure label="Plan" count={pane.plan.length}>
              <ul className="ps-items">
                {pane.plan.map((entry, i) => (
                  <li key={i} className={`ps-item plan-${entry.status}`}>
                    <PlanStepIcon status={entry.status} />
                    <span className="ps-item-text">{entry.content}</span>
                  </li>
                ))}
              </ul>
            </SummaryDisclosure>
          )}
          {pane.artifacts.length > 0 && (
            <SummaryDisclosure label="Files" count={pane.artifacts.length}>
              <ul className="ps-items">
                {pane.artifacts.map((artifact, i) => {
                  const path = normalizeSourcePath(artifact.path);
                  const name = artifact.path.split(/[/\\]/).pop() || artifact.path;
                  return (
                    <li key={i}>
                      {path ? (
                        <button type="button" className="ps-item is-link" title={`Open ${path}`} onClick={() => onOpenSourceLocation({ path })}>
                          <span className="ps-item-name">{name}</span>
                        </button>
                      ) : (
                        <span className="ps-item" title={artifact.path}><span className="ps-item-name">{name}</span></span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </SummaryDisclosure>
          )}
          {pane.tools.length > 0 && (
            <SummaryDisclosure label="Tools" count={pane.tools.length}>
              <ul className="ps-items">
                {pane.tools.map((tool, i) => (
                  <li key={i} className={tool.status === "failed" ? "ps-item is-failed" : "ps-item"} title={`${tool.title} · ${tool.status}`}>
                    <span className="ps-item-name">{tool.title}</span>
                  </li>
                ))}
              </ul>
            </SummaryDisclosure>
          )}
          {subagents.length > 0 && (
            <SummaryDisclosure label="Subagents" count={subagents.length}>
              <ul className="ps-items">
                {subagents.map((subagent) => (
                  <li key={subagent.id}>
                    <button
                      type="button"
                      className="ps-item is-link"
                      onClick={() => navigate({ name: "session", id: subagent.id })}
                      title={subagent.preview ?? subagent.title}
                    >
                      <AgentIcon driver={subagent.driver} agentName={subagent.agentName} size={14} />
                      <span className="ps-item-name">{subagent.title}</span>
                      {BUSY.includes(subagent.status) && <span className={`sdot sdot-${subagent.status}`} />}
                    </button>
                  </li>
                ))}
              </ul>
            </SummaryDisclosure>
          )}
        </SummarySection>
      )}
    </div>
  );
}

/** A plan step's state as a Lucide icon (§18), never a text glyph. */
function PlanStepIcon({ status }: { status: PlanEntry["status"] }): ReactNode {
  if (status === "completed") return <SuccessIcon className="ps-item-icon" size={14} aria-hidden="true" />;
  if (status === "in_progress") return <PlanInProgressIcon className="ps-item-icon" size={14} aria-hidden="true" />;
  return <PlanPendingIcon className="ps-item-icon" size={14} aria-hidden="true" />;
}

/**
 * The pull request's check rollup. Failing checks get the Codex "Fix" affordance: one click sends
 * the agent a prompt naming the failing checks. The row links to the pull request's checks tab.
 */
function ChecksRow({
  checks,
  session,
  canPrompt,
  kind,
}: {
  checks: GitChecksSummary;
  session: SessionView;
  canPrompt: boolean;
  kind?: "pull_request" | "merge_request";
}) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const fix = async () => {
    setBusy(true);
    try {
      await api.prompt(session.id, fixChecksPrompt(checks, kind), []);
      setSent(true);
    } catch {
      /* the composer surfaces prompt failures; this button stays quiet */
    } finally {
      setBusy(false);
    }
  };
  const value =
    checks.failing > 0
      ? `${checks.failing} failing`
      : checks.pending > 0
        ? `${checks.pending} running`
        : "Passing";
  const checksHref = safeExternalHref(checks.url);
  return (
    <div className="ps-checks">
      <SummaryRow
        icon={(
          <span
            className={checks.failing > 0 ? "ps-check-dot is-fail" : checks.pending > 0 ? "ps-check-dot is-pending" : "ps-check-dot is-pass"}
            aria-hidden="true"
          />
        )}
        label="Checks"
        value={value}
        href={checksHref}
        title={checksHref ? "Open the checks tab" : undefined}
      />
      {checks.failing > 0 && canPrompt && (
        <button type="button" className="btn ghost sm ps-fix" onClick={fix} disabled={busy || sent} title="Ask the agent to investigate and fix the failing checks">
          {sent ? "Sent" : busy ? <Spinner /> : "Fix"}
        </button>
      )}
    </div>
  );
}
