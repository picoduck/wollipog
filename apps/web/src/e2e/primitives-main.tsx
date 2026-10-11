import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { FieldError } from "../components/FieldError.js";
import { FieldWarning } from "../components/FieldWarning.js";
import { FeedbackProvider, useFeedback } from "../components/FeedbackProvider.js";
import { DetailBar } from "../components/PageHeader.js";
import { SaveBar } from "../components/SaveBar.js";
import "../styles.css";

/**
 * Shared primitives that no screen uses yet, in a real browser, on the dialog body's surface.
 *
 * The field error (#2150, docs/design-system.md §8.5): the same field with its helper, invalid with
 * its error, and invalid with focus, so a spec can compare where the error sits with where the helper
 * sat (`.field-helper`).
 * A field warning (§8.5) and a failed save's bar (§8.6), whose tone icons follow their words in
 * forced colors (#2269).
 * The editor save bar's states (#2948, §8.6) under the form, each in its own `[data-save-bar]` region
 * so the sticky bars do not stack: dirty with a custom label, blocked, busy (pressing Save makes it
 * busy and it stays busy, so a spec can measure the same button idle and busy), a new record shown
 * while clean with Cancel and its create label, and a failed save.
 * Field anatomy (#2270, §8.1): a `.field-head` label row with a control beside the label, and a field
 * warning under a helper, so a spec can measure label to control, control to helper and helper to
 * warning.
 * `?view=actions-menu` shows instead a detail bar whose ⋯ item confirms with the menu's `reopen` as
 * its Back (#2949, §7.5): on a phone the confirmation replaces the ⋯ sheet and Back brings it back.
 * `?theme=light` switches theme.
 */

const HELPER = "Shown in the session list and the window title.";
const ERROR = "Enter a name of 64 characters or fewer.";
const NAME = "Fix the half-cent rounding bug in the invoice exporter that drops the final cent";

function NameField({ state }: { state: "helper" | "invalid" | "focused" }) {
  const id = `name-${state}`;
  const invalid = state !== "helper";
  return (
    <label className="field" data-state={state}>
      <span>Session Name</span>
      <input
        className="input"
        defaultValue={invalid ? NAME : "Fix the half-cent rounding bug"}
        aria-invalid={invalid || undefined}
        aria-describedby={`${id}-${invalid ? "error" : "helper"}`}
        autoFocus={state === "focused"}
      />
      {invalid
        ? <FieldError id={`${id}-error`}>{ERROR}</FieldError>
        : <p className="field-helper" id={`${id}-helper`}>{HELPER}</p>}
    </label>
  );
}

function HeadField() {
  return (
    <div className="field" data-state="head">
      <div className="field-head">
        <label htmlFor="head-input">Instructions</label>
        <button type="button" className="btn sm">Upload Folder…</button>
      </div>
      <input id="head-input" className="input" defaultValue="Review the diff" aria-describedby="head-helper" />
      <p className="field-helper" id="head-helper">{HELPER}</p>
    </div>
  );
}

function WarnField() {
  return (
    <label className="field" data-state="warn">
      <span>Branch</span>
      <input className="input" defaultValue="fix/rounding" aria-describedby="warn-helper warn-warning" />
      <p className="field-helper" id="warn-helper">The branch the worktree checks out.</p>
      <FieldWarning id="warn-warning">This branch already has a worktree.</FieldWarning>
    </label>
  );
}

function ConfirmingDetailBar() {
  const { confirm } = useFeedback();
  const [answers, setAnswers] = React.useState<string[]>([]);
  return (
    <>
      <DetailBar
        title="Nightly Digest"
        backLabel="Back to Automations"
        onBack={() => {}}
        menu={[
          { label: "Run Now", onClick: () => {} },
          { label: "Duplicate…", onClick: () => {} },
          {
            label: "Delete Automation…",
            danger: true,
            onClick: ({ reopen }) => {
              void confirm({
                title: "Delete Automation",
                message: "Nightly Digest and its run history are deleted. This cannot be undone.",
                confirmLabel: "Delete Automation",
                tone: "danger",
                back: { label: "Back to More Actions", run: reopen },
              }).then((confirmed) => setAnswers((list) => [...list, String(confirmed)]));
            },
          },
        ]}
      />
      {answers.length > 0 && (
        <p className="muted sm" style={{ padding: 16 }}>
          Confirmation resolved: <span data-confirmation-answers>{answers.join(", ")}</span>
        </p>
      )}
    </>
  );
}

function BusySaveBar() {
  const [busy, setBusy] = useState(false);
  return <SaveBar dirty busy={busy} saveLabel="Save Changes" onDiscard={() => {}} onSave={() => setBusy(true)} />;
}

const SAVE_BAR_STATES: [string, React.ReactNode][] = [
  ["dirty", <SaveBar dirty saveLabel="Save Changes" onDiscard={() => {}} onSave={() => {}} />],
  ["blocked", <SaveBar dirty saveLabel="Save Changes" blockedReason="Fix 1 setting to save" onDiscard={() => {}} onSave={() => {}} />],
  ["busy", <BusySaveBar />],
  ["new-record", <SaveBar dirty={false} alwaysShown saveLabel="Create Automation" discardLabel="Cancel" onDiscard={() => {}} onSave={() => {}} />],
  ["error", <SaveBar dirty error="Couldn't save the instructions." onDiscard={() => {}} onSave={() => {}} />],
];

function SaveBarStates() {
  return (
    <section className="save-bar-states" style={{ display: "grid", gap: 16, maxWidth: 560, margin: "24px auto 0" }}>
      {SAVE_BAR_STATES.map(([state, bar]) => <div key={state} data-save-bar={state}>{bar}</div>)}
    </section>
  );
}

function Harness() {
  const params = new URLSearchParams(window.location.search);
  document.documentElement.setAttribute("data-theme", params.get("theme") === "light" ? "light" : "dark");
  if (params.get("view") === "actions-menu") {
    return (
      <FeedbackProvider>
        <div style={{ minHeight: "100vh", background: "var(--bg)" }}>
          <ConfirmingDetailBar />
        </div>
      </FeedbackProvider>
    );
  }
  return (
    <div style={{ minHeight: "100vh", padding: 24, background: "var(--bg)" }}>
      <form className="form" noValidate
        style={{ maxWidth: 560, margin: "0 auto", padding: 24, borderRadius: "var(--radius-md)", background: "var(--bg-elev)" }}>
        <NameField state="helper" />
        <NameField state="invalid" />
        <NameField state="focused" />
        <label className="field" data-state="warning">
          <span>Branch Name</span>
          <input className="input" defaultValue="main" aria-describedby="branch-warning" />
          <FieldWarning id="branch-warning">Sessions on main commit straight to the default branch.</FieldWarning>
        </label>
        <HeadField />
        <WarnField />
      </form>
      <SaveBarStates />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
