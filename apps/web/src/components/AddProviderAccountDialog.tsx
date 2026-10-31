import React, { useId, useRef, useState, type ReactNode } from "react";
import type { ProviderAccountDefinition, ProviderCredentialImportSource, ProviderLoginView } from "@wollipog/protocol";
import { useAccountEmailPrivacy } from "../account-email-privacy.js";
import { useApi } from "../api-context.js";
import { AccountIdentifier, AccountIdentifierRevealButton, useAccountIdentifierReveal } from "./AccountIdentifier.js";
import { isPersonalIdentifier } from "../personal-identifiers.js";
import { Modal } from "./common.js";
import { useFeedback } from "./FeedbackProvider.js";
import { FieldError } from "./FieldError.js";
import { Notice } from "./Notice.js";
import { BusyButton } from "./ui/BusyButton.js";
import { ChoiceList, SegmentedControl } from "./ui/ChoiceControls.js";

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

/** #3719: one existing sign-in an import can copy. `name` is the exact text the confirmation names
 * (the account's label, or the Machine's own sign-in); `masked` is what shows until account emails
 * are revealed, numbered so that hidden labels stay distinct. */
export interface ProviderCredentialImportChoice {
  key: string;
  source: ProviderCredentialImportSource;
  name: string;
  masked: string;
}

/** #3719: what Add Account can offer an Owner or Admin besides a new sign-in. Absent for anyone
 * else, who sees only the sign-in. */
export type ProviderCredentialImportOffer =
  | { available: true; sources: readonly ProviderCredentialImportChoice[] }
  | { available: false; reason: string };

/** Why a Claude sign-in can't be copied, shown where Copy Existing Sign-In would be (#3719). */
export const CLAUDE_IMPORT_UNAVAILABLE = "Copying an existing Claude sign-in isn't available, because Claude credentials can't be copied safely yet. Sign in to create the profile.";

type Method = "sign_in" | "copy";

/**
 * Add Account (#2995, docs/design-system.md §8.1, §8.5, §10.2): the provider as a segmented
 * control and a required label. A label already used by that provider's accounts on this machine,
 * or by a sign-in still running for it, is refused under the field before any request; the
 * runner's own refusals of the same kind land there too, so the client check is only a shortcut.
 * Any other failure is a danger notice above the footer. Start Sign-In stays enabled.
 *
 * An Owner or Admin may instead copy an existing Codex API-key sign-in on the same machine into
 * the new profile (#3719), after a confirmation that names the source and the new profile. Where
 * that isn't available, the dialog says why and keeps the sign-in.
 */
