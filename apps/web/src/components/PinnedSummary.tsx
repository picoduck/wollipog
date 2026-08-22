import { useMemo, useState, type ReactNode } from "react";
import { isPolicyApproval, isTerminal, normalizeSourcePath, type GitChecksSummary, type PlanEntry, type SessionView, type SourceLocation } from "@wollipog/protocol";
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
  remoteHttpUrl,
  sourceKind,
  type GitPresentation,
} from "../pinned-summary.js";
import type { GitStatus, GitSummary } from "./useGitStatus.js";
import { GitPinnedSection } from "./GitVisibility.js";
import { AgentIcon } from "./AgentIcon.js";
import { BranchIcon, ComputerIcon, DialIcon, FolderOutlineIcon, GitHubIcon, GlobeIcon, NotesIcon, PullRequestIcon, TuningIcon } from "./Icons.js";
import { BackgroundDeliveryBadge, BackgroundNotificationBadge, BackgroundWorkBadge, Spinner, StatusBadge, UntrackedBackgroundWorkBadge } from "./common.js";
import { effortLabel, relativeTime, resolvedModelLabel } from "../format.js";
import { effectiveModelEffortForDisplay, resolveCaps, resolveEffectiveCaps } from "../caps.js";
import { sessionAgentLabel } from "./agent-options.js";
import { safeExternalHref } from "../external-href.js";

const BUSY = ["queued", "starting", "running", "input_required"];

/**
 * Codex-style pinned summary: a floating card over the session view's top-right with the
 * environment at a glance — changes, host, branch, commit/push entry into Review, run
 * subagents, and the agent's Plan/Files/Tools rollups (collapsed by default). Toggled from
 * the topbar; open state persists app-wide (wollipog.pinned.open, default open).
 */

