import { useId } from "react";
import type { CampaignControlMode, CampaignExcludedLocation, CampaignLaunchPreflight, CampaignLimitedLocation, CreateSessionRequest, FullControlLaunchRequest, SessionView } from "@wollipog/protocol";
import { ApiError, type ApiClient } from "../api.js";
import { Notice } from "./Notice.js";
import { ChoiceRows, SegmentedControl } from "./ui/ChoiceControls.js";

/** A future preference only; the selected option cannot authorize a campaign. */
export function FullControlModeChoice({ mode, onChange, disabled = false, preferenceSupported = false }: {
  mode: CampaignControlMode; onChange: (mode: CampaignControlMode) => void;
  disabled?: boolean; preferenceSupported?: boolean;
}) {
  return <span className="setting-row-control"><SegmentedControl<CampaignControlMode> className="sm"
    label="Orchestrator Control" value={mode} onChange={onChange}
    options={[
      { value: "custom", label: "Custom", description: "Choose individual workflow owners. Defaults apply only to new campaigns.", disabled },
      { value: "full_control", label: "Full Control", description: preferenceSupported
        ? "Prefer Full Control for new campaigns; each still needs your authorization."
        : "This version cannot save the preference.", disabled },
    ]} /></span>;
}

/** The active-campaign choice. Choosing Full Control changes nothing until Enable Full Control. */
export function OrchestratorControlChoice({ mode, onChange, disabled = false, embedded = false }: {
  mode: CampaignControlMode; onChange: (mode: CampaignControlMode) => void; disabled?: boolean;
  /** Rendered inside a section that already carries the Orchestrator Control heading. */
  embedded?: boolean;
}) {
  const id = useId();
  const rows = <ChoiceRows<CampaignControlMode> label="Orchestrator Control" value={mode} onChange={onChange}
      options={[
        { value: "custom", title: "Custom", description: "Choose individual request and workflow decision owners.", disabled, inputData: { "data-control-mode": "custom" } },
        { value: "full_control", title: "Full Control", description: "The Orchestrator runs this campaign end to end.", disabled, inputData: { "data-control-mode": "full_control" } },
      ]} />;
  if (embedded) return rows;
  return <section className="section" aria-labelledby={`${id}-title`}>
    <h3 className="section-title" id={`${id}-title`}>Orchestrator Control</h3>
    {rows}
  </section>;
}

const DECIMAL = /^(?:\d+(?:\.\d*)?|\.\d+)$/, WHOLE = /^\d+$/;

/** The number a limit field's typed text states, or null when it is not plain digits. Limit fields
 * are text entries, so this reads exactly what the person sees; there is no hidden browser state. */
export function readLimitText(text: string, kind: "decimal" | "whole"): number | null {
  const trimmed = text.trim();
  return (kind === "decimal" ? DECIMAL : WHOLE).test(trimmed) ? Number(trimmed) : null;
}

/** Only a genuine impossibility stops Full Control, and it says why in one sentence per reason. */
export class FullControlBlockedError extends Error {}

function blocked(preflight: CampaignLaunchPreflight): FullControlBlockedError | null {
  const ready = preflight.ready && preflight.capabilities.every((item) => !item.mandatory || item.state === "verified");
  return ready ? null : new FullControlBlockedError(preflight.summary.blockers.map((item) => item.reason).join(" ") ||
    "Full Control can't run on this machine.");
}

/** What a person must see before they authorize a boundary (#4319): the Locations left out because
 * their runner can't perform the campaign's gates, and a launch Location limited for the same reason.
 * Nothing is asked of them and neither blocks a start, but they approve this boundary knowing it. A
 * campaign whose runners are all current has none, and starts exactly as before. */
export interface FullControlLocationReport {
  excluded: CampaignExcludedLocation[];
  limited: CampaignLimitedLocation[];
}

export function fullControlLocationReport(preflight: Pick<CampaignLaunchPreflight, "summary">): FullControlLocationReport | null {
  const excluded = (preflight.summary.excludedLocations ?? []).filter((item) => item.failure === "runner_below_gates");
  const limited = preflight.summary.limitedLocations ?? [];
  return excluded.length || limited.length ? { excluded, limited } : null;
}

/** Everything a row shows: a changed name or repository stops Start again too. */
const reportKey = (report: FullControlLocationReport | null) => report
  ? JSON.stringify([report.excluded.map((item) => [item.locationId, item.name, item.repository ?? null, item.reason]).sort(),
    report.limited.map((item) => [item.locationId, item.name, item.reason]).sort()]) : null;

/** The check found something the person hasn't been shown: show it, and let the next action proceed. */
export class FullControlLocationsToReview extends Error {
  constructor(readonly report: FullControlLocationReport) { super("Review the Locations this campaign leaves out."); }
}

function requireShown(preflight: CampaignLaunchPreflight, shown: FullControlLocationReport | null): void {
  const report = fullControlLocationReport(preflight);
  if (report && reportKey(report) !== reportKey(shown)) throw new FullControlLocationsToReview(report);
}

