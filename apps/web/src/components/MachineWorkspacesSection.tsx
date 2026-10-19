import { useId, useState } from "react";
import { runnerSupportsProtocol, type RunnerView } from "@wollipog/protocol";
import { AddWorkspaceDialog } from "./AddWorkspaceDialog.js";
import { FolderIcon } from "./Icons.js";

/** Why Add Workspace… waits: the machine is offline. */
export const ADD_WORKSPACE_OFFLINE = "This machine is offline. Start it to add a workspace.";
/** Why Add Workspace… waits: the runner cannot list folders. */
export const ADD_WORKSPACE_NO_BROWSING = "Update Wollipog on this machine to browse its folders.";

/** Why Add Workspace… is off, or null while it can open. */
export function addWorkspaceBlockedReason(runner: RunnerView, online: boolean): string | null {
  if (!online) return ADD_WORKSPACE_OFFLINE;
  if (!runnerSupportsProtocol(runner.protocolVersion, "directoryListing")) return ADD_WORKSPACE_NO_BROWSING;
  return null;
}

/**
 * A machine's Workspaces (#2989, docs/design-system.md §4.5, §5.2, §11.3): the title with its
 * count and Add Workspace… for owners and admins, then one row per workspace with its folder's
 * path in the monospace face, truncated from the start so the folder it ends in stays in view.
 */
export function MachineWorkspacesSection({ runner, machineName, online, canAdd }: {
  runner: RunnerView;
  machineName: string;
  online: boolean;
  /** An organization owner or admin. */
  canAdd: boolean;
}) {
  const id = `workspaces-${useId().replace(/:/g, "")}`;
  const [adding, setAdding] = useState(false);
  const blocked = addWorkspaceBlockedReason(runner, online);
  const workspaces = runner.workspaces;
  return (
    <section className="section" aria-labelledby={id}>
      <div className="section-head">
        <h3 id={id} className="section-title">Workspaces <span className="count">{workspaces.length}</span></h3>
        {canAdd && (
          <div className="actions">
            <button type="button" className="btn sm" disabled={blocked !== null}
              aria-describedby={blocked ? `${id}-blocked` : undefined} onClick={() => setAdding(true)}>
              Add Workspace…
            </button>
          </div>
        )}
      </div>
      {canAdd && blocked && <p className="section-note" id={`${id}-blocked`}>{blocked}</p>}
      {workspaces.length > 0 ? (
        <ul className="surface machine-workspaces" aria-labelledby={id}>
          {workspaces.map((workspace) => (
            <li key={workspace.id} className="row">
              <span className="row-icon"><FolderIcon size={16} aria-hidden="true" /></span>
              <span className="row-title">{workspace.name}</span>
              <span className="machine-workspace-path" title={workspace.path}><bdi>{workspace.path}</bdi></span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="machine-section-state">No workspaces yet.</p>
      )}
      {adding && <AddWorkspaceDialog runner={runner} machineName={machineName} onClose={() => setAdding(false)} />}
    </section>
  );
}
