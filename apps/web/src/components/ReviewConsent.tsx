import { Checkbox } from "./ui/ChoiceControls.js";

/** "Deploy to 2 existing assignments": importing or accepting a new latest version (#1948). */
export function deployToAssignmentsConsent(assignmentCount: number): string {
  return `Deploy to ${assignmentCount} existing assignment${assignmentCount === 1 ? "" : "s"}`;
}

/** Restoring a version makes it the latest, which every unpinned machine then deploys. */
export const DEPLOY_TO_TRACKING_MACHINES_CONSENT = "Deploy to machines that track the latest version";

/** "Switch 3 agents to the latest version": a machine version policy that changes what runs there. */
export function switchAgentsConsent(agentCount: number | null, version: string): string {
  const agents = agentCount === null ? "this machine's agents" : `${agentCount} agent${agentCount === 1 ? "" : "s"}`;
  return `Switch ${agents} to ${version}`;
}

/**
 * The one consent a skill review asks for, pinned in the dialog footer beside the primary it
 * unlocks (#1948). Render it first in `Modal`'s `footer`: it takes the footer's left slot on
 * desktop and a full-width row above the two buttons on a phone sheet.
 *
 * Its label is a sentence naming what accepting deploys, computed by the dialog from its preview
 * with the helpers above (§8.4, §17.1: consent labels stay in sentence case). Render it only when
 * accepting changes something already deployed; otherwise there is nothing to agree to, and the
 * primary is enabled without it.
 */
export function ReviewConsent({ label, checked, disabled, onChange }: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return <Checkbox consent className="review-consent" label={label} checked={checked} disabled={disabled} onChange={onChange} />;
}
