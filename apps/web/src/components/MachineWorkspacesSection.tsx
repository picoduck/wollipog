import { useId, useState } from "react";
import { runnerSupportsProtocol, type RunnerView, type WorkspaceInfo } from "@wollipog/protocol";
import { AddWorkspaceDialog } from "./AddWorkspaceDialog.js";
import { FolderIcon } from "./Icons.js";
import { RemoveWorkspaceDialog } from "./RemoveWorkspaceDialog.js";

/** Why Add Workspace… and Remove… wait: the machine is offline. */
export const ADD_WORKSPACE_OFFLINE = "This machine is offline. Start it to add or remove workspaces.";
/** Why Add Workspace… waits: the runner cannot list folders. */
export const ADD_WORKSPACE_NO_BROWSING = "Update Wollipog on this machine to browse its folders.";
/** Why Remove… waits on a workspace from the runner's configuration: the runner cannot remove one. */
export const REMOVE_WORKSPACE_UNSUPPORTED =
  "Update Wollipog on this machine to remove workspaces set in its runner configuration.";

/** Why Add Workspace… is off, or null while it can open. */
export function addWorkspaceBlockedReason(runner: RunnerView, online: boolean): string | null {
  if (!online) return ADD_WORKSPACE_OFFLINE;
  if (!runnerSupportsProtocol(runner.protocolVersion, "directoryListing")) return ADD_WORKSPACE_NO_BROWSING;
  return null;
}

/** Whether this runner can remove this workspace: one added in Wollipog always can, one from the
 * runner's configuration needs a runner that records removals (#4123). */
export function workspaceRemovalSupported(runner: RunnerView, workspace: WorkspaceInfo): boolean {
  return workspace.source === "managed" || runnerSupportsProtocol(runner.protocolVersion, "workspaceRemoval");
}

/**
 * A machine's Workspaces (#2989, #4123, docs/design-system.md §4.5, §5.2, §11.3): the title with
 * its count and Add Workspace… for owners and admins, then one row per workspace with its folder's
 * path in the monospace face, truncated from the start so the folder it ends in stays in view, and
 * Remove… for owners and admins. A Remove… that cannot run says why in a note under the title.
 */
export function MachineWorkspacesSection({ runner, machineName, online, canAdd }: {
  runner: RunnerView;
  machineName: string;
  online: boolean;
  /** An organization owner or admin: adds and removes workspaces. */
  canAdd: boolean;
}) {
  const id = `workspaces-${useId().replace(/:/g, "")}`;
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<WorkspaceInfo | null>(null);
  const blocked = addWorkspaceBlockedReason(runner, online);
  const workspaces = runner.workspaces;
  const removalUnsupported = online && workspaces.some((workspace) => !workspaceRemovalSupported(runner, workspace));
  const removalBlockedId = (workspace: WorkspaceInfo): string | undefined =>
    !online ? `${id}-blocked` : !workspaceRemovalSupported(runner, workspace) ? `${id}-unsupported` : undefined;
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
      {canAdd && removalUnsupported && <p className="section-note" id={`${id}-unsupported`}>{REMOVE_WORKSPACE_UNSUPPORTED}</p>}
      {workspaces.length > 0 ? (
        <ul className="surface machine-workspaces" aria-labelledby={id}>
          {workspaces.map((workspace) => {
            const titleId = `${id}-${workspace.id}`;
            const removalBlocked = removalBlockedId(workspace);
            return (
              <li key={workspace.id} className="row">
                <span className="row-icon"><FolderIcon size={16} aria-hidden="true" /></span>
                <span className="row-title" id={titleId}>{workspace.name}</span>
                <span className="machine-workspace-path" title={workspace.path}><bdi>{workspace.path}</bdi></span>
                {canAdd && (
                  <button type="button" className="btn sm ghost" aria-haspopup="dialog" disabled={removalBlocked !== undefined}
                    aria-describedby={[titleId, removalBlocked].filter(Boolean).join(" ")}
                    onClick={() => setRemoving(workspace)}>
                    Remove…
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="machine-section-state">No workspaces yet.</p>
      )}
      {adding && <AddWorkspaceDialog runner={runner} machineName={machineName} onClose={() => setAdding(false)} />}
      {removing && (
        <RemoveWorkspaceDialog runner={runner} machineName={machineName} workspace={removing}
          onClose={() => setRemoving(null)} />
      )}
    </section>
  );
}
