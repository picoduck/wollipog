import React from "react";
import { createRoot } from "react-dom/client";
import { FieldError } from "../components/FieldError.js";
import { FieldWarning } from "../components/FieldWarning.js";
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

function Harness() {
  document.documentElement.setAttribute("data-theme",
    new URLSearchParams(window.location.search).get("theme") === "light" ? "light" : "dark");
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
        <SaveBar dirty error="Couldn't save the instructions." onDiscard={() => {}} onSave={() => {}} />
      </form>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
