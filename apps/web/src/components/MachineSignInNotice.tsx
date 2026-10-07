import React, { useId, useState, type ReactNode } from "react";
import type { ProviderLoginView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { CopyButton } from "./common.js";
import { ExternalLinkIcon } from "./Icons.js";
import { Notice } from "./Notice.js";
import { BusyButton } from "./ui/BusyButton.js";

/** A sign-in the runner is still running: the person has something to do. */
export function machineSignInPending(login: Pick<ProviderLoginView, "status">): boolean {
  return login.status === "starting" || login.status === "awaiting_code" || login.status === "waiting_for_provider";
}

function providerName(login: Pick<ProviderLoginView, "provider">): string {
  return login.provider === "claude" ? "Claude" : "Codex";
}

/** The notice's title, which is also its item in the slot's "+N More". */
export function machineSignInTitle(login: Pick<ProviderLoginView, "provider" | "status">, machine: string): string {
  const subject = `${providerName(login)} on ${machine}`;
  if (machineSignInPending(login)) return `Sign In to ${subject}`;
  return login.status === "timed_out" ? `Sign-In to ${subject} Timed Out` : `Sign-In to ${subject} Failed`;
}

function sentence(login: ProviderLoginView): string {
  if (login.status === "starting") return "Starting the sign-in…";
  if (login.status === "awaiting_code") return "Sign in on the sign-in page, then paste the authorization code it shows.";
  if (login.status === "waiting_for_provider") {
    return login.userCode ? "Open the sign-in page and enter this code:" : "Finish signing in on the sign-in page.";
  }
  if (login.error) return login.error;
  return login.status === "timed_out" ? "The sign-in page wasn't completed in time." : "The sign-in didn't finish.";
}

/**
 * A machine's provider sign-in that belongs to no session, as a notice in the Sessions list's slot
 * (docs/design-system.md §13.2, #2221). It drives the same login operation as `ProviderLoginCard`,
 * which stays as it is for its other users. A pending sign-in is a warning with the device code inline,
 * Open Sign-In Page and Cancel Sign-In, plus the authorization code field when the provider expects
 * one; a failed or timed-out one is a danger with Dismiss. The code is never stored.
 */
export function MachineSignInNotice({ runnerId, machine, login, trailing }: {
  runnerId: string;
  /** The machine's display name. */
  machine: string;
  login: ProviderLoginView;
  /** The slot's "+N More". */
  trailing?: ReactNode;
}) {
  const api = useApi();
  const codeId = `machine-sign-in-code-${useId().replace(/:/gu, "")}`;
  const [code, setCode] = useState("");
  const [running, setRunning] = useState<"submit" | "cancel" | "dismiss" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = machineSignInPending(login);
  const title = machineSignInTitle(login, machine);

  const run = async (action: "submit" | "cancel" | "dismiss", operation: () => Promise<unknown>) => {
    if (running) return;
    setRunning(action);
    setError(null);
    try {
      await operation();
      if (action === "submit") setCode("");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setRunning(null);
    }
  };
  const submit = () => {
    if (!code.trim()) return;
    void run("submit", () => api.submitProviderLoginCode(runnerId, login.operationId, code));
  };

  return (
    <Notice
      as="section"
      tone={pending ? "warning" : "danger"}
      title={title}
      ariaLabel={title}
      trailing={trailing}
      dataState={login.status}
      actions={pending ? (
        <>
          {login.verificationUrl && (
            <a className="btn sm" href={login.verificationUrl} target="_blank" rel="noreferrer">
              Open Sign-In Page
              <ExternalLinkIcon size={14} />
            </a>
          )}
          <BusyButton className="btn sm ghost" busy={running === "cancel"} progress="Canceling the sign-in…"
            disabled={running !== null && running !== "cancel"}
            onClick={() => void run("cancel", () => api.cancelProviderLogin(runnerId, login.operationId))}>
            Cancel Sign-In
          </BusyButton>
        </>
      ) : (
        <BusyButton className="btn sm ghost" busy={running === "dismiss"} progress="Dismissing the sign-in…"
          onClick={() => void run("dismiss", () => api.dismissProviderLoginNotice(runnerId, login.operationId))}>
          Dismiss
        </BusyButton>
      )}
    >
      <p className="machine-sign-in-sentence">
        <span>{sentence(login)}</span>
        {pending && login.userCode && (
          <span className="code-well machine-sign-in-code">
            <code>{login.userCode}</code>
            <CopyButton text={login.userCode} iconOnly ariaLabel="Copy Device Code" className="copy-btn icon-only-copy" />
          </span>
        )}
      </p>
      {pending && login.expectsCode && (
        <form className="machine-sign-in-form" onSubmit={(event) => { event.preventDefault(); submit(); }}>
          <label htmlFor={codeId}>Authorization Code</label>
          <input
            id={codeId}
            type="password"
            autoComplete="off"
            value={code}
            maxLength={4_096}
            onChange={(event) => setCode(event.target.value)}
          />
          <BusyButton type="submit" className="btn sm" busy={running === "submit"} progress="Submitting the code…"
            disabled={!code.trim() || (running !== null && running !== "submit")}>
            Submit Code
          </BusyButton>
        </form>
      )}
      {error && <p className="notice-error" role="alert">{error}</p>}
    </Notice>
  );
}
