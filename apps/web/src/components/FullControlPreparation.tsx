import { useId } from "react";
import type { CampaignControlMode, CampaignLaunchPreflight, CreateSessionRequest, FullControlLaunchRequest, SessionView } from "@wollipog/protocol";
import { ApiError, type ApiClient } from "../api.js";
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
 * the one start action, so there is nothing to fill in or review first. */
export function launchFullControlCampaign(api: ApiClient, request: CreateSessionRequest): Promise<SessionView> {
  const { runnerId, workspaceId, projectId, projectLocationId, agentId, providerAccountId, title, useWorktree, config, orchestrator } = request;
  if (!workspaceId) {
    return Promise.reject(new FullControlBlockedError("Full Control needs a registered workspace whose origin is on GitHub; choose one instead of a browsed folder."));
  }
  const launch: FullControlLaunchRequest = {
    runnerId, workspaceId, ...(projectId !== undefined ? { projectId } : {}), ...(projectLocationId !== undefined ? { projectLocationId } : {}),
    overrides: { session: { agentId, ...(providerAccountId ? { providerAccountId } : {}), ...(title ? { title } : {}),
      ...(useWorktree !== undefined ? { useWorktree } : {}), ...(config ? { config } : {}), ...(orchestrator ? { orchestrator } : {}) } },
  };
  // One identity for the whole action: a lost answer recovers the root it already started.
  const requestId = newRequestId();
  return withOneRefresh(async () => {
    const { preflight } = await api.fullControlLaunchPreflight(launch);
    const refusal = blocked(preflight);
    if (refusal) throw refusal;
    return api.createFullControlCampaign({ ...launch, requestId, preflightDigest: preflight.digest });
  });
}

/** Enable Full Control on a live root campaign: one action, the same server check. */
export function enableFullControlCampaign(api: ApiClient, sessionId: string): Promise<SessionView> {
  return withOneRefresh(async () => {
    const { preflight, expectedRevision } = await api.fullControlEnablePreflight(sessionId, {});
    const refusal = blocked(preflight);
    if (refusal) throw refusal;
    return api.enableFullControl(sessionId, { expectedRevision, preflightDigest: preflight.digest });
  });
}
