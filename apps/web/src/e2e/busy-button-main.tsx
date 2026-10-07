import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { FeedbackProvider, useFeedback } from "../components/FeedbackProvider.js";
import { PlusIcon } from "../components/Icons.js";
import { BusyButton } from "../components/ui/BusyButton.js";
import "../styles.css";

/**
 * Busy buttons (#1949, docs/design-system.md §3.1) in a real browser, where width and height are
 * layout rather than numbers a DOM test supplies.
 *
 * `?surface=buttons` (the default) renders every variant at every size between two neighbours;
 * pressing one makes it busy and it stays busy, so a spec can measure the same element idle and busy.
 * `?surface=toast&toast=install|undo` shows one toast whose action never finishes, and
 * `?surface=confirm` opens a confirmation whose confirm action never finishes. `?surface=states`
 * (#2130) renders every variant enabled, `disabled`, `aria-disabled` and busy side by side.
 * `?surface=footer-sm` (#2645) is a dialog footer whose small primary never finishes.
 * `?theme=light` switches theme. Chosen by query string so every state is a clean reload.
 */

const never = () => new Promise<void>(() => undefined);

const VARIANTS = [
  ["Secondary", ""],
  ["Primary", "primary"],
  ["Ghost", "ghost"],
  ["Danger", "danger"],
  ["Ghost Danger", "ghost danger"],
] as const;
const SIZES = [["sm", "sm"], ["default", ""], ["lg", "lg"]] as const;

function PressToBusy({ className, label, icon }: { className: string; label: string; icon?: boolean }) {
  const [busy, setBusy] = useState(false);
  return (
    <BusyButton className={className} busy={busy} progress={`${label} is running…`} icon={icon ? <PlusIcon /> : undefined}
      onClick={() => setBusy(true)}>
      {label}
    </BusyButton>
  );
}

function Buttons() {
  return (
    <div className="busy-button-fixture" style={{ display: "grid", gap: 16, padding: 24 }}>
      {SIZES.map(([size, sizeClass]) => VARIANTS.map(([name, variant]) => (
        <div className="actions" key={`${size}-${name}`} data-size={size} data-variant={name}>
          <button className={`btn ${sizeClass}`} type="button" data-neighbour="before">Before</button>
          <PressToBusy className={`btn ${variant} ${sizeClass}`.replace(/\s+/g, " ").trim()} label="Install and Restart" />
          <PressToBusy className={`btn ${variant} ${sizeClass}`.replace(/\s+/g, " ").trim()} label="Add" icon />
          <button className={`btn ${sizeClass}`} type="button" data-neighbour="after">After</button>
        </div>
      )))}
    </div>
  );
}

function States() {
  return (
    <div className="button-states-fixture" style={{ display: "grid", gap: 16, padding: 24 }}>
      {VARIANTS.map(([name, variant]) => {
        const className = `btn ${variant}`.trim();
        return (
          <div className="actions" key={name} data-variant={name}>
            <button className={className} type="button" data-state="enabled">{name}</button>
            <button className={className} type="button" data-state="disabled" disabled>{name}</button>
            <button className={className} type="button" data-state="aria-disabled" aria-disabled="true">{name}</button>
            <BusyButton className={className} busy progress={`${name} is running…`} data-state="busy">{name}</BusyButton>          </div>
        );
      })}
    </div>
  );
}

/**
 * Dialog footers, which reserve no room at rest (#2645): a small primary beside Cancel, and a
 * primary that mounts busy, as a dialog reopened while its action still runs does.
 */
function FooterSm() {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 400px)", gap: 16, padding: 24 }}>
      <div className="modal-foot" data-fixture="footer-sm" style={{ width: "100%" }}>
        <button className="btn sm" type="button" data-neighbour="before">Cancel</button>
        <PressToBusy className="btn primary sm" label="Install and Restart" />
      </div>
      <div className="modal-foot" data-fixture="footer-mounted-busy" style={{ width: "100%" }}>
        <button className="btn" type="button">Cancel</button>
        <BusyButton className="btn primary" busy progress="Creating the skill…">Create Skill</BusyButton>
      </div>
    </div>
  );
}

function Toast({ kind }: { kind: "install" | "undo" }) {
  const { showToast, showUndo } = useFeedback();
  useEffect(() => {
    if (kind === "undo") showUndo("Session archived.", never);
    else showToast("Wollipog 0.30.0 is ready to install.", {
      durationMs: 0,
      action: { label: "Install and Restart", progress: "Installing the update…", run: never },
    });
  }, [kind, showToast, showUndo]);
  return null;
}

function Confirm() {
  const { confirm } = useFeedback();
  useEffect(() => {
    void confirm({
      title: "Stop Session",
      message: "“Fix the half-cent rounding bug” stops now. You can resume it later.",
      confirmLabel: "Stop Session",
      tone: "danger",
      progress: "Stopping the session…",
      onConfirm: never,
    });
  }, [confirm]);
  return null;
}

function Harness() {
  const params = new URLSearchParams(window.location.search);
  document.documentElement.setAttribute("data-theme", params.get("theme") === "light" ? "light" : "dark");
  const surface = params.get("surface");
  return (
    <FeedbackProvider>
      {surface === "toast" ? <Toast kind={params.get("toast") === "undo" ? "undo" : "install"} />
        : surface === "confirm" ? <Confirm />
          : surface === "states" ? <States />
            : surface === "footer-sm" ? <FooterSm />
              : <Buttons />}
    </FeedbackProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