export function AddProviderAccountDialog({ runnerId, machineName, accounts, logins, initialProvider = "claude", importOffer, onStarted, onImported, onClose }: {
  runnerId: string;
  machineName: string;
  accounts: readonly ProviderAccountDefinition[];
  logins: readonly ProviderLoginView[];
  /** The provider selected on open; Set Up Managed Profile opens it for the refused session's (#3240). */
  initialProvider?: Provider;
  /** Owner/Admin only (#3719): copying an existing sign-in, or why it isn't available. */
  importOffer?: ProviderCredentialImportOffer;
  /** The started sign-in, which names the account it will record. */
  onStarted?: (login: ProviderLoginView) => void;
  /** The account a copied sign-in recorded. */
  onImported?: (account: { accountId: string; provider: "codex"; label: string }) => void;
  onClose: () => void;
}) {
  const api = useApi();
  const { confirm, showToast } = useFeedback();
  const privacy = useAccountEmailPrivacy();
  const ids = useId().replace(/:/g, "");
  const fieldId = `${ids}-label`;
  const helperId = `${ids}-helper`;
  const errorId = `${ids}-error`;
  const fieldRef = useRef<HTMLInputElement>(null);
  const [provider, setProvider] = useState<Provider>(initialProvider);
  const [method, setMethod] = useState<Method>("sign_in");
  const [sourceKey, setSourceKey] = useState<string | null>(importOffer?.available ? importOffer.sources[0]?.key ?? null : null);
  const [label, setLabel] = useState("");
  const [error, setError] = useState<LabelError | null>(null);
  const [failure, setFailure] = useState<{ title: string; body: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const copyOffered = provider === "codex" && importOffer?.available === true && importOffer.sources.length > 0;
  const copying = copyOffered && method === "copy";
  const source = copying ? importOffer.sources.find((choice) => choice.key === sourceKey) ?? importOffer.sources[0] : undefined;
  // A hidden email label shows numbered until the person reveals emails, so they can tell which
  // account's key and billing they are copying without exposing it before reveal (#3719).
  const sources = importOffer?.available ? importOffer.sources : [];
  const [revealed, toggleReveal] = useAccountIdentifierReveal(JSON.stringify([runnerId, sources.map((choice) => [choice.key, choice.name])]));
  const shown = (choice: ProviderCredentialImportChoice) => revealed ? choice.name : choice.masked;
  // Owners and Admins learn why copying isn't offered here; members never see it.
  const unavailable = !importOffer ? undefined
    : provider === "claude" ? CLAUDE_IMPORT_UNAVAILABLE
      : !importOffer.available ? importOffer.reason
        : importOffer.sources.length === 0 ? "There's no Codex sign-in on this machine to copy. Sign in to create the profile." : undefined;

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
    if (source) {
      // A separate, explicit authorization naming the source and the new profile (#3719).
      submittingRef.current = true;
      const approved = await confirm({
        title: "Copy Sign-In",
        message: `Only the API key is copied from ${shown(source)} into the new profile ${trimmed} on ${machineName}; ` +
          "settings, history, plugins and skills aren't. The original stays signed in, and both share one key's billing and limits.",
        detailRows: [{ label: shown(source), meta: "Copy From" }, { label: trimmed, meta: "New Profile" }],
        confirmLabel: "Copy Sign-In",
      });
      submittingRef.current = false;
      if (!approved) return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    try {
      if (source) {
        const imported = await api.importProviderCredential(runnerId, { provider: "codex", label: trimmed, source: source.source, sourceLabel: source.name });
        submittingRef.current = false;
        onImported?.({ accountId: imported.accountId, provider: "codex", label: trimmed });
        showToast("Sign-in copied to the new profile.", { tone: "success" });
      } else {
        const started = await api.startProviderLogin(runnerId, { provider, label: trimmed });
        submittingRef.current = false;
        if (started?.login) onStarted?.(started.login);
      }
      onClose();
      return;
    } catch (cause) {
      const message = (cause as Error).message;
      const mapped = runnerLabelError(message, provider, trimmed);
      if (mapped) refuse(mapped);
      else setFailure({ title: source ? "Couldn't Copy the Sign-In" : "Couldn't Start the Sign-In", body: message });
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
          <BusyButton className="btn primary" type="submit" form={`${ids}-form`} busy={submitting}
            progress={copying ? "Copying the sign-in…" : "Starting the sign-in…"}>
            {copying ? "Copy Sign-In" : "Start Sign-In"}
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
              setFailure(null);
            }}
          />
        </div>
        {copyOffered && (
          <div className="field">
            <div className="field-head"><span id={`${ids}-method`}>Sign-In Method</span></div>
            <SegmentedControl<Method>
              label="Sign-In Method"
              value={method}
              options={[{ value: "sign_in", label: "New Sign-In" }, { value: "copy", label: "Copy Existing Sign-In" }]}
              onChange={(next) => {
                setMethod(next);
                setFailure(null);
              }}
            />
          </div>
        )}
        {copying && (
          <div className="field">
            <div className="field-head">
              <span id={`${ids}-source`}>Copy From</span>
              {importOffer.sources.some((choice) => isPersonalIdentifier(choice.name)) && (
                <AccountIdentifierRevealButton label="Emails" revealed={revealed} onToggle={toggleReveal} withText />
              )}
            </div>
            <ChoiceList<string>
              label="Copy From"
              value={source?.key ?? null}
              options={importOffer.sources.map((choice) => ({ value: choice.key, label: shown(choice) }))}
              onChange={setSourceKey}
            />
            <p className="field-helper">
              Only a Codex sign-in that uses an API key can be copied. A ChatGPT sign-in can't be shared safely, so sign in for that instead.
            </p>
          </div>
        )}
        {unavailable && <p className="field-helper" role="note">{unavailable}</p>}
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
        {failure && <Notice tone="danger" role="alert" title={failure.title}>{failure.body}</Notice>}
      </form>
    </Modal>
  );
}
