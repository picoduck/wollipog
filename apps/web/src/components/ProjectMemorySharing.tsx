import { PROJECT_MEMORY_MIN_PROTOCOL, supportsClaudeProjectMemory,
  type ProjectMemorySharing, type ProjectView, type RunnerView } from "@wollipog/protocol";
import type { RunnerDisplay } from "../runners.js";
import type { SelectOption } from "./ui/ChoiceControls.js";
import { SelectRow, SettingsGroup, ValueRow } from "./ui/SettingsRows.js";
import { DetailSection } from "./DetailSection.js";
import { ChevronRightIcon, ComputerIcon, ServerIcon } from "./Icons.js";
import { Notice } from "./Notice.js";

/**
 * The list names each choice in full. The trigger, already named Memory Sharing by its row, shows
 * "Keep Separate", which fits the 240px control column where the full name would be cut off (§8.2).
 */
const MEMORY_SHARING_OPTIONS: readonly SelectOption<ProjectMemorySharing>[] = [
  { value: "separate", label: "Keep Account Memories Separate", selectedLabel: "Keep Separate",
    description: "Each account keeps its own saved memory." },
  { value: "shared", label: "Share Project Memory", description: "Accounts on the same machine use this project's shared memory." },
];

/** A choice as its row shows it, read-only to a viewer as in the trigger. */
function savedLabel(sharing: ProjectMemorySharing): string {
  const option = MEMORY_SHARING_OPTIONS.find((candidate) => candidate.value === sharing)!;
  return option.selectedLabel ?? option.label;
}

/**
 * What a machine with a location in the project says about the policy. The checks are the policy's
 * own, in order: the runner speaks the memory protocol, it has a Claude Code that supports it, and it
 * is online to receive the saved choice.
 */
export function memorySharingMachineStatus(runner: RunnerView | undefined): string {
  if ((runner?.protocolVersion ?? 0) < PROJECT_MEMORY_MIN_PROTOCOL) return "Update Wollipog on this machine to use it";
  const claude = runner!.agents.filter((agent) => agent.driver === "claude-code");
  if (!claude.some((agent) => supportsClaudeProjectMemory(agent.version))) {
    return "Install Claude Code 2.1.284 or newer, then refresh agents";
  }
  if (runner!.status !== "online") return "Offline. The saved choice applies when it reconnects.";
  return "Supported";
}

/**
 * A project's Memory Sharing (#2963): one sentence, one setting row and one row per machine, with the
 * policy's details behind About (docs/design-system.md §8.2, §5.2, §5.5, §17.2). The choice is part of
 * the project's settings draft and saved by its save bar (§8.6), so this section only shows `value`
 * and reports changes.
 *
 * Choosing Share Project Memory while it is not the saved choice shows the consent notice under the
 * row, so it is read before Save is pressed: sharing is only ever saved from there.
 */
export function ProjectMemorySharingSection({ project, runners, machine, value, consentShown, readOnly, onChange }: {
  project: ProjectView;
  runners: ReadonlyMap<string, RunnerView>;
  /** The name and kind a machine is shown with, as its locations show it. */
  machine: (runnerId: string) => RunnerDisplay;
  /** The draft's choice: the saved one until the person picks another. */
  value: ProjectMemorySharing;
  /** The consent notice shows: `value` shares project memory and the saved choice does not. */
  consentShown: boolean;
  readOnly: boolean;
  onChange: (sharing: ProjectMemorySharing) => void;
}) {
  const saved = project.memorySharing;
  const machines = [...new Set(project.locations.map((location) => location.runnerId))];
  return (
    <DetailSection title="Memory Sharing" note="Whether this project's Claude accounts on the same machine share saved memory.">
      {saved === undefined ? (
        <Notice tone="warning" compact title="Memory Sharing Needs an Update">
          Update Wollipog to choose how accounts share memory.
        </Notice>
      ) : (
        <>
          <SettingsGroup>
            {readOnly ? (
              <ValueRow title="Memory Sharing" value={savedLabel(saved)} />
            ) : (
              <SelectRow
                title="Memory Sharing"
                options={MEMORY_SHARING_OPTIONS}
                value={value}
                onChange={(next) => onChange(next as ProjectMemorySharing)}
              />
            )}
          </SettingsGroup>
          {consentShown && (
            <Notice tone="info">
              A conversation keeps its history when it switches accounts, and that history may already contain
              memories. Sharing can't remove it, or stop a provider learning from the conversation under its own
              settings.
            </Notice>
          )}
          {machines.length === 0 ? (
            <div className="surface">
              <div className="row project-memory-empty">Add a location to use this setting.</div>
            </div>
          ) : (
            <ul className="surface project-memory-machines" aria-label="Machines">
              {machines.map((runnerId) => {
                const display = machine(runnerId);
                return (
                  <li key={runnerId} className="row row-2 project-memory-machine">
                    <span className="row-icon">{display.kind === "ssh" ? <ServerIcon /> : <ComputerIcon />}</span>
                    <span className="row-body">
                      <span className="row-title" title={display.name}>{display.name}</span>
                      <span className="row-sub">{memorySharingMachineStatus(runners.get(runnerId))}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      <details className="disclosure">
        <summary><ChevronRightIcon size={14} className="disclosure-chevron" />About Memory Sharing</summary>
        <div className="disclosure-body project-memory-about">
          <p>
            Only Claude Code supports it. Codex keeps its own account memory, and container and cloud sessions
            don't support it. On a machine without support, separate accounts keep their own memory and sharing
            is refused until it's updated.
          </p>
          <p>A change applies once the current turn and its background work finish.</p>
          <p>
            Turning sharing off keeps the shared memory and returns each account to its own. Turning it on again
            reuses the shared memory. Existing account memories are never copied into it.
          </p>
        </div>
      </details>
    </DetailSection>
  );
}
