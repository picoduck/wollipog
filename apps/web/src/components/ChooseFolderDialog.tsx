import { useState } from "react";
import { runnerSupportsProtocol } from "@wollipog/protocol";
import { DirectoryPicker } from "./DirectoryPicker.js";
import { Modal } from "./Modal.js";

/**
 * Choose Folder (#2163, #2271, #2956): the machine's folder browser in a dialog stacked over the
 * form that asked — New Workspace and New Session. It says which machine it is browsing, and focus
 * returns to the Browse… that opened it. On a runner that cannot list folders the picker is a path
 * field, and the primary reads Use Path.
 */
export function ChooseFolderDialog({ runnerId, machineName, protocolVersion, distro, onPick, onClose, returnFocusRef }: {
  runnerId: string;
  machineName: string;
  protocolVersion: number | null | undefined;
  distro?: string;
  onPick: (path: string) => void;
  onClose: () => void;
  returnFocusRef: { current: HTMLElement | null };
}) {
  const [location, setLocation] = useState<string | null>(null);
  const browsing = runnerSupportsProtocol(protocolVersion, "directoryListing");
  return (
    <Modal
      title="Choose Folder"
      description={`On ${machineName}`}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      footer={(
        <>
          <button className="btn" type="button" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            type="button"
            disabled={location === null}
            onClick={() => { if (location !== null) onPick(location); }}
          >
            {browsing ? "Use This Folder" : "Use Path"}
          </button>
        </>
      )}
    >
      <DirectoryPicker
        runnerId={runnerId}
        machineName={machineName}
        protocolVersion={protocolVersion}
        distro={distro}
        hideActions
        onLocationChange={setLocation}
        onPick={onPick}
        onCancel={onClose}
      />
    </Modal>
  );
}
