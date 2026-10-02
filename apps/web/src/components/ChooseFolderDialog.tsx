import { useState } from "react";
import { DirectoryPicker } from "./DirectoryPicker.js";
import { Modal } from "./Modal.js";

/**
 * Choose Folder (#2163, #2271): the machine's folder browser in a dialog stacked over the form that
 * asked — New Workspace and New Session. Focus returns to the Browse… that opened it.
 */
export function ChooseFolderDialog({ runnerId, protocolVersion, distro, onPick, onClose, returnFocusRef }: {
  runnerId: string;
  protocolVersion: number | null | undefined;
  distro?: string;
  onPick: (path: string) => void;
  onClose: () => void;
  returnFocusRef: { current: HTMLElement | null };
}) {
  const [location, setLocation] = useState<string | null>(null);
  return (
    <Modal
      title="Choose Folder"
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
            Use This Folder
          </button>
        </>
      )}
    >
      <DirectoryPicker
        runnerId={runnerId}
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
