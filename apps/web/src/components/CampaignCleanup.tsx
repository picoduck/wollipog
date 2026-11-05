import React, { useId, useState, type ReactNode } from "react";
import type { CampaignCleanupItem, CampaignStuckItem, OrchestratorCampaignProjection } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { issueRefLabel } from "../campaign-status.js";
import { CopyButton } from "./common.js";
import { Notice } from "./Notice.js";
import { BusyButton } from "./ui/BusyButton.js";

/**
 * Campaign Status's Cleanup and Campaign Stuck sections (#4146). Cleanup lists the housekeeping a
 * delivered campaign still owes, each item with its reason and the exact action that settles it:
 * **Delete Merged Branches** where Wollipog holds an approved deletion it can perform, otherwise the
 * exact command, or what Wollipog is already doing about it. Handed-off work items keep their own
 * Handed Off section; Cleanup only counts them. Campaign Stuck names the undelivered work behind the
 * status and why nothing is moving.
 */

/** What settles one cleanup item, in words or as a command a person can copy. */
function CleanupAction({ action, subject }: { action: CampaignCleanupItem["action"]; subject: string }) {
  switch (action.kind) {
    case "delete_merged_branches":
      return <>Wollipog can delete it with its approved deletion: choose <strong>Delete Merged Branches</strong>.</>;
    case "command":
      return <>
        <code>{action.command}</code>
        <span className="campaign-status-meta">
          <CopyButton text={action.command} label="Copy Command" ariaLabel={`Copy Command for ${subject}`} className="btn ghost sm" />
        </span>
      </>;
    case "automatic":
      return <>{action.text}<span className="campaign-status-meta">Nothing is needed from you.</span></>;
    case "person":
      return <>{action.text}</>;
  }
}

function cleanupSubject(item: Exclude<CampaignCleanupItem, { kind: "handoff" }>): string {
  return item.kind === "merged_branch" ? item.branch ?? `the branch of ${item.repository}#${item.pullRequest}` : item.path;
}

