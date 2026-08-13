import React, { useId, useState, type FormEvent } from "react";
import type { InstanceProfile } from "../desktop-instances.js";
import {
  normalizeRemoteInstanceOrigin,
  parseRemoteInstanceAdvanced,
  parseRemoteInstancePairingLink,
} from "../instance-pairing.js";
import { useInstances } from "../instances-context.js";
import { Modal } from "./common.js";

type RemoteInstanceDialogProps =
  | { mode: "add"; onClose: () => void }
  | { mode: "edit"; profile: InstanceProfile; onClose: () => void }
  | { mode: "repair"; profile: InstanceProfile; onClose: () => void };

function dialogTitle(props: RemoteInstanceDialogProps): string {
  if (props.mode === "add") return "Add Remote Instance";
  if (props.mode === "edit") return "Edit Instance";
  return "Re-Pair Instance";
}

function submitLabel(mode: RemoteInstanceDialogProps["mode"], busy: boolean): string {
  if (busy) {
    if (mode === "add") return "Adding…";
    if (mode === "edit") return "Saving…";
    return "Re-Pairing…";
  }
  if (mode === "add") return "Add and Switch";
  if (mode === "edit") return "Save Changes";
  return "Re-Pair";
}

export function RemoteInstanceDialog(props: RemoteInstanceDialogProps) {
  const instances = useInstances();
  const formId = `remote-instance-${useId().replace(/:/g, "")}`;
  const profile = props.mode === "add" ? null : props.profile;
  const [label, setLabel] = useState(profile?.label ?? "");
  const [origin, setOrigin] = useState(profile?.origin ?? "");
  const [pairingLink, setPairingLink] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [advanced, setAdvanced] = useState(props.mode === "edit");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestClose = () => {
    if (!busy) props.onClose();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const cleanLabel = label.trim();
    if (props.mode !== "repair" && !cleanLabel) {
      setError("Enter an instance name.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      if (props.mode === "edit") {
        const parsed = normalizeRemoteInstanceOrigin(origin);
        if (!parsed.ok) throw new Error(parsed.error.message);
        let replacementToken: string | undefined;
        if (parsed.value.httpOrigin !== props.profile.origin) {
          const replacement = parseRemoteInstancePairingLink(pairingLink);
          if (!replacement.ok) throw new Error(replacement.error.message);
          if (replacement.value.endpoint.httpOrigin !== parsed.value.httpOrigin) {
            throw new Error("The pairing link must match the new server address.");
          }
          replacementToken = replacement.value.token;
        }
        await instances.editInstance({
          profileId: props.profile.id,
          label: cleanLabel,
          origin: parsed.value.httpOrigin,
          ...(replacementToken ? { token: replacementToken } : {}),
        });
      } else {
        const parsed = advanced
          ? parseRemoteInstanceAdvanced(origin, pairingCode)
          : parseRemoteInstancePairingLink(pairingLink);
        if (!parsed.ok) throw new Error(parsed.error.message);
        if (props.mode === "repair") {
          if (parsed.value.endpoint.httpOrigin !== props.profile.origin) {
            throw new Error("This pairing link is for a different server address.");
          }
          await instances.repairInstance(props.profile.id, parsed.value.token);
        } else {
          await instances.addAndSwitch({
            label: cleanLabel,
            origin: parsed.value.endpoint.httpOrigin,
            token: parsed.value.token,
          });
        }
      }
      setPairingLink("");
      setPairingCode("");
      props.onClose();
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(false);
    }
  };

  const isEdit = props.mode === "edit";
  const normalizedEditOrigin = isEdit ? normalizeRemoteInstanceOrigin(origin) : null;
  return (
    <Modal
      title={dialogTitle(props)}
      onClose={requestClose}
      describedBy={`${formId}-intro`}
      footer={(
        <>
          <button type="button" className="btn" disabled={busy} onClick={requestClose}>Cancel</button>
          <button type="submit" className="btn primary" form={formId} disabled={busy}>
            {submitLabel(props.mode, busy)}
          </button>
        </>
      )}
    >
      <form id={formId} className="remote-instance-form" onSubmit={(event) => void submit(event)}>
        <p id={`${formId}-intro`} className="muted remote-instance-intro">
          {props.mode === "add" && "Paste a pairing link generated from the remote instance’s trusted local dashboard."}
          {props.mode === "edit" && "Update the saved name or address. Wollipog verifies that the address still belongs to the same instance."}
          {props.mode === "repair" && `Replace the saved credential for ${props.profile.label} with a newly generated pairing link.`}
        </p>
        {props.mode !== "repair" && (
          <label className="field">
            <span>Instance Name</span>
            <input
              autoFocus
              value={label}
              maxLength={100}
              disabled={busy}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="For example, Home Workstation"
            />
          </label>
        )}
        {isEdit ? (
          <>
            <label className="field">
              <span>Server Address</span>
              <input
                value={origin}
                disabled={busy}
                spellCheck={false}
                onChange={(event) => setOrigin(event.target.value)}
                placeholder="https://wollipog.example.com"
              />
            </label>
            {normalizedEditOrigin?.ok
              && normalizedEditOrigin.value.httpOrigin !== props.profile.origin && (
              <label className="field">
                <span>Pairing Link for New Address</span>
                <input
                  type="password"
                  value={pairingLink}
                  disabled={busy}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={Boolean(error)}
                  aria-describedby={error ? `${formId}-error` : undefined}
                  onChange={(event) => setPairingLink(event.target.value)}
                  placeholder="https://new-host/#pair=…"
                />
                <small>Changing the address requires a fresh pairing link so the saved credential is never sent to an unverified server.</small>
              </label>
            )}
          </>
        ) : (
          <>
            {!advanced && (
              <label className="field">
                <span>Pairing Link</span>
                <input
                  autoFocus={props.mode === "repair"}
                  type="password"
                  value={pairingLink}
                  disabled={busy}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={Boolean(error)}
                  aria-describedby={error ? `${formId}-error` : undefined}
                  onChange={(event) => setPairingLink(event.target.value)}
                  placeholder="https://host/#pair=…"
                />
              </label>
            )}
            <details
              className="remote-instance-advanced"
              open={advanced}
              onToggle={(event) => setAdvanced(event.currentTarget.open)}
            >
              <summary>Advanced Setup</summary>
              <div className="remote-instance-advanced-fields">
                <label className="field">
                  <span>Server Address</span>
                  <input
                    value={origin}
                    disabled={busy}
                    spellCheck={false}
                    onChange={(event) => setOrigin(event.target.value)}
                    placeholder="https://wollipog.example.com"
                  />
                </label>
                <label className="field">
                  <span>Pairing Code</span>
                  <input
                    type="password"
                    value={pairingCode}
                    disabled={busy}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => setPairingCode(event.target.value)}
                  />
                </label>
              </div>
            </details>
          </>
        )}
        {error && <div id={`${formId}-error`} className="form-error" role="alert">{error}</div>}
      </form>
    </Modal>
  );
}
