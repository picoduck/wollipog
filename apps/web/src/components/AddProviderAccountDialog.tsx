import React, { useId, useRef, useState, type ReactNode } from "react";
import type { ProviderAccountDefinition, ProviderLoginView } from "@wollipog/protocol";
import { useAccountEmailPrivacy } from "../account-email-privacy.js";
import { useApi } from "../api-context.js";
import { AccountIdentifier } from "./AccountIdentifier.js";
import { Modal } from "./common.js";
import { FieldError } from "./FieldError.js";
import { Notice } from "./Notice.js";
import { BusyButton } from "./ui/BusyButton.js";
import { SegmentedControl } from "./ui/ChoiceControls.js";

type Provider = ProviderAccountDefinition["provider"];

export const providerName = (provider: Provider) => provider === "claude" ? "Claude" : "Codex";

/** The runner compares labels trimmed and ignoring case (`comparableLabel` in provider-login.ts). */
const comparable = (label: string) => label.trim().toLocaleLowerCase();

/** A sign-in still running: it holds its label until it settles. */
export function providerLoginRunning(login: ProviderLoginView): boolean {
  return login.status === "starting" || login.status === "awaiting_code" || login.status === "waiting_for_provider";
}

type LabelError = { kind: "empty" } | { kind: "on_machine" | "running"; provider: Provider; label: string };

/** The runner's own refusals for a new label, mapped to the field's sentences. */
function runnerLabelError(message: string, provider: Provider, label: string): LabelError | null {
  if (/account with this label is already on this Machine/iu.test(message)) return { kind: "on_machine", provider, label };
  if (/sign-in for an account with this label is already running/iu.test(message)) return { kind: "running", provider, label };
  return null;
}

/**
 * Add Account (#2995, docs/design-system.md §8.1, §8.5, §10.2): the provider as a segmented
 * control and a required label. A label already used by that provider's accounts on this machine,
 * or by a sign-in still running for it, is refused under the field before any request; the
 * runner's own refusals of the same kind land there too, so the client check is only a shortcut.
 * Any other failure is a danger notice above the footer. Start Sign-In stays enabled.
 */
export function AddProviderAccountDialog({ runnerId, machineName, accounts, logins, onClose }: {
  runnerId: string;
  machineName: string;
  accounts: readonly ProviderAccountDefinition[];
  logins: readonly ProviderLoginView[];
  onClose: () => void;
}) {
  const api = useApi();
  const privacy = useAccountEmailPrivacy();
  const ids = useId().replace(/:/g, "");
  const fieldId = `${ids}-label`;
  const helperId = `${ids}-helper`;
  const errorId = `${ids}-error`;
  const fieldRef = useRef<HTMLInputElement>(null);
  const [provider, setProvider] = useState<Provider>("claude");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<LabelError | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const close = () => {
    if (!submittingRef.current) onClose();
  };

  const refuse = (problem: LabelError) => {
    setError(problem);
    fieldRef.current?.focus();
  };

  const submit = async () => {
    if (submittingRef.current) return;
    const trimmed = label.trim();
    setFailure(null);
    if (!trimmed) return refuse({ kind: "empty" });
    const key = comparable(trimmed);
    const existing = accounts.find((account) => account.provider === provider && comparable(account.label) === key);
    if (existing) return refuse({ kind: "on_machine", provider, label: existing.label });
    // A sign-in for a new account has no account yet, but the runner holds its label until it settles.
    const known = new Set(accounts.map((account) => account.id));
    const running = logins.find((login) => providerLoginRunning(login) && !known.has(login.accountId) &&
      login.provider === provider && comparable(login.label) === key);
    if (running) return refuse({ kind: "running", provider, label: running.label });
    setError(null);
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await api.startProviderLogin(runnerId, { provider, label: trimmed });
      submittingRef.current = false;
      onClose();
      return;
    } catch (cause) {
      const message = (cause as Error).message;
      const mapped = runnerLabelError(message, provider, trimmed);
      if (mapped) refuse(mapped);
      else setFailure(message);
    }
    submittingRef.current = false;
    setSubmitting(false);
  };

  const errorText = (problem: LabelError): ReactNode => {
    if (problem.kind === "empty") return "Enter a label, such as Work or Personal.";
    const named = (
      <AccountIdentifier identity={`${runnerId}:new:${problem.label}`} value={problem.label} label="Account Email" />
    );
    return problem.kind === "on_machine"
      ? <>A {providerName(problem.provider)} account named {named} is already on this machine. Choose another label, or use Sign In Again on that account.</>
      : <>A sign-in for a {providerName(problem.provider)} account named {named} is already running.</>;
  };

  return (
    <Modal
      title="Add Account"
      description={machineName}
      onClose={close}
      footer={(
        <>
          <button type="button" className="btn" disabled={submitting} onClick={close}>Cancel</button>
          <BusyButton className="btn primary" type="submit" form={`${ids}-form`} busy={submitting} progress="Starting the sign-in…">
            Start Sign-In
          </BusyButton>
        </>
      )}
    >
      <form
        id={`${ids}-form`}
        className="form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="field">
          <div className="field-head"><span id={`${ids}-provider`}>Provider</span></div>
          <SegmentedControl<Provider>
            label="Provider"
            value={provider}
            options={[{ value: "claude", label: "Claude" }, { value: "codex", label: "Codex" }]}
            onChange={(next) => {
              setProvider(next);
              setError(null);
            }}
          />
        </div>
        <div className="field">
          <div className="field-head"><label htmlFor={fieldId}>Account Label</label></div>
          <input
            ref={fieldRef}
            id={fieldId}
            autoFocus
            maxLength={100}
            autoComplete="off"
            value={label}
            aria-required="true"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : helperId}
            readOnly={submitting}
            onChange={(event) => {
              setLabel(event.target.value);
              setError(null);
            }}
          />
          {error
            ? <FieldError id={errorId}>{errorText(error)}</FieldError>
            : (
              <p className="field-helper" id={helperId}>
                {privacy.hide
                  ? "A name such as Work or Personal stays visible. An email address is hidden until revealed."
                  : "A name such as Work or Personal stays visible. Email addresses follow Hide Account Emails in Settings."}
              </p>
            )}
        </div>
        {failure && <Notice tone="danger" role="alert" title="Couldn't Start the Sign-In">{failure}</Notice>}
      </form>
    </Modal>
  );
}