export function CampaignCleanup({ campaignId, cleanup, canAct, onOpenSession }: {
  campaignId: string;
  cleanup: NonNullable<OrchestratorCampaignProjection["cleanup"]>;
  /** Whether this view may ask Wollipog to perform approved deletions: the campaign's own view. */
  canAct: boolean;
  onOpenSession: (sessionId: string) => ReactNode;
}) {
  const api = useApi();
  const headingId = useId();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const items = cleanup.items.filter((item): item is Exclude<CampaignCleanupItem, { kind: "handoff" }> => item.kind !== "handoff");
  const handoffs = cleanup.items.length - items.length;
  const hidden = cleanup.total - cleanup.items.length;
  const performable = items.some((item) => item.action.kind === "delete_merged_branches");
  const deleteBranches = async () => {
    if (busy) return;
    setBusy(true); setOutcome(null);
    try {
      const result = await api.deleteCampaignMergedBranches(campaignId);
      setOutcome(result.refused === 0
        ? { tone: "success", text: `Deleted ${result.performed} merged branch${result.performed === 1 ? "" : "es"}.` }
        : { tone: "danger", text: `Deleted ${result.performed}; ${result.refused} could not be deleted. Each keeps its reason below.` });
    } catch (cause) {
      setOutcome({ tone: "danger", text: cause instanceof Error ? cause.message : "Could not delete the merged branches." });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="campaign-status-handoffs" aria-labelledby={headingId}>
      <h3 id={headingId} className="section-title">Cleanup</h3>
      <p className="section-note">
        The campaign's work is delivered. {cleanup.total === 1 ? "This item is" : "These items are"} left; each says why and
        what settles it.
      </p>
      {items.length > 0 && <ul className="campaign-detail-list">
        {items.map((item) => (
          <li key={item.kind === "merged_branch" ? `${item.repository}#${item.pullRequest}` : `${item.sessionId}:${item.path}`}>
            <dl className="facts">
              {item.kind === "merged_branch" ? (
                <div>
                  <dt>Merged Branch</dt>
                  <dd>
                    {item.branch ? <code>{item.branch}</code> : "Not Read Yet"}
                    <span className="campaign-status-meta">
                      {issueRefLabel({ repository: item.repository, number: item.pullRequest }, "pull")}
                      {item.state === "retained" ? " · Retained" : ""}
                    </span>
                  </dd>
                </div>
              ) : (
                <div>
                  <dt>Worktree</dt>
                  <dd>
                    <code>{item.path}</code>
                    <span className="campaign-status-meta">{onOpenSession(item.sessionId)}</span>
                  </dd>
                </div>
              )}
              <div><dt>Reason</dt><dd>{item.reason}</dd></div>
              <div><dt>Action</dt><dd><CleanupAction action={item.action} subject={cleanupSubject(item)} /></dd></div>
            </dl>
          </li>
        ))}
      </ul>}
      {handoffs > 0 && <p className="section-note">
        {handoffs} handed-off item{handoffs === 1 ? " is" : "s are"} listed under Handed Off.
      </p>}
      {hidden > 0 && <p className="section-note">{hidden} more item{hidden === 1 ? " is" : "s are"} listed through the campaign tools.</p>}
      {outcome && <Notice tone={outcome.tone} role={outcome.tone === "danger" ? "alert" : "status"}
        title={outcome.tone === "success" ? "Merged Branches Deleted" : "Some Branches Remain"}>{outcome.text}</Notice>}
      {performable && canAct && <div>
        <BusyButton className="btn sm" busy={busy} progress="Deleting merged branches…" onClick={() => void deleteBranches()}>
          Delete Merged Branches
        </BusyButton>
      </div>}
    </section>
  );
}

const STUCK_LABELS: Record<CampaignStuckItem["kind"], string> = {
  unverified_child: "Unverified Child",
  orchestrator_request: "Orchestrator Request",
  work_item: "Work Item",
  scope: "Scoped Work",
  continuation: "Continuation",
};

export function CampaignStuck({ stuck, repair, onOpenSession }: {
  stuck: NonNullable<OrchestratorCampaignProjection["stuck"]>;
  repair: NonNullable<OrchestratorCampaignProjection["activity"]>["repair"];
  onOpenSession: (sessionId: string) => ReactNode;
}) {
  const headingId = useId();
  const hidden = stuck.total - stuck.items.length;
  const tried = repair?.state === "attempted"
    ? repair.continuation ? " Wollipog re-read the forge and woke the Orchestrator once; nothing changed." : " Wollipog re-read the forge; nothing changed."
    : "";
  return (
    <section className="campaign-status-handoffs" aria-labelledby={headingId}>
      <h3 id={headingId} className="section-title">Campaign Stuck</h3>
      <p className="section-note">
        Nothing is running and nothing is scheduled to move this campaign.{tried} {stuck.total === 1 ? "This is" : "These are"} still
        unfinished.
      </p>
      <ul className="campaign-detail-list">
        {stuck.items.map((item, index) => (
          <li key={`${item.kind}:${index}`}>
            <dl className="facts">
              <div>
                <dt>{STUCK_LABELS[item.kind]}</dt>
                <dd>
                  {item.kind === "unverified_child" || item.kind === "orchestrator_request" ? onOpenSession(item.sessionId)
                    : item.kind === "work_item" ? (item.issue ? issueRefLabel(item.issue) : "A committed work item")
                    : item.kind === "continuation" ? (item.state === "failed" ? "Failed" : item.state === "held" ? "Held" : "Result Lost")
                    : "Issues in Scope"}
                  <span className="campaign-status-meta">{item.reason}</span>
                </dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
      {hidden > 0 && <p className="section-note">{hidden} more item{hidden === 1 ? " is" : "s are"} listed through the campaign tools.</p>}
    </section>
  );
}

