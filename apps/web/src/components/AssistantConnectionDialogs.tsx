import React, { useId, useState } from "react";
import { CopyButton } from "./common.js";
import { Modal } from "./Modal.js";
import { Notice } from "./Notice.js";
import { secretValueRef } from "./ui/secret-input.js";
import { useIsMobile } from "./useIsMobile.js";

export function RenameAssistantInstallationDialog({ initial, busy, onClose, onSave }: {
  initial: string;
  busy: boolean;
  onClose(): void;
  onSave(name: string, reportError: (error: string) => void): void;
}) {
  const formId = useId();
  const [name, setName] = useState(initial);
  const [error, setError] = useState("");
  const canSave = !busy && name.trim() !== "" && name.trim() !== initial;
  return (
    <Modal title="Rename Installation" onClose={() => { if (!busy) onClose(); }}
      footer={<>
        <button className="btn" type="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="btn primary" type="submit" form={formId} disabled={!canSave}>Save</button>
      </>}>
      <form id={formId} className="form" onSubmit={event => {
        event.preventDefault();
        if (canSave) onSave(name, setError);
      }}>
        {error && <Notice tone="danger" role="alert">{error}</Notice>}
        <label className="field">
          <span>Installation Display Name</span>
          <input required maxLength={80} value={name} disabled={busy} onChange={event => setName(event.target.value)} />
        </label>
      </form>
    </Modal>
  );
}

export function AssistantCredentialDialog({ token, onClose }: { token: string; onClose(): void }) {
  const [revealed, setRevealed] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const phone = useIsMobile();

  return (
    <Modal title="Save Your Credential" onClose={onClose}
      description="Store this credential securely. It is available only until you leave this step."
      footer={<>
        <button className="btn" type="button" onClick={onClose}>Done</button>
        <CopyButton text={token} label="Copy Credential" className="btn primary" onResult={copied => setCopyFailed(!copied)} />
      </>}>
      <div className="form">
        {copyFailed && <Notice tone="danger" role="alert">Couldn't copy the credential. Choose Show Credential, then select the text and copy it manually.</Notice>}
        <label className="field">
          <span>Assistant Credential</span>
          {revealed && phone ? (
            <textarea className="assistant-credential-revealed" rows={3} autoComplete="off" spellCheck={false}
              readOnly ref={secretValueRef(token)} />
          ) : (
            <input autoComplete="off" spellCheck={false} readOnly type={revealed ? "text" : "password"} ref={secretValueRef(token)} />
          )}
        </label>
        <button className="btn assistant-credential-visibility" type="button" onClick={() => setRevealed(value => !value)}>
          {revealed ? "Hide Credential" : "Show Credential"}
        </button>
      </div>
    </Modal>
  );
}
