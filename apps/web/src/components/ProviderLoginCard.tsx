import React, { useId, useRef, useState } from "react";
import type { ProviderLoginView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { accountLabelText, isPersonalIdentifier } from "../personal-identifiers.js";
import { statusMeta } from "../status-meta.js";
import { useAccountEmailPrivacy } from "../account-email-privacy.js";
import { AccountIdentifier } from "./AccountIdentifier.js";
import { providerLoginRunning, providerName } from "./AddProviderAccountDialog.js";
import { CopyButton, Spinner } from "./common.js";
import { FieldError } from "./FieldError.js";
import { ExternalLinkIcon } from "./Icons.js";
import { Notice } from "./Notice.js";
import { StatusBadge } from "./StatusBadge.js";
import { Steps } from "./Steps.js";
import { BusyButton } from "./ui/BusyButton.js";

/** The runner's failure for a new account whose identity matches an account already on the
 * Machine (`existingAccountWithSameIdentity` in provider-login.ts). */
const ALREADY_ON_MACHINE = /^This (?:Claude|Codex) account is already on this Machine\./u;

/**
 * Whether a sign-in ended because its account is already on the Machine, so the runner discarded it
 * (#2996). The runner reports no failure code for this yet, so its message is matched; older runners
 * will keep saying it this way even once a code exists.
 */
export function providerSignInAlreadyOnMachine(login: Pick<ProviderLoginView, "status" | "error">): boolean {
  return login.status === "failed" && ALREADY_ON_MACHINE.test(login.error ?? "");
}

/**
 * A running sign-in's head title when its label is an email the person hides (#2996): "Signing In to
 * Codex", with "Email hidden" as line 2, instead of a mask with nothing else to tell it apart.
 */
export function providerSignInHiddenTitle(login: ProviderLoginView, hide: boolean): string | null {
  return hide && providerLoginRunning(login) && isPersonalIdentifier(login.label)
    ? `Signing In to ${providerName(login.provider)}` : null;
}

/** The runner's reason as one sentence: its first, when it gives several. */
function firstSentence(text: string): string {
  return /^.*?[.!?](?=\s|$)/u.exec(text)?.[0] ?? text;
}

/** What starts the same sign-in again: the same account, or the same provider and label for a new one. */
export type ProviderSignInRestart = { accountId: string } | { provider: ProviderLoginView["provider"]; label: string };

/**
 * A provider sign-in's two numbered steps and its endings (docs/design-system.md §8.7, §13.2, #2996).
 * It is the shared part of every sign-in that is not the Request Card's: the Provider Accounts row
 * expands into it, and Choose Another Account shows it under its own head. Render it keyed by the
 * operation, so a typed code and any error belong to that operation alone.
 *
 * Running, step 1 opens the provider's page in a new tab and step 2 is the device code with the
 * waiting line, or the field for the code the page shows. Ended, one compact notice replaces the
 * steps: Sign-In Failed, Sign-In Timed Out, or Already on This Machine, which offers Dismiss only
 * because trying again would reach the same account. The code is never stored or echoed.
 */
export function ProviderSignIn({ runnerId, login, restart }: {
  runnerId: string;
  login: ProviderLoginView;
  /** Try Again and Start Again start this; without it, only Dismiss is offered. */
  restart?: ProviderSignInRestart;
}) {
  const api = useApi();
  const fieldId = `signin-code-${useId().replace(/:/gu, "")}`;
  const inputRef = useRef<HTMLInputElement>(null);
  // The field is uncontrolled: a controlled input mirrors what is typed into its `value` attribute,
  // and the code must never be in the DOM. Only whether there is something to submit is state.
  const [hasCode, setHasCode] = useState(false);
  const [running, setRunning] = useState<"submit" | "restart" | "dismiss" | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const provider = providerName(login.provider);

  const submit = async () => {
    const input = inputRef.current;
    const code = input?.value ?? "";
    if (running || !input || !code.trim()) return;
    setRunning("submit");
    setCodeError(null);
    try {
      await api.submitProviderLoginCode(runnerId, login.operationId, code);
      input.value = "";
      setHasCode(false);
    } catch (cause) {
      setCodeError((cause as Error).message);
      // §8.5: focus moves to the invalid field, which announces its error.
      inputRef.current?.focus();
    } finally {
      setRunning(null);
    }
  };

  /** Dismissal is the durable per-person acknowledgment (#2487): the ending stays gone after a reload. */
  const dismiss = async () => {
    if (running) return;
    setRunning("dismiss");
    setActionError(null);
    try {
      await api.dismissProviderLoginNotice(runnerId, login.operationId);
    } catch (cause) {
      setActionError((cause as Error).message);
    } finally {
      setRunning(null);
    }
  };

  const startAgain = async () => {
    if (running || !restart) return;
    setRunning("restart");
    setActionError(null);
    try {
      await api.startProviderLogin(runnerId, restart);
    } catch (cause) {
      setActionError((cause as Error).message);
      setRunning(null);
      return;
    }
    // The new sign-in replaces this ending. The control plane keeps an ending until it is dismissed,
    // so it would come back once the new one settles. If the dismissal fails, the ending keeps its
    // own Dismiss and the new sign-in runs regardless.
    if (!login.sessionId) {
      try {
        await api.dismissProviderLoginNotice(runnerId, login.operationId);
      } catch {
        // Nothing to report: the sign-in the person asked for started.
      }
    }
    setRunning(null);
  };

  if (!providerLoginRunning(login)) {
    if (login.status !== "failed" && login.status !== "timed_out") return null;
    const alreadyOnMachine = providerSignInAlreadyOnMachine(login);
    const dismissable = !login.sessionId;
    const restartLabel = login.status === "timed_out" ? "Start Again" : "Try Again";
    const actions = (
      <>
        {!alreadyOnMachine && restart && (
          <BusyButton className="btn sm" busy={running === "restart"} progress="Starting the sign-in…"
            disabled={running !== null && running !== "restart"} onClick={() => void startAgain()}>
            {restartLabel}
          </BusyButton>
        )}
        {dismissable && (
          <BusyButton className="btn sm" busy={running === "dismiss"} progress="Dismissing the sign-in…"
            disabled={running !== null && running !== "dismiss"} onClick={() => void dismiss()}>
            Dismiss
          </BusyButton>
        )}
      </>
    );
    const failure = actionError && <p className="notice-error" role="alert">{actionError}</p>;
    return (
      <div className="signin" data-provider-login-status={login.status}>
        {alreadyOnMachine ? (
          <Notice compact tone="neutral" role="status" title="Already on This Machine" actions={actions}>
            <p>This {provider} account is already on this machine, so Wollipog discarded the duplicate sign-in.</p>
            {failure}
          </Notice>
        ) : login.status === "timed_out" ? (
          <Notice compact tone="neutral" role="status" title="Sign-In Timed Out" actions={actions}>
            <p>The sign-in page wasn&apos;t completed in time.</p>
            {failure}
          </Notice>
        ) : (
          <Notice compact tone="danger" role="alert" title="Sign-In Failed" actions={actions}>
            <p>{login.error ? firstSentence(login.error) : "The sign-in didn't finish."}</p>
            {failure}
          </Notice>
        )}
      </div>
    );
  }

  if (!login.verificationUrl) {
    return (
      <div className="signin" data-provider-login-status={login.status}>
        <p className="signin-waiting"><Spinner decorative />Starting the sign-in…</p>
      </div>
    );
  }

  return (
    <div className="signin" data-provider-login-status={login.status}>
      <Steps className="signin-steps">
        <li>
          <a className="btn sm" href={login.verificationUrl} target="_blank" rel="noreferrer">
            Open {provider} Sign-In
            <ExternalLinkIcon size={14} aria-hidden="true" />
          </a>
        </li>
        {login.expectsCode ? (
          <li className="signin-step-field">
            <form className="signin-code-form" noValidate onSubmit={(event) => { event.preventDefault(); void submit(); }}>
              <div className="field">
                <label className="field-label" htmlFor={fieldId}>Paste the Code It Shows</label>
                <input
                  ref={inputRef}
                  id={fieldId}
                  type="password"
                  autoComplete="off"
                  maxLength={4_096}
                  aria-invalid={codeError ? true : undefined}
                  aria-describedby={codeError ? `${fieldId}-error` : undefined}
                  onChange={(event) => { setHasCode(event.target.value.trim() !== ""); setCodeError(null); }}
                />
                {codeError && <FieldError id={`${fieldId}-error`}>{codeError}</FieldError>}
              </div>
              <BusyButton type="submit" className="btn" busy={running === "submit"} progress="Submitting the code…"
                disabled={!hasCode}>
                Submit Code
              </BusyButton>
            </form>
          </li>
        ) : (
          <li>
            {login.userCode && (
              <span className="signin-code">
                <code>{login.userCode}</code>
                <CopyButton text={login.userCode} iconOnly ariaLabel="Copy Device Code" className="icon-btn sm" />
              </span>
            )}
            <p className="signin-waiting"><Spinner decorative />Waiting for {provider} to confirm…</p>
          </li>
        )}
      </Steps>
    </div>
  );
}

/**
 * A provider sign-in the runner is running, with a plain head of its own: the account, the Signing
 * In badge and Cancel over `ProviderSignIn` (Choose Another Account, #2208).
 *
 * `embedded` is the sign-in Request Card's body (#2198) and the authentication recovery panel's: the
 * card's facts name the account and its sentence the status, so it has no head (and no Cancel: the
 * card's Cancel Sign-In is its only button), keeps its link, device code and code field as they were,
 * and Submit Code is not a second primary.
 */
export function ProviderLoginCard({ runnerId, login, revealScope = "", embedded = false, restart }: {
  runnerId: string;
  login: ProviderLoginView;
  revealScope?: string;
  embedded?: boolean;
  /** Not embedded: what Try Again starts. */
  restart?: ProviderSignInRestart;
}) {
  const privacy = useAccountEmailPrivacy();
  const api = useApi();
  const [canceling, setCanceling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = `${accountLabelText(login.label, undefined, privacy.hide)} Provider Sign-In`;
  if (embedded) return <EmbeddedSignIn runnerId={runnerId} login={login} name={name} />;

  const running = providerLoginRunning(login);
  const hiddenTitle = providerSignInHiddenTitle(login, privacy.hide);
  const cancel = async () => {
    setCanceling(true);
    setError(null);
    try {
      await api.cancelProviderLogin(runnerId, login.operationId);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setCanceling(false);
    }
  };

  return (
    <article className="signin-card" data-provider-login-status={login.status} aria-label={name}>
      <div className="signin-head">
        <span className="signin-head-text">
          <strong className="signin-head-title">
            {hiddenTitle ?? (
              <AccountIdentifier identity={JSON.stringify([runnerId, login.accountId, login.operationId, revealScope])}
                value={login.label} label="Account Email" />
            )}
          </strong>
          <span className="signin-head-sub">{hiddenTitle ? "Email hidden" : providerName(login.provider)}</span>
        </span>
        {running && <StatusBadge meta={statusMeta("provider_account", "signing_in")} />}
        {running && (
          <BusyButton className="btn sm ghost" busy={canceling} progress="Canceling the sign-in…" onClick={() => void cancel()}>
            Cancel
          </BusyButton>
        )}
      </div>
      {error && <Notice compact tone="danger" role="alert">{error}</Notice>}
      <ProviderSignIn key={login.operationId} runnerId={runnerId} login={login} {...(restart ? { restart } : {})} />
    </article>
  );
}

/** The Request Card's and the recovery panel's sign-in body: the link, the device code and the code
 * field as they were before the shared steps (#2198). */
function EmbeddedSignIn({ runnerId, login, name }: { runnerId: string; login: ProviderLoginView; name: string }) {
  const api = useApi();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy || !code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.submitProviderLoginCode(runnerId, login.operationId, code);
      setCode("");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="provider-login-card" data-provider-login-status={login.status} data-embedded aria-label={name}>
      {login.verificationUrl && (
        <p>
          <a className="link" href={login.verificationUrl} target="_blank" rel="noreferrer">Open Provider Sign-In</a>
        </p>
      )}
      {login.userCode && (
        <div className="provider-login-device-code">
          <span>Device Code</span>
          <code>{login.userCode}</code>
        </div>
      )}
      {login.expectsCode && (
        <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <label>
            <span>Authorization Code</span>
            <input
              type="password"
              autoComplete="off"
              value={code}
              maxLength={4_096}
              onChange={(event) => setCode(event.target.value)}
            />
          </label>
          <BusyButton type="submit" className="btn sm" busy={busy} progress="Submitting the code…" disabled={!code.trim()}>
            Submit Code
          </BusyButton>
        </form>
      )}
      {login.error && <p className="form-error" role="alert">{login.error}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </article>
  );
}