export function PinnedSummary({
  session,
  git,
  gitSummary,
  gitPresentation,
  richGitSupported,
  items,
  onOpenReview,
  onOpenSourceLocation,
}: {
  session: SessionView;
  git: GitStatus;
  gitSummary: GitSummary;
  gitPresentation: GitPresentation;
  richGitSupported: boolean;
  items: TimelineItem[];
  onOpenReview: () => void;
  onOpenSourceLocation: (location: SourceLocation) => void;
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

  const host = deriveHost(session, runners.get(session.runnerId), boxes.values());
  const richFactsVisible = gitPresentation.state !== "offline" &&
    gitPresentation.state !== "loading" &&
    gitPresentation.state !== "unavailable" &&
    gitPresentation.state !== "not_repository";
  const displayedFacts = richGitSupported
    ? richFactsVisible ? gitPresentation.facts : null
    : summary ?? git.status;
  // Review mutations remain linked-worktree-only even though v76 allows read-only facts for a
  // primary checkout. Never render a button that can only open Review's unavailable state.
  const reviewFacts = session.worktreePath ? displayedFacts : null;
  const changes = deriveChanges(reviewFacts, git.status?.files.length);
  const commitAction = deriveCommitAction(reviewFacts);
  const subagents = deriveSubagents(session, runs, sessions);
  const forgeFactsVisible = !richGitSupported || gitPresentation.state !== "not_repository";
  const remoteUrl = forgeFactsVisible ? summary?.remoteUrl ?? displayedFacts?.remoteUrl : null;
  const source = sourceKind(remoteUrl);
  const sourceUrl = remoteHttpUrl(remoteUrl);
  const pane = useMemo(() => deriveSidePaneContent(items), [items]);
  const branch = summary?.branch ?? git.status?.branch ?? (session.worktreePath ? `agent/${session.id}` : null);
  const pr = forgeFactsVisible ? summary?.pr ?? null : null;
  const checks = forgeFactsVisible ? summary?.checks ?? null : null;
  const prHref = safeExternalHref(pr?.url);
  const canPrompt = runnerOnline && !isTerminal(session.status) && !isPolicyApproval(session.pendingApproval);
  const refreshGit = async () => {
    await Promise.all([git.refreshStatusOnly(), gitSummary.refresh()]);
  };

  return (
    <aside className="pinned-summary" aria-label="Pinned Summary">
      {/* Canonical home for the session facts the unified bar no longer carries: full status
          label + freshness, then the agent identity with its model and effort. */}
      <div className="ps-section">
        <div className="ps-section-head">
          <span>Session</span>
        </div>
        <div className="ps-row is-static">
          <StatusBadge status={session.status} />
          <span className="ps-right ps-detail">Updated {relativeTime(session.updatedAt)}</span>
        </div>
        <div className="ps-row is-static">
          <AgentIcon driver={session.driver} agentName={session.agentName} size={13} />
          <span>{sessionAgentLabel(session.agentName, session.driver, session.agentId)}</span>
          {(session.resolvedModel || effectiveModel || effectiveEffort) && (
            <span className="ps-right ps-detail" title={session.resolvedModel ?? undefined}>
              {[
                session.resolvedModel ? resolvedModelLabel(session.resolvedModel) : (effectiveModel?.displayName ?? effectiveModel?.id),
                effectiveEffort ? effortLabel(effectiveEffort) : undefined,
              ].filter(Boolean).join(" · ")}
            </span>
          )}
        </div>
        {session.backgroundWorkState && (
          <div className="ps-row is-static">
            <BackgroundWorkBadge state={session.backgroundWorkState} />
          </div>
        )}
        {!session.backgroundWorkState && session.backgroundWorkTracking === "untracked" && (
          <div className="ps-row is-static">
            <UntrackedBackgroundWorkBadge />
          </div>
        )}
        {session.backgroundDeliveries?.find((delivery) => delivery.watchdogState)?.watchdogState && (
          <div className="ps-row is-static">
            <BackgroundDeliveryBadge
              state={session.backgroundDeliveries.find((delivery) => delivery.watchdogState)!.watchdogState!}
            />
          </div>
        )}
        {session.backgroundDeliveries?.flatMap((delivery) => delivery.notifications ?? []).slice(-2).map((receipt) => (
          <div className="ps-row is-static" key={receipt.deliveryId}>
            <BackgroundNotificationBadge state={receipt.state} />
          </div>
        ))}
      </div>
      <div className="ps-section">
        <div className="ps-section-head">
          <span>Environment</span>
          {/* Reserved: environment configuration (Codex's +). Enabled in a later phase. */}
          <button type="button" className="icon-btn ps-plus" disabled title="Environment setup — coming soon">
            +
          </button>
        </div>

        {changes && (
          <button type="button" className="ps-row" onClick={onOpenReview} title="Open Review">
            <NotesIcon className="ps-icon" size={14} />
            <span>Changes</span>
            <span className="ps-right">
              {changes.kind === "lines" ? (
                <>
                  <span className="ps-add">+{changes.added.toLocaleString()}</span>{" "}
                  <span className="ps-del">-{changes.deleted.toLocaleString()}</span>
                </>
              ) : (
                // Untracked-only / binary / pre-v20 dirty trees: numstat can't count lines.
                <span className="ps-detail">
                  {changes.count != null ? `${changes.count} file${changes.count === 1 ? "" : "s"}` : "changed"}
                </span>
              )}
            </span>
          </button>
        )}

        <div className="ps-row is-static" title={host.detail ?? undefined}>
          {host.kind === "remote"
            ? <GlobeIcon className="ps-icon" size={14} />
            : <ComputerIcon className="ps-icon" size={14} />}
          <span>{host.label}</span>
          {host.detail && <span className="ps-right ps-detail">{host.detail}</span>}
        </div>

        {/* The Workspace is the directory-on-machine fact — environment, not identity. */}
        {session.workspaceName && (
          <div className="ps-row is-static">
            <FolderOutlineIcon className="ps-icon" size={14} />
            <span>Workspace</span>
            <span className="ps-right ps-detail">{session.workspaceName}</span>
          </div>
        )}

        {!richGitSupported && branch && (
          <div className="ps-row is-static" title={session.worktreePath ?? undefined}>
            <BranchIcon className="ps-icon" size={14} />
            <span className="ps-branch">{branch}</span>
          </div>
        )}

        {commitAction && commitAction !== "up_to_date" && (
          <button type="button" className="ps-row" onClick={onOpenReview} title="Open Review">
            <DialIcon className="ps-icon" size={14} />
            <span>{COMMIT_ACTION_LABELS[commitAction]}</span>
          </button>
        )}

        {pr && prHref && (
          <a className="ps-row ps-source" href={prHref} target="_blank" rel="noreferrer" title={`#${pr.number} · ${pr.state}`}>
            <PullRequestIcon className="ps-icon" size={14} />
            <span className="ps-sub-title">{pr.title || `PR #${pr.number}`}</span>
          </a>
        )}

        {checks && <ChecksRow checks={checks} session={session} canPrompt={canPrompt} />}
      </div>

      {richGitSupported && (
        <GitPinnedSection model={gitPresentation} onRefresh={refreshGit} />
      )}

      {subagents.length > 0 && (
        <div className="ps-section">
          <div className="ps-section-head">Subagents</div>
          {subagents.map((s) => (
            <button
              key={s.id}
              type="button"
              className="ps-row"
              onClick={() => navigate({ name: "session", id: s.id })}
              title={s.preview ?? s.title}
            >
              <AgentIcon driver={s.driver} agentName={s.agentName} size={13} />
              <span className="ps-sub-title">{s.title}</span>
              {BUSY.includes(s.status) && <span className={`sdot sdot-${s.status} ps-right`} />}
            </button>
          ))}
        </div>
      )}

      {(pane.plan.length > 0 || pane.artifacts.length > 0 || pane.tools.length > 0) && (
        <div className="ps-section">
          {pane.plan.length > 0 && (
            <PsAccordion title="Plan" count={pane.plan.length}>
              {pane.plan.map((e, i) => (
                <div key={i} className={`plan-row plan-${e.status}`}>
                  <span className="plan-icon">{PLAN_ICON[e.status] ?? "○"}</span>
                  <span className="plan-text">{e.content}</span>
                </div>
              ))}
            </PsAccordion>
          )}
          {pane.artifacts.length > 0 && (
            <PsAccordion title="Files" count={pane.artifacts.length}>
              {pane.artifacts.map((a, i) => {
                const path = normalizeSourcePath(a.path);
                const name = a.path.split(/[/\\]/).pop() || a.path;
                return path ? (
                  <button key={i} type="button" className="artifact-row source-path-link" title={`Open ${path}`} onClick={() => onOpenSourceLocation({ path })}>
                    <span className="artifact-name">{name}</span>
                  </button>
                ) : (
                  <div key={i} className="artifact-row" title={a.path}><span className="artifact-name">{name}</span></div>
                );
              })}
            </PsAccordion>
          )}
          {pane.tools.length > 0 && (
            <PsAccordion title="Tools" count={pane.tools.length}>
              {pane.tools.map((t, i) => (
                <div key={i} className={`tool-row tool-${t.status}`} title={`${t.title} · ${t.status}`}>
                  <span className="tool-title">{t.title}</span>
                </div>
              ))}
            </PsAccordion>
          )}
        </div>
      )}

      {source && (
        <div className="ps-section">
          <div className="ps-section-head">Sources</div>
          {sourceUrl ? (
            <a className="ps-row ps-source" href={sourceUrl} target="_blank" rel="noreferrer" title={sourceUrl}>
              <SourceIcon kind={source} />
              <span>{source === "github" ? "GitHub" : "Git remote"}</span>
            </a>
          ) : (
            <div className="ps-row is-static">
              <SourceIcon kind={source} />
              <span>{source === "github" ? "GitHub" : "Git remote"}</span>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}

const PLAN_ICON: Record<PlanEntry["status"], string> = { pending: "○", in_progress: "◐", completed: "●" };

/**
 * PR check rollup row. Failing checks get the Codex "Fix" affordance: one click sends the
 * agent a prompt naming the failing checks. The row itself links to the PR's checks tab.
 */
function ChecksRow({
  checks,
  session,
  canPrompt,
}: {
  checks: GitChecksSummary;
  session: SessionView;
  canPrompt: boolean;
}) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const fix = async () => {
    setBusy(true);
    try {
      await api.prompt(session.id, fixChecksPrompt(checks), []);
      setSent(true);
    } catch {
      /* the composer surfaces prompt failures; this button stays quiet */
    } finally {
      setBusy(false);
    }
  };
  const label =
    checks.failing > 0
      ? `${checks.failing} failing check${checks.failing === 1 ? "" : "s"}`
      : checks.pending > 0
        ? `${checks.pending} running check${checks.pending === 1 ? "" : "s"}`
        : "Checks passing";
  const dotClass = checks.failing > 0 ? "is-fail" : checks.pending > 0 ? "is-pending" : "is-pass";
  const checksHref = safeExternalHref(checks.url);
  const body = (
    <>
      <span className={`ps-check-dot ${dotClass}`} aria-hidden="true" />
      <span>{label}</span>
    </>
  );
  return (
    <div className="ps-row is-static ps-checks">
      {checksHref ? (
        <a className="ps-checks-link" href={checksHref} target="_blank" rel="noreferrer" title="Open the checks tab">
          {body}
        </a>
      ) : (
        body
      )}
      {checks.failing > 0 && canPrompt && (
        <button type="button" className="btn ghost sm ps-right ps-fix" onClick={fix} disabled={busy || sent} title="Ask the agent to investigate and fix the failing checks">
          {sent ? "Sent" : busy ? <Spinner /> : "Fix"}
        </button>
      )}
    </div>
  );
}


function SourceIcon({ kind }: { kind: "github" | "git" }) {
  if (kind === "github") {
    return (
      <GitHubIcon className="ps-icon" size={14} />
    );
  }
  return (
    <TuningIcon className="ps-icon" size={14} />
  );
}

/** Collapsed-by-default rollup rows (Plan / Files / Tools) — the old SidePane cards, folded in. */
function PsAccordion({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ps-accordion">
      <button type="button" className="ps-row ps-accordion-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="chev">{open ? "▾" : "▸"}</span>
        <span>{title}</span>
        <span className="ps-right ps-count">{count}</span>
      </button>
      {open && <div className="ps-accordion-body">{children}</div>}
    </div>
  );
}