/** The report in the form the person reads it, in the dialog that authorizes the boundary. */
export function FullControlLocationNotices({ report }: { report: FullControlLocationReport | null }) {
  if (!report) return null;
  const row = (location: { locationId: string; name: string; reason: string; repository?: string }) => <li key={location.locationId}>
    {location.name}
    {location.repository && <span className="campaign-status-meta">{location.repository}</span>}
    <span className="campaign-status-meta">{location.reason}</span>
  </li>;
  return <>
    {report.excluded.length > 0 && <Notice tone="warning" role="status" title="Excluded Locations">
      <p>{report.excluded.length === 1 ? "Full Control starts without this Location. It can join once its runner updates."
        : "Full Control starts without these Locations. Each can join once its runner updates."}</p>
      <ul className="campaign-detail-list" aria-label="Excluded Locations">{report.excluded.map(row)}</ul>
    </Notice>}
    {report.limited.length > 0 && <Notice tone="warning" role="status" title="Limited Locations">
      <p>Full Control starts here, with one limit.</p>
      <ul className="campaign-detail-list" aria-label="Limited Locations">{report.limited.map(row)}</ul>
    </Notice>}
  </>;
}

/** How a Full Control launch takes its issues: the owner's first message names them, and the server
 * checks each against those exact words. A bare number means the launch repository; another of the
 * campaign's repositories needs its issue written qualified, so the dialog says so before Start. */
export function FullControlFirstMessageNotice() {
  return <Notice tone="info" title="Name Issues in Your First Message">
    <p>When the session opens, your first message sets the campaign's task and issues. Write <code>#12</code> for
      an issue in this repository. For another repository in the campaign, write <code>owner/repo#12</code> or
      paste the issue's link, because a bare number always means this repository.</p>
  </Notice>;
}

function newRequestId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Runs `attempt` once more when the server's facts moved between its check and the action, as a
 * runner reconnect or a saved default can. Any other refusal is the server's own sentence. */
async function withOneRefresh<T>(attempt: () => Promise<T>): Promise<T> {
  const refused = (cause: unknown) => cause instanceof ApiError && cause.status === 409
    ? new FullControlBlockedError(cause.message.replace(/^Full Control (?:launch is blocked|cannot be enabled): /u, "")) : cause;
  try { return await attempt(); } catch (cause) {
    if (!(cause instanceof ApiError && cause.status === 409 && /changed; refresh/u.test(cause.message))) throw refused(cause);
    try { return await attempt(); } catch (again) { throw refused(again); }
  }
}

/** New Session's Start under Full Control (#2940): the same launch as a Custom Orchestrator. The
 * server derives the repository, budget and settings; the campaign starts idle, and the person's
 * first message in it is the task and the issue scope. The server's own check is authorized as
 * the one start action, so there is nothing to fill in. It stops only to show Locations the person
 * hasn't been shown yet (#4319): `shown` is what the dialog is already showing them. */
export function launchFullControlCampaign(api: ApiClient, request: CreateSessionRequest,
  shown: FullControlLocationReport | null = null): Promise<SessionView> {
  const launch = fullControlLaunchRequest(request);
  if (!launch) {
    return Promise.reject(new FullControlBlockedError("Full Control needs a registered workspace whose origin is on GitHub; choose one instead of a browsed folder."));
  }
  // One identity for the whole action: a lost answer recovers the root it already started.
  const requestId = newRequestId();
  return withOneRefresh(async () => {
    const { preflight } = await api.fullControlLaunchPreflight(launch);
    const refusal = blocked(preflight);
    if (refusal) throw refusal;
    requireShown(preflight, shown);
    return api.createFullControlCampaign({ ...launch, requestId, preflightDigest: preflight.digest });
  });
}

/** What the server's check and the launch are asked, or null with no registered workspace. */
function fullControlLaunchRequest(request: CreateSessionRequest): FullControlLaunchRequest | null {
  // Run On and Harness travel with the root, so the server honors or refuses them rather than
  // starting on the host default. ACP session context is never sent: only ACP agents carry it, and
  // the server refuses an ACP root for Full Control on its own.
  const { runnerId, workspaceId, projectId, projectLocationId, agentId, providerAccountId, title, useWorktree, executionTargetId,
    launchSurface, config, orchestrator } = request;
  if (!workspaceId) return null;
  return {
    runnerId, workspaceId, ...(projectId !== undefined ? { projectId } : {}), ...(projectLocationId !== undefined ? { projectLocationId } : {}),
    overrides: { session: { agentId, ...(providerAccountId ? { providerAccountId } : {}), ...(title ? { title } : {}),
      ...(useWorktree !== undefined ? { useWorktree } : {}), ...(executionTargetId ? { executionTargetId } : {}),
      ...(launchSurface ? { launchSurface } : {}), ...(config ? { config } : {}), ...(orchestrator ? { orchestrator } : {}) } },
  };
}

/** The same server check, read ahead of Start so the person sees its Locations first. It authorizes
 * nothing, and any failure says nothing: Start runs the check again and reports what it finds. */
export async function checkFullControlLocations(api: ApiClient, request: CreateSessionRequest, signal: AbortSignal): Promise<FullControlLocationReport | null> {
  const launch = fullControlLaunchRequest(request);
  if (!launch) return null;
  const { preflight } = await api.fullControlLaunchPreflight(launch, signal);
  return fullControlLocationReport(preflight);
}

/** Enable Full Control on a live root campaign: one action, the same server check, stopping only to
 * show Locations the person hasn't been shown yet (#4319). */
export function enableFullControlCampaign(api: ApiClient, sessionId: string,
  shown: FullControlLocationReport | null = null): Promise<SessionView> {
  return withOneRefresh(async () => {
    const { preflight, expectedRevision } = await api.fullControlEnablePreflight(sessionId, {});
    const refusal = blocked(preflight);
    if (refusal) throw refusal;
    requireShown(preflight, shown);
    return api.enableFullControl(sessionId, { expectedRevision, preflightDigest: preflight.digest });
  });
}
