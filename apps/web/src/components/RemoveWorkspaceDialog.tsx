import { useRef, useState } from "react";
import type { RunnerView, WorkspaceInfo } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { machineSettingsMutationError } from "../runners.js";
import { Modal } from "./common.js";
import { useFeedback } from "./FeedbackProvider.js";
import { Notice } from "./Notice.js";
import { BusyButton } from "./ui/BusyButton.js";

/**
 * Remove Workspace (#4123, docs/design-system.md §7, §8.5): names the machine, the workspace and its
 * folder, and says that removal only unregisters it. Cancel changes nothing. A refusal (something
 * still uses the workspace, or the machine could not remove it) is a danger notice that keeps the
 * dialog open; success closes it with a toast, and the row leaves with the machine's next snapshot.
 */
export function RemoveWorkspaceDialog({ runner, machineName, workspace, onClose }: {
  runner: RunnerView;
  machineName: string;
  workspace: WorkspaceInfo;
  onClose: () => void;
}) {
  const api = useApi();
  const { showToast } = useFeedback();
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const close = () => {
    if (!busyRef.current) onClose();
  };
  const remove = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    try {
      await api.removeMachineWorkspace(runner.runnerId, workspace.id);
      busyRef.current = false;
      showToast("Workspace removed.", { tone: "success", detail: "Its folder and files were not deleted." });
      onClose();
    } catch (cause) {
      busyRef.current = false;
      setFailure(machineSettingsMutationError(cause));
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Remove Workspace"
      description={machineName}
      onClose={close}
      size="md"
      footer={(
        <>
          <button type="button" className="btn" disabled={busy} onClick={close}>Cancel</button>
          <BusyButton className="btn danger" busy={busy} progress="Removing the workspace…" onClick={() => void remove()}>
            Remove Workspace
          </BusyButton>
        </>
      )}
    >
      <dl className="facts">
        <div>
          <dt>Workspace</dt>
          <dd>{workspace.name}</dd>
        </div>
        <div>
          <dt>Folder</dt>
          <dd className="remove-workspace-path"><bdi>{workspace.path}</bdi></dd>
        </div>
        <div>
          <dt>Machine</dt>
          <dd>{machineName}</dd>
        </div>
      </dl>
      <p className="confirmation-message">
        Wollipog stops offering this folder on {machineName}. Removing a workspace only unregisters it: the folder and
        its files stay where they are, and no sessions, worktrees or credentials are deleted.
      </p>
      {workspace.source !== "managed" && (
        <p className="facts-note">
          This workspace is set in the machine’s runner configuration. The runner remembers the removal, so it stays
          removed after a restart; the configuration file itself isn’t changed.
        </p>
      )}
      {failure && <Notice tone="danger" role="alert" title="Couldn't Remove the Workspace">{failure}</Notice>}
    </Modal>
  );
}
