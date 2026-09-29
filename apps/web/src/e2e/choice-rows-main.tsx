import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Checkbox, ChoiceList, ChoiceRows } from "../components/ui/ChoiceControls.js";
import "../styles.css";

/**
 * ChoiceRows, ChoiceList and the Checkbox row (#1952, docs/design-system.md §8.4) in a real browser,
 * where marker alignment, arrow keys, Space and hit areas are layout and platform behaviour rather
 * than numbers a DOM test supplies.
 *
 * Rows deliberately differ in height — a title alone, a title over a description, and a disabled row
 * whose reason wraps — because the claim under test is that the markers still form one column.
 * Each group reports its current value in a `data-value` attribute so a spec can read what a key or
 * a click actually selected. `?theme=light` switches theme.
 */

function Harness() {
  const params = new URLSearchParams(window.location.search);
  document.documentElement.setAttribute("data-theme", params.get("theme") === "light" ? "light" : "dark");
  const [preset, setPreset] = useState<string | null>("quick");
  const [agents, setAgents] = useState<readonly string[]>(["claude"]);
  const [worktree, setWorktree] = useState<string | null>("main");
  const [checks, setChecks] = useState<Record<string, boolean>>({ started: true });
  const check = (key: string) => (checked: boolean) => setChecks((current) => ({ ...current, [key]: checked }));
  return (
    // A dialog body's width and spacing without `.modal` itself, whose entrance scale would make
    // every box read during the first frames a frame of that motion rather than the layout.
    <div style={{ margin: "24px auto", maxWidth: 560, background: "var(--bg-elev)", borderRadius: "var(--radius-md)" }}>
      <div className="modal-body form">
        <div className="field" data-group="preset" data-value={preset ?? ""}>
          <span>Preset</span>
          <ChoiceRows<string>
            label="Preset"
            value={preset}
            onChange={setPreset}
            options={[
              { value: "quick", title: "Quick" },
              { value: "reviewed", title: "Reviewed", description: "Two agents and a review pass." },
              {
                value: "orchestrated",
                title: "Orchestrated",
                description: "Delegate implementation by default. Provider permissions, optional Strict Project Isolation, and decision delegation are configured separately below and cannot change after creation.",
              },
              {
                value: "remote",
                title: "Remote Box",
                description: "Run over SSH on a connected machine.",
                disabled: true,
                disabledReason: "No machine is connected. Pair a machine in Settings, then reopen this dialog to choose it here.",
              },
              { value: "custom", title: "Custom", description: "Your own agents and roles.", meta: "3 Agents" },
            ]}
          />
        </div>
        <div className="field" data-group="agents" data-value={agents.join(",")}>
          <span>Agents</span>
          <ChoiceRows<string>
            multiple
            label="Agents"
            value={agents}
            onChange={(value) => setAgents((current) => current.includes(value)
              ? current.filter((item) => item !== value)
              : [...current, value])}
            options={[
              { value: "claude", title: "Claude Code", description: "Anthropic's coding agent." },
              { value: "codex", title: "Codex" },
              { value: "pi", title: "Pi", disabled: true, disabledReason: "Sign in to Pi first." },
            ]}
          />
        </div>
        <div className="field" data-group="worktree" data-value={worktree ?? ""}>
          <span>Worktree</span>
          <ChoiceList<string>
            label="Worktree"
            value={worktree}
            onChange={setWorktree}
            options={[
              { value: "main", label: "Main Checkout", meta: "main" },
              { value: "fix", label: "Fix Branch", meta: "fix/issue-1952" },
              { value: "stale", label: "Stale Branch", meta: "gone", disabled: true, disabledReason: "The branch was deleted." },
            ]}
          />
        </div>
        <fieldset className="field" data-group="checks" data-value={Object.entries(checks).filter(([, on]) => on).map(([key]) => key).join(",")}>
          <legend>Web Push Events</legend>
          <Checkbox label="Started" checked={checks.started ?? false} onChange={check("started")} />
          <Checkbox label="Succeeded" checked={checks.succeeded ?? false} onChange={check("succeeded")} />
          <Checkbox label="Include Session Name" helper="Session names are excluded unless selected."
            checked={checks.sessionName ?? false} onChange={check("sessionName")} />
          <Checkbox consent label="Accept version diff and update existing assignments"
            checked={checks.consent ?? false} onChange={check("consent")} />
          <Checkbox label="Expired" disabled checked={false} onChange={check("expired")} />
        </fieldset>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
