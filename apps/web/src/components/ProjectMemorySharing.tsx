import { ChoiceRows } from "./ui/ChoiceControls.js";
import { BusyButton } from "./ui/BusyButton.js";
import { useEffect, useState } from "react";
import { PROJECT_MEMORY_MIN_PROTOCOL, supportsClaudeProjectMemory,
  type ProjectMemorySharing, type ProjectView, type RunnerView } from "@wollipog/protocol";

export function ProjectMemorySharingSettings({ project, runners, disabled, onSave }: {
  project: ProjectView;
  runners: ReadonlyMap<string, RunnerView>;
  disabled: boolean;
  onSave: (sharing: ProjectMemorySharing) => Promise<unknown>;
}) {
  const [choice, setChoice] = useState<ProjectMemorySharing>(project.memorySharing ?? "separate");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setChoice(project.memorySharing ?? "separate"); setError(null); }, [project.memorySharing]);
  const machines = [...new Set(project.locations.map((location) => location.runnerId))];
  return <section className="project-detail-section" aria-labelledby="memory-sharing-heading">
    <h3 id="memory-sharing-heading">Memory Sharing</h3>
    <p>Choose whether accounts share this Project’s additional saved memory. Conversation history follows the session when you switch accounts and may already contain memories. This choice cannot remove that information or prevent a provider from learning from the conversation under its own settings.</p>
    {project.memorySharing === undefined ? <p role="status">Memory policy is unavailable. Update Wollipog to configure it.</p> : <>
      <p><strong>Saved Choice: </strong>{project.memorySharing === "shared" ? "Share Project Memory" : "Keep Account Memories Separate"}</p>
      <form onSubmit={(event) => {
        event.preventDefault();
        if (saving || disabled || choice === project.memorySharing) return;
        setSaving(true); setError(null);
        void onSave(choice).catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not save the memory policy."))
          .finally(() => setSaving(false));
      }}>
        <ChoiceRows<ProjectMemorySharing> label="Memory Sharing" value={choice} onChange={setChoice}
          options={[
            { value: "separate", title: "Keep Account Memories Separate", disabled: disabled || saving,
              description: "Claude auto-memory stays private to the selected account." },
            { value: "shared", title: "Share Project Memory", disabled: disabled || saving,
              description: "Claude accounts on this machine use this Project’s shared auto-memory." },
          ]} />
        <BusyButton className="btn" type="submit" busy={saving} progress="Saving the memory policy…"
          disabled={!saving && (disabled || choice === project.memorySharing)}>Save Memory Policy</BusyButton>
      </form>
      {error && <p className="form-error" role="alert">{error}</p>}
    </>}
    <p>Claude sharing applies to this Project’s accounts on the same machine. Codex keeps its native account memories; project-only sharing is unavailable in its current memory system. Other providers and container or cloud sessions do not support this choice. Unsupported installations retain native memory when accounts are kept separate, and refuse explicit sharing with an update instruction.</p>
    {machines.length === 0 && <p>No Locations are linked. Add a Location to use this policy.</p>}
    {machines.map((id) => {
      const runner = runners.get(id);
      const capableRunner = (runner?.protocolVersion ?? 0) >= PROJECT_MEMORY_MIN_PROTOCOL;
      const claude = runner?.agents.filter((agent) => agent.driver === "claude-code");
      const capableClaude = claude?.some((agent) => supportsClaudeProjectMemory(agent.version));
      return <p key={id}><strong>{runner?.displayName ?? runner?.hostname ?? "Machine"}: </strong>{!capableRunner
        ? "Memory Policy Unavailable — update this runner."
        : !capableClaude ? "Claude Memory Policy Unavailable — install Claude Code 2.1.284 or newer and refresh agents."
        : runner?.status !== "online" ? "Machine Offline — the saved policy will apply when it reconnects."
        : "Supported Claude installations use the saved choice. Unsupported default cases retain native memory; explicit sharing requires support."}</p>;
    })}
    <p>Changes apply after the current turn and its background work finish, before the next ordinary turn. Existing account memories and previously shared storage remain in their original locations. New managed directories start empty; existing memories are not automatically imported. Turning sharing off retains shared files and returns each account to its own saved memory. Re-enabling sharing reuses the retained shared files.</p>
  </section>;
}
