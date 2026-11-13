import { CampaignSection } from "./CampaignSections.js";
import { useId, useState } from "react";
import {
  CAMPAIGN_EVIDENCE_RETENTION_DISCLOSURE,
  type CampaignAuthorityBoundary,
  type CampaignLaunchCapability,
  type OrchestratorCampaignProjection,
} from "@wollipog/protocol";
import type { StatusTone } from "../status-meta.js";
import { formatRecordedTimestamp } from "../format.js";
import { fullControlReadiness, type CampaignAuthorityView, type ReadinessCampaign, type ReadinessFact } from "../full-control-readiness.js";
import { driverLabel } from "../usage-view-model.js";
import { operationLabel } from "./CampaignScopeGrant.js";
import { StatusBadge } from "./StatusBadge.js";

/** Objectives longer than this show a Show All control. */
export const OBJECTIVE_PREVIEW_CHARS = 280;

const CAPABILITY_STATE: Record<CampaignLaunchCapability["state"], { label: string; tone: StatusTone }> = {
  verified: { label: "Verified", tone: "success" },
  informational: { label: "Informational", tone: "info" },
  orchestrator_decides: { label: "Orchestrator Decides", tone: "neutral" },
  human_required: { label: "Human Required", tone: "warning" },
  unsupported: { label: "Unsupported", tone: "danger" },
};

/** Campaign Status's Full Control section (#2940): the boundary the owner authorized, what still
 * comes to them, and what the launch disclosed about capabilities and evidence. Full Control
 * launches with no preflight panel, so this section is where those facts are shown, after launch.
 * Everything here is read from the server's campaign projection; the objective is the owner's own
 * text and renders as plain text. */
export function CampaignAuthoritySummary({ campaign }: { campaign: CampaignAuthorityView }) {
  const control = campaign.control;
  if (control?.mode !== "full_control") return null;
  const boundary = control.boundary;
  const readiness = fullControlReadiness(campaign);
  return (
    <CampaignSection title="Full Control" count={boundary.operations.length} className="campaign-detail-section">
      <p className="section-note">{readiness.line}</p>
      <dl className="facts">
        <div><dt>Objective</dt><dd><ExpandableText text={boundary.objective} label="Objective" /></dd></div>
        <div><dt>Operations</dt><dd>{boundary.operations.length ? boundary.operations.map(operationLabel).join(", ") : "None"}</dd></div>
        {boundary.delegatablePolicyIds.length > 0 &&
          <div><dt>Delegated Policy Asks</dt><dd>{boundary.delegatablePolicyIds.join(", ")}</dd></div>}
        <IssueAuthorityFacts issues={boundary.issueAuthority} maxIssuesSource={campaign.maxIssuesSource} />
        <div><dt>Authorized Limits</dt><dd>{authorizedLimits(boundary.budgetAuthority)}</dd></div>
        <div>
          <dt>Authorized</dt>
          <dd>
            Revision {boundary.revision}
            <span className="campaign-status-meta"><Stamp at={boundary.authorizedAt} /></span>
          </dd>
        </div>
      </dl>
      <ReadinessFacts title="Human Required" facts={readiness.humanRequired}
        empty={readiness.state === "unknown" ? "Not Reported" : "None. Nothing in this campaign comes to you."} />
      {readiness.limited.length > 0 && <ReadinessFacts title="Limited Capabilities" facts={readiness.limited} empty="None" />}
      <LaunchCapabilities campaign={campaign} />
      <EvidenceFacts campaign={campaign} />
    </CampaignSection>
  );
}

/** The readiness line for surfaces outside Campaign Status (the Orchestrator Controls dialog, which
 * under Full Control shows only its mode, its line and its action): never the bare "end to end" line
 * when something still needs a person, and it names Campaign Status, where the facts are listed. */
export function FullControlReadinessNote({ campaign }: { campaign: ReadinessCampaign | undefined }) {
  return <p className="section-note">{fullControlReadiness(campaign).elsewhereLine}</p>;
}

function ReadinessFacts({ title, facts, empty }: { title: string; facts: ReadinessFact[]; empty: string }) {
  const headingId = useId();
  return (
    <section className="campaign-detail-section" aria-labelledby={headingId}>
      <h4 id={headingId} className="section-title">{title}</h4>
      {facts.length ? <dl className="facts">
        {facts.map((fact) => <div key={fact.key}><dt>{fact.label}</dt><dd>{fact.reason}</dd></div>)}
      </dl> : <p className="section-note">{empty}</p>}
    </section>
  );
}

function IssueAuthorityFacts({ issues, maxIssuesSource }: {
  issues: CampaignAuthorityBoundary["issueAuthority"];
  maxIssuesSource: OrchestratorCampaignProjection["maxIssuesSource"];
}) {
  if (!issues) return <div><dt>Issue Authority</dt><dd>None. Issue closure and scope changes come to you.</dd></div>;
  return <>
    <div>
      <dt>Maximum Issues</dt>
      <dd>
        {issues.maxIssues}
        {maxIssuesSource && <> <StatusBadge noDot label={maxIssuesSource === "explicit" ? "Set by You" : "Derived"} /></>}
      </dd>
    </div>
    <div><dt>Related Follow-Ups</dt><dd>{issues.relatedFollowUps ? "Allowed" : "Not Allowed"}</dd></div>
    <div><dt>Closure Reasons</dt><dd>{issues.closureReasons.length
      ? issues.closureReasons.map((reason) => reason === "completed" ? "Completed" : "Not Planned").join(", ") : "None"}</dd></div>
  </>;
}

