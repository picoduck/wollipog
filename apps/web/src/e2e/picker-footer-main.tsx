import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { PlusIcon, SettingsIcon } from "../components/Icons.js";
import { SearchableCombobox, Select, type SearchableComboboxOption } from "../components/ui/ChoiceControls.js";
import "../styles.css";

/**
 * Grouped options, the chosen check and the footer action row (#2951, docs/design-system.md §8.4,
 * §9.1) in a real browser, where row heights, the separator and the list's placement are layout
 * rather than numbers a DOM test supplies.
 *
 * Agent is a grouped SearchableCombobox with a footer action; Project is the searchable Select a
 * touch device gets, with a create row and a footer action; Location is a plain Select with one.
 * Each field reports how often its footer action ran in `data-footer-runs`, and its value in
 * `data-value`. `?theme=light` switches theme; `?openOnFocus=0` makes Agent focus without opening.
 * `?narrow=1` adds Reviewer first: the same combobox in a 200px field, whose open list still takes
 * the 280px floor Select's does (§8.3).
 */

const AGENTS: SearchableComboboxOption<string>[] = [
  { value: "claude", label: "Claude Code", description: "Local · Signed In", group: "Ready" },
  { value: "codex", label: "Codex", group: "Ready" },
  { value: "payments", label: "Payments Reviewer", group: "Ready" },
  { value: "gemini", label: "Gemini CLI", group: "Needs Setup", disabled: true, disabledReason: "Not Installed" },
];

const PROJECTS = [
  { value: "wollipog", label: "Wollipog", description: "Studio Mac · 3 locations" },
  { value: "docs", label: "Docs Site", description: "Build Server · 1 location" },
  { value: "payments", label: "Payments", description: "No locations yet" },
];

const LOCATIONS = [
  { value: "studio", label: "Studio Mac", description: "Online · ~/dev/wollipog" },
  { value: "build", label: "Build Server 02", description: "Offline · /srv/wollipog", group: "Unavailable" },
];

function Harness() {
  const params = new URLSearchParams(window.location.search);
  document.documentElement.setAttribute("data-theme", params.get("theme") === "light" ? "light" : "dark");
  const [agent, setAgent] = useState<string | null>("codex");
  const [project, setProject] = useState<string | null>("wollipog");
  const [location, setLocation] = useState<string | null>("studio");
  const [runs, setRuns] = useState<Record<string, number>>({});
  const ran = (field: string) => () => setRuns((current) => ({ ...current, [field]: (current[field] ?? 0) + 1 }));
  return (
    // A dialog body's width and spacing without `.modal` itself, whose entrance scale would make
    // every box read during the first frames a frame of that motion rather than the layout.
    <div style={{ margin: "24px auto", maxWidth: 560, background: "var(--bg-elev)", borderRadius: "var(--radius-md)" }}>
      <div className="modal-body form">
        {params.get("narrow") === "1" && (
          <div className="field" data-field="reviewer" style={{ width: 200 }}>
            <span>Reviewer</span>
            <SearchableCombobox<string>
              label="Reviewer"
              options={AGENTS}
              value={agent}
              onChange={setAgent}
              placeholder="Choose an Agent…"
              noun="agents"
              footerAction={{ label: "Set Up Agents in Connections", icon: <SettingsIcon />, onSelect: ran("reviewer") }}
            />
          </div>
        )}
        <div className="field" data-field="agent" data-value={agent ?? ""} data-footer-runs={runs.agent ?? 0}>
          <span>Agent</span>
          <SearchableCombobox<string>
            label="Agent"
            options={AGENTS}
            value={agent}
            onChange={setAgent}
            placeholder="Choose an Agent…"
            noun="agents"
            openOnFocus={params.get("openOnFocus") !== "0"}
            footerAction={{ label: "Set Up Agents in Connections", icon: <SettingsIcon />, onSelect: ran("agent") }}
          />
        </div>
        <div className="field" data-field="project" data-value={project ?? ""} data-footer-runs={runs.project ?? 0}>
          <span>Project</span>
          <Select<string>
            label="Project"
            options={PROJECTS}
            value={project}
            onChange={setProject}
            searchable
            noun="projects"
            createOption={{ label: "Create Project…", onSelect: ran("create") }}
            footerAction={{ label: "New Project…", icon: <PlusIcon />, onSelect: ran("project") }}
          />
        </div>
        <div className="field" data-field="location" data-value={location ?? ""} data-footer-runs={runs.location ?? 0}>
          <span>Location</span>
          <Select<string>
            label="Location"
            options={LOCATIONS}
            value={location}
            onChange={setLocation}
            footerAction={{ label: "Add Location…", icon: <PlusIcon />, onSelect: ran("location") }}
          />
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
