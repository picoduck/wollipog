import { useId } from "react";
import type { CampaignControlMode } from "@wollipog/protocol";
import { fullControlPreflight, type FullControlPreparation as PreparationInput } from "../full-control-preflight.js";
import { ChoiceRows } from "./ui/ChoiceControls.js";
import { Notice } from "./Notice.js";

/** Preparation-only mode selection. It cannot call a mutation, mint authorization, or mark a
 * campaign ready. Parent surfaces fence Save/Create while the unsupported mode is selected. */
export function FullControlPreparation({ mode, onChange, disabled = false, preferenceSupported = false, ...input }: PreparationInput & {
  mode: CampaignControlMode; onChange: (mode: CampaignControlMode) => void; disabled?: boolean; preferenceSupported?: boolean;
}) {
  const id = useId();
  const preflight = fullControlPreflight(input);
  const current = preflight.control?.mode ?? "custom";
  return <section className="section" aria-labelledby={`${id}-title`}>
    <h3 className="section-title" id={`${id}-title`}>Orchestrator Control</h3>
    <ChoiceRows<CampaignControlMode> label="Orchestrator Control" value={mode} onChange={onChange}
      options={[
        { value: "custom", title: "Custom", description: "Choose individual request and workflow decision owners.", disabled, inputData: { "data-control-mode": "custom" } },
        { value: "full_control", title: "Full Control", description: "Review autonomous control within one human-established campaign boundary. Activation is unavailable here.", disabled, inputData: { "data-control-mode": "full_control" } },
      ]} />
    <p className="section-note">Selecting the Orchestrator role or assigning all five owners does not authorize Full Control.</p>
    {input.surface === "defaults" && <p className="section-note">Defaults apply only to new campaigns. {preferenceSupported ? "Save Defaults records a preferred mode; it grants no campaign authority. " : "This version cannot save a control preference. "}Each new campaign still needs its own exact scope and authenticated human authorization.</p>}
    {input.surface === "campaign" && <p className="section-note">Effective Mode: {current === "full_control" ? "Full Control" : "Custom"}. Enabling or revoking control requires an explicit authenticated campaign operation against the current revision and revokes incompatible unused approvals. This preview does not change the mode.</p>}
    {mode === "full_control" && <>
      <h4 className="section-title">Full Control Preflight</h4>
      <Notice tone="neutral" role="status">Activation Unavailable</Notice>
      <dl className="facts orchestrator-facts">
        {preflight.facts.map(({ label, value }) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>
      <h4 className="section-title">Human Required and Unsupported Capabilities</h4>
      <ul>{preflight.blockers.map((reason) => <li key={reason}>{reason}</li>)}</ul>
      <p className="section-note">One authenticated human confirmation must bind the complete issue, budget, and evidence authorities together. Agent JSON, saved defaults, and this preview cannot grant authorization.</p>
      <button type="button" className="btn primary" disabled>Authorize Full Control</button>
    </>}
  </section>;
}