function authorizedLimits(budget: CampaignAuthorityBoundary["budgetAuthority"]): string {
  if (!budget) return "None Recorded";
  return [
    budget.costUsd === undefined && budget.toolCalls === undefined ? "No cost or tool-call limit" : null,
    budget.costUsd === undefined ? null : `$${budget.costUsd.toFixed(2)}`,
    budget.toolCalls === undefined ? null : `${budget.toolCalls} tool calls`,
    `${budget.concurrency} concurrent workers`,
    `${budget.acceptedFollowUps} accepted follow-up${budget.acceptedFollowUps === 1 ? "" : "s"}`,
  ].filter(Boolean).join(", ");
}

/** What the launch or enable recorded about each capability. Verified ones are counted; every other
 * state is listed with its reason. A campaign authorized before the record existed says so. */
function LaunchCapabilities({ campaign }: { campaign: CampaignAuthorityView }) {
  const headingId = useId();
  const disclosure = campaign.launchDisclosure;
  const listed = disclosure?.capabilities.filter((item) => item.state !== "verified") ?? [];
  const verified = (disclosure?.capabilities.length ?? 0) - listed.length;
  return (
    <section className="campaign-detail-section" aria-labelledby={headingId}>
      <h4 id={headingId} className="section-title">Capabilities</h4>
      {disclosure ? <>
        <p className="section-note">
          As recorded when Full Control was {disclosure.source === "launch" ? "launched" : "enabled"},{" "}
          <Stamp at={disclosure.recordedAt} />. {verified} verified{listed.length ? "; the rest are listed here." : "."}
        </p>
        {listed.length > 0 && <dl className="facts">
          {listed.map((item) => {
            const state = CAPABILITY_STATE[item.state];
            return <div key={item.id}>
              <dt>{item.capability}</dt>
              <dd><StatusBadge noDot tone={state.tone} label={state.label} /> {item.reason}</dd>
            </div>;
          })}
        </dl>}
      </> : <dl className="facts">
        <div><dt>Recorded</dt><dd>Not Recorded<span className="campaign-status-meta">This campaign was authorized before Wollipog recorded its capabilities.</span></dd></div>
      </dl>}
    </section>
  );
}

/** Where evidence goes, who reviews it, and what the Orchestrator can review right now. */
function EvidenceFacts({ campaign }: { campaign: CampaignAuthorityView }) {
  const headingId = useId();
  const evidence = campaign.launchDisclosure?.evidence;
  const provider = evidence?.provider;
  const screenshots = campaign.uiEvidenceReview;
  const reviewsImages = campaign.decisionOwners.ui_evidence_approval === "orchestrator" && screenshots.status === "available";
  return (
    <section className="campaign-detail-section" aria-labelledby={headingId}>
      <h4 id={headingId} className="section-title">Evidence</h4>
      <dl className="facts">
        <div><dt>Destination</dt><dd>{evidence ? "Private Session Artifacts" : "Not Recorded"}</dd></div>
        <div><dt>Screenshot Reviewer</dt><dd>{!evidence ? "Not Recorded" : provider
          ? `${driverLabel(provider.reviewer.driver)}${provider.reviewer.model ? ` · ${provider.reviewer.model}` : ""}`
          : "None. The Orchestrator reviews no images."}</dd></div>
        {evidence && <div><dt>Evidence Handling</dt><dd>{evidence.statement}</dd></div>}
        {(provider || reviewsImages) && <div><dt>Provider Retention</dt><dd>{provider?.retentionDisclosure ?? CAMPAIGN_EVIDENCE_RETENTION_DISCLOSURE}</dd></div>}
        <div>
          <dt>Screenshot Review</dt>
          <dd>{screenshots.status === "available" ? screenshots.effectiveOwner === "orchestrator" ? "Available" : "Comes to You"
            : screenshots.reason ?? "Unavailable"}</dd>
        </div>
        <div>
          <dt>Video Review</dt>
          <dd>{campaign.videoEvidenceReview
            ? <>{campaign.videoEvidenceReview.status === "available" ? "Available" : "Unavailable"}
              <span className="campaign-status-meta">{campaign.videoEvidenceReview.reason}</span></>
            : "Not Reported"}</dd>
        </div>
      </dl>
    </section>
  );
}

/** A recorded moment as a `<time>` element. */
function Stamp({ at }: { at: number }) {
  const stamp = formatRecordedTimestamp(at);
  return stamp ? <time dateTime={stamp.dateTime} title={stamp.title}>{stamp.label}</time> : <>Time Not Recorded</>;
}

/** Long untrusted text with a Show All control; short text renders whole. */
function ExpandableText({ text, label }: { text: string; label: string }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  if (text.length <= OBJECTIVE_PREVIEW_CHARS) return <>{text}</>;
  return <>
    <span id={id}>{expanded ? text : `${text.slice(0, OBJECTIVE_PREVIEW_CHARS).trimEnd()}…`}</span>{" "}
    <button className="btn ghost sm" type="button" aria-expanded={expanded} aria-controls={id}
      aria-label={expanded ? `Show Less of the ${label}` : `Show All of the ${label}`}
      onClick={() => setExpanded((current) => !current)}>{expanded ? "Show Less" : "Show All"}</button>
  </>;
}
