import { useId, useRef, useState } from "react";
import type { RunnerView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { machineSettingsMutationError } from "../runners.js";
import { Modal } from "./common.js";
import { DirectoryPicker } from "./DirectoryPicker.js";
import { FieldError } from "./FieldError.js";
import { Notice } from "./Notice.js";
import { BusyButton } from "./ui/BusyButton.js";

/** The name a folder suggests: its last segment, as written. */
export function workspaceNameFromPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/u, "");
  return trimmed.split(/[\\/]/u).pop() || trimmed || "Workspace";
}

/**
 * Add Workspace (#2989, docs/design-system.md §7, §8.1, §8.5): the machine's folder browser, then
 * a Workspace Name filled from the chosen folder until the person edits it. Problems with the form
 * are field errors on submit; a request that fails is a danger notice above the footer. The new
 * row arrives with the machine's next snapshot, so the dialog only closes.
 */
export function AddWorkspaceDialog({ runner, machineName, onClose }: {
  runner: RunnerView;
  machineName: string;
  onClose: () => void;
}) {
  const api = useApi();
  const ids = useId().replace(/:/g, "");
  const nameId = `add-workspace-name-${ids}`;
  const nameErrorId = `${nameId}-error`;
  const nameHelperId = `${nameId}-helper`;
  const folderErrorId = `add-workspace-folder-error-${ids}`;
  const [folder, setFolder] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const nameRef = useRef<HTMLInputElement>(null);

  const close = () => {
    if (!busyRef.current) onClose();
  };
  // The browser's current folder is the choice; the name follows it until the person edits it.
  const folderChanged = (path: string | null) => {
    setFolder(path);
    if (path !== null) setFolderError(null);
    if (!nameEdited) {
      setName(path === null ? "" : workspaceNameFromPath(path));
      if (path !== null) setNameError(null);
    }
  };

  const submit = async () => {
    if (busyRef.current) return;
    const trimmed = name.trim();
    const nextFolderError = folder === null ? "Choose a folder." : null;
    const nextNameError = trimmed ? null : "Enter a workspace name.";
    setFolderError(nextFolderError);
    setNameError(nextNameError);
    if (nextNameError) nameRef.current?.focus();
    if (nextFolderError || nextNameError || folder === null) return;
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    try {
      await api.registerMachineWorkspace(runner.runnerId, { name: trimmed, path: folder });
      busyRef.current = false;
      onClose();
    } catch (cause) {
      busyRef.current = false;
      setFailure(machineSettingsMutationError(cause));
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Add Workspace"
      description={machineName}
      onClose={close}
      size="md"
      footer={(
        <>
          <button type="button" className="btn" disabled={busy} onClick={close}>Cancel</button>
          <BusyButton className="btn primary" type="submit" form={`add-workspace-${ids}`} busy={busy}
            progress="Adding the workspace…">
            Add Workspace
          </BusyButton>
        </>
      )}
    >
      <form
        id={`add-workspace-${ids}`}
        className="form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="field">
          <span>Folder</span>
          <DirectoryPicker
            runnerId={runner.runnerId}
            machineName={machineName}
            protocolVersion={runner.protocolVersion}
            hideActions
            disabled={busy}
            onLocationChange={folderChanged}
            onPick={folderChanged}
            onCancel={close}
          />
          {folderError && <FieldError id={folderErrorId}>{folderError}</FieldError>}
        </div>
        <div className="field">
          <div className="field-head"><label htmlFor={nameId}>Workspace Name</label></div>
          <input
            ref={nameRef}
            id={nameId}
            value={name}
            autoComplete="off"
            readOnly={busy}
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameError ? nameErrorId : nameHelperId}
            onChange={(event) => {
              setName(event.target.value);
              setNameEdited(true);
              if (event.target.value.trim()) setNameError(null);
            }}
          />
          {nameError
            ? <FieldError id={nameErrorId}>{nameError}</FieldError>
            : <p className="field-helper" id={nameHelperId}>{nameEdited
              ? "Shown wherever this workspace is listed."
              : "Filled in from the folder name."}</p>}
        </div>
        {failure && <Notice tone="danger" role="alert" title="Couldn't Add the Workspace">{failure}</Notice>}
      </form>
    </Modal>
  );
}
