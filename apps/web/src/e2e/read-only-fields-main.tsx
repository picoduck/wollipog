import React from "react";
import { createRoot } from "react-dom/client";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { GuardrailsDialog, type GuardrailsDialogSession } from "../components/GuardrailsDialog.js";
import { RenameSessionDialog } from "../components/RenameSessionDialog.js";
import { SearchableCombobox, Select } from "../components/ui/ChoiceControls.js";
import "../styles.css";

/**
 * The read-only field state (#2520, docs/design-system.md §8.1) in a real browser.
 *
 * `?scenario=fields` (the default): an editable input and textarea, the same two read-only for good
 * (`.is-read-only`), a read-only field without the marker, an invalid field, a disabled input and
 * textarea, an editable and a disabled native select, a disabled and an enabled SearchableCombobox
 * (#2621), and an enabled Select, a disabled one and a disabled one showing its placeholder (#2619),
 * on a dialog body's surface.
 * `?scenario=guardrails-viewer` and `?scenario=guardrails-editable`: the real Guardrails dialog for a
 * Viewer and for someone who may save. Its save never settles, so a spec can hold it mid-save.
 * `?scenario=rename`: the real Rename Session dialog, whose rename never settles.
 * `?theme=light` switches theme.
 */

const params = new URLSearchParams(window.location.search);
document.documentElement.setAttribute("data-theme", params.get("theme") === "light" ? "light" : "dark");
const scenario = params.get("scenario") ?? "fields";

const SESSION: GuardrailsDialogSession = {
  costBudgetUsd: 5,
  costCheckpointsUsd: [10, 20],
  costUsd: 1.25,
  maxToolCalls: 200,
  toolCallCount: 37,
  maxChildSessions: 4,
  liveChildCapacity: { occupied: 1, limit: 4, remaining: 3 },
};
const VIEWER_REFUSAL = "Your Viewer role can't change this session's configuration.";
const REGIONS = [{ value: "us-east-1", label: "US East" }, { value: "eu-west-1", label: "EU West" }];
const never = () => new Promise<never>(() => {});

function Fields() {
  return (
    <div style={{ minHeight: "100vh", padding: 24, background: "var(--bg)" }}>
      <form className="form" noValidate onSubmit={(event) => event.preventDefault()}
        style={{ maxWidth: 560, margin: "0 auto", padding: 24, borderRadius: "var(--radius-md)", background: "var(--bg-elev)" }}>
        <label className="field" data-field="editable">
          <span>Editable</span>
          <input className="input" defaultValue="staging-vpc" />
        </label>
        <label className="field" data-field="read-only">
          <span>Read-Only</span>
          <input className="input is-read-only" readOnly defaultValue="/home/dev/projects/billing-service" />
        </label>
        <label className="field" data-field="editable-textarea">
          <span>Editable Textarea</span>
          <textarea rows={2} defaultValue="Review the diff before merging." />
        </label>
        <label className="field" data-field="read-only-textarea">
          <span>Read-Only Textarea</span>
          <textarea className="is-read-only" readOnly rows={2} defaultValue="Review the diff before merging." />
        </label>
        <label className="field" data-field="busy">
          <span>Read-Only While Saving</span>
          <input className="input" readOnly defaultValue="Fix the half-cent rounding bug" />
        </label>
        <label className="field" data-field="invalid">
          <span>Invalid</span>
          <input className="input" aria-invalid="true" defaultValue="not a number" />
        </label>
        <label className="field" data-field="disabled">
          <span>Disabled</span>
          <input className="input" disabled defaultValue="staging-vpc" />
        </label>
        <label className="field" data-field="disabled-textarea">
          <span>Disabled Textarea</span>
          <textarea disabled rows={2} defaultValue="Review the diff before merging." />
        </label>
        <label className="field" data-field="editable-select">
          <span>Editable Select</span>
          <select defaultValue="us-east-1">
            <option value="us-east-1">us-east-1</option>
          </select>
        </label>
        <label className="field" data-field="disabled-select">
          <span>Disabled Select</span>
          <select disabled defaultValue="us-east-1">
            <option value="us-east-1">us-east-1</option>
          </select>
        </label>
        <div className="field" data-field="combobox">
          <span>Project</span>
          <SearchableCombobox<string>
            label="Project"
            value="billing"
            onChange={() => {}}
            options={[{ value: "billing", label: "Billing Service" }]}
            disabled
          />
        </div>
        <div className="field" data-field="editable-combobox">
          <span>Editable Project</span>
          <SearchableCombobox<string>
            label="Editable Project"
            value="billing"
            onChange={() => {}}
            options={[{ value: "billing", label: "Billing Service" }]}
          />
        </div>
        <div className="field" data-field="select-trigger">
          <span>Region</span>
          <Select<string> label="Region" value="us-east-1" onChange={() => {}} options={REGIONS} />
        </div>
        <div className="field" data-field="disabled-select-trigger">
          <span>Disabled Region</span>
          <Select<string> label="Disabled Region" value="us-east-1" onChange={() => {}} options={REGIONS} disabled />
        </div>
        <div className="field" data-field="disabled-select-trigger-placeholder">
          <span>Fallback Region</span>
          <Select<string> label="Fallback Region" value={null} onChange={() => {}} options={REGIONS} disabled />
        </div>
      </form>
    </div>
  );
}

function Harness() {
  if (scenario === "guardrails-viewer" || scenario === "guardrails-editable") {
    return (
      <GuardrailsDialog
        session={SESSION}
        configRefusal={scenario === "guardrails-viewer" ? VIEWER_REFUSAL : null}
        onSave={never}
        onClose={() => {}}
      />
    );
  }
  if (scenario === "rename") {
    const client: ApiClient = { ...api, renameSession: never };
    return (
      <ApiProvider client={client}>
        <RenameSessionDialog session={{ id: "session-1", title: "Fix the half-cent rounding bug" }} onClose={() => {}} />
      </ApiProvider>
    );
  }
  return <Fields />;
}

createRoot(document.getElementById("root")!).render(<Harness />);
