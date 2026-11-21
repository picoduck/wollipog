import React, { useId, useRef, useState } from "react";
import { ANTIGRAVITY_SETUP_GUIDANCE, type AntigravitySetupView, type RunnerView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import {
  antigravityCheckFailureSentence,
  antigravityInstallFailureSentence,
  antigravityInstallStageSentence,
  antigravityTerminalSetup,
  antigravitySetupPresentation,
  antigravitySignInEnding,
  antigravitySignInRunning,
  type AntigravitySetupPresentation,
} from "../antigravity-setup.js";
import { relativeTime } from "../format.js";
import { statusMeta } from "../status-meta.js";
import { AgentIcon } from "./AgentIcon.js";
import { CopyButton, Spinner } from "./common.js";
import { FieldError } from "./FieldError.js";
import { ExternalLinkIcon } from "./Icons.js";
import { Modal } from "./Modal.js";
import { Notice } from "./Notice.js";
import { CodeWell } from "./RunnerSetupParts.js";
import { StatusBadge } from "./StatusBadge.js";
import { Steps } from "./Steps.js";
import { BusyButton } from "./ui/BusyButton.js";

const NAME = "Google Antigravity";

type Running = "check" | "start" | "submit" | "cancel" | "install" | null;

/** Google Antigravity's row in a machine's Agents section (#4780). It is setup only: Antigravity is
 * not offered in New Session yet, so the row says so instead of listing it as an agent. */
export function AntigravitySetupRow({ runner, online, machineName }: { runner: RunnerView; online: boolean; machineName: string }) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const presentation = antigravitySetupPresentation(runner, online);
  const setup = presentation.setup;
  return (
    <>
      <ul className="machine-agent-list" aria-label="Agent Setup">
        <li>
          <button type="button" className="row row-2" aria-haspopup="dialog" data-antigravity-phase={presentation.phase}
            onClick={(event) => { opener.current = event.currentTarget; setOpen(true); }}>
            <span className="row-icon"><AgentIcon driver="acp" agentName={NAME} size={16} /></span>
            <span className="row-body">
              <span className="row-line">
                <span className="row-title" title={NAME}>{NAME}</span>
                <StatusBadge meta={statusMeta("antigravitySetup", presentation.phase)} inline={presentation.phase === "ready"}
                  className="machine-agent-status" />
              </span>
              <span className="row-sub machine-agent-meta">
                <span>Setup Only</span>
                {setup && setup.status !== "checking" && <span className="machine-agent-meta-extra">Checked {relativeTime(setup.checkedAt)}</span>}
                {setup?.executable?.version && <span className="machine-agent-meta-extra">v{setup.executable.version}</span>}
                {setup?.executable?.source === "managed" && <span className="machine-agent-meta-extra">Managed</span>}
              </span>
            </span>
          </button>
        </li>
      </ul>
      {open && (
        <AntigravitySetupDialog runner={runner} presentation={presentation} machineName={machineName}
          returnFocusRef={opener} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

/** Setup on one machine: what to do next first, then the facts. The dialog follows the live report. */
export function AntigravitySetupDialog({ runner, presentation, machineName, returnFocusRef, onClose }: {
  runner: RunnerView;
  presentation: AntigravitySetupPresentation;
  machineName: string;
  returnFocusRef: { current: HTMLElement | null };
  onClose: () => void;
}) {
  const api = useApi();
  const [running, setRunning] = useState<Running>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const { phase, setup, blocked } = presentation;

  const act = async (kind: Exclude<Running, null>, work: () => Promise<unknown>) => {
    if (running) return;
    setRunning(kind);
    setActionError(null);
    try {
      await work();
    } catch (cause) {
      setActionError((cause as Error).message);
    } finally {
      setRunning(null);
    }
  };
  const disabled = blocked !== null || running !== null;
  const checkAgain = (
    <BusyButton className="btn sm" busy={running === "check"} progress="Checking…" disabled={disabled}
      title={blocked ?? undefined} onClick={() => void act("check", () => api.checkAntigravitySetup(runner.runnerId))}>
      Check Again
    </BusyButton>
  );
  const signIn = (label: string) => (
    <BusyButton className="btn sm" busy={running === "start"} progress="Starting the sign-in…" disabled={disabled}
      title={blocked ?? undefined} onClick={() => void act("start", () => api.startAntigravitySignIn(runner.runnerId))}>
      {label}
    </BusyButton>
  );
  // Install and Update (v404): an explicit person's action. Unavailable while a sign-in runs.
  const install = presentation.install;
  const signInBusy = antigravitySignInRunning(setup) || setup?.signIn?.status === "verifying";
  const installBlocked = blocked ?? (signInBusy ? "Finish or cancel the Google sign-in first." : null);
  const installButton = (label: string, primary = false) => install && !install.running ? (
    <BusyButton className={primary ? "btn sm primary" : "btn sm"} busy={running === "install"} progress="Starting…"
      disabled={installBlocked !== null || running !== null} title={installBlocked ?? undefined}
      onClick={() => void act("install", () => api.installAntigravity(runner.runnerId))}>
      {label}
    </BusyButton>
  ) : null;
  const failedUpdate = install?.failed?.keptVersion ? install.failed : undefined;
  // A first managed install that failed beside a working PATH copy: the PATH copy stays in use.
  // Without a runtime, the status notice itself reports the failure.
  const failedBeside = install?.failed && !failedUpdate && setup?.executable && phase !== "installing" ? install.failed : undefined;

  return (
    <Modal title={NAME} description={`On ${machineName}`} onClose={onClose} returnFocusRef={returnFocusRef}
      footer={<button type="button" className="btn" onClick={onClose}>Done</button>}>
      <AntigravityNotice runner={runner} presentation={presentation} checkAgain={checkAgain} signIn={signIn} installButton={installButton} />
      {failedUpdate && phase !== "updating" && (
        <Notice tone="danger" title="Update Failed" role="alert" actions={installButton("Try Again")}>
          <p>{antigravityInstallFailureSentence(failedUpdate.operation.failure)}</p>
          <p>Wollipog kept v{failedUpdate.keptVersion}, the last working version{failedUpdate.operation.targetVersion
            ? `, instead of v${failedUpdate.operation.targetVersion}` : ""}.</p>
        </Notice>
      )}
      {failedBeside && (
        <Notice tone="danger" title="Install Failed" role="alert" actions={installButton("Try Again")}>
          <p>{antigravityInstallFailureSentence(failedBeside.operation.failure)} Nothing was installed, and the copy Wollipog found keeps working.</p>
        </Notice>
      )}
      {install?.updateTo && !failedUpdate && (
        <Notice tone="info" title="Update Available" role="status" actions={installButton(`Update to v${install.updateTo}`)}>
          <p>Google released v{install.updateTo}. This machine&apos;s managed copy is v{install.activeVersion}, which stays active until the new version passes its checks.</p>
        </Notice>
      )}
      {phase === "signing_in" && setup?.signIn && (
        <AntigravitySignIn key={setup.signIn.operationId} runnerId={runner.runnerId} setup={setup}
          blocked={blocked} running={running} act={act} />
      )}
      {actionError && <p className="notice-error" role="alert">{actionError}</p>}
      <dl className="facts">
        {setup?.executable && (
          <div>
            <dt>Location</dt>
            <dd>
              <span className="connection-fact">
                <span className="connection-fact-mono">{setup.executable.path}</span>
                <CopyButton text={setup.executable.path} iconOnly ariaLabel="Copy Google Antigravity Location" className="icon-btn sm" />
              </span>
            </dd>
          </div>
        )}
        {setup?.executable && <div><dt>Version</dt><dd>{setup.executable.version ? `v${setup.executable.version}` : "Unknown"}</dd></div>}
        {setup?.executable?.source && (
          <div>
            <dt>Source</dt>
            <dd>
              {setup.executable.source === "managed"
                ? "Installed and updated by Wollipog from Connections. Google's background self-updater is off for this copy."
                : setup.managedInstall?.activeCheckFailed
                  ? "The runner user's PATH. Wollipog's managed copy didn't pass its version check, so this copy is in use."
                  : "The runner user's PATH."}
            </dd>
          </div>
        )}
        {setup?.executable?.source === "managed" && setup.managedInstall?.pathExecutable && (
          <div>
            <dt>Fallback</dt>
            <dd>
              The copy on the runner user&apos;s PATH, used if the managed copy stops working:{" "}
              <span className="connection-fact-mono">{setup.managedInstall.pathExecutable}</span>
            </dd>
          </div>
        )}
        {setup?.status === "ready" && setup.models && (
          <div><dt>Models</dt><dd>{setup.models.map((model) => model.name).join(", ")}</dd></div>
        )}
        <div>
          <dt>Sign-In</dt>
          <dd>Shared by everything that runs as this machine's runner user, because Antigravity keeps it in that user's system keyring.</dd>
        </div>
        <div><dt>Sessions</dt><dd>Not available yet. Wollipog can set up Antigravity here, but can't start Antigravity sessions.</dd></div>
        {setup && setup.status !== "checking" && <div><dt>Last Check</dt><dd>{relativeTime(setup.checkedAt)}</dd></div>}
      </dl>
    </Modal>
  );
}

function AntigravityNotice({ runner, presentation, checkAgain, signIn, installButton }: {
  runner: RunnerView;
  presentation: AntigravitySetupPresentation;
  checkAgain: React.ReactNode;
  signIn: (label: string) => React.ReactNode;
  installButton: (label: string, primary?: boolean) => React.ReactNode;
}) {
  const { phase, setup, blocked, install } = presentation;
  // A copy found on PATH works as it is; a managed copy can still be installed beside it.
  const managedOffer = install && !install.activeVersion && !install.failed && setup?.executable?.source === "path"
    ? installButton("Install Managed Copy") : null;
  const terminal = antigravityTerminalSetup(runner.os);
  const shellName = terminal.shell === "PowerShell" ? "PowerShell" : "the terminal";
  const guides = (
    <>
      <GuideLink href={ANTIGRAVITY_SETUP_GUIDANCE.installDocsUrl}>Install Guide</GuideLink>
      <GuideLink href={ANTIGRAVITY_SETUP_GUIDANCE.signInDocsUrl}>Remote Sign-In Guide</GuideLink>
    </>
  );
  const terminalSetup = (
    <>
      <CodeWell value={terminal.installCommand} name="Google Antigravity Install Command" />
      <CodeWell value={ANTIGRAVITY_SETUP_GUIDANCE.signInCommand} name="Google Antigravity Sign-In Command" />
    </>
  );
  const ending = antigravitySignInEnding(setup);
  switch (phase) {
    case "update_runner":
      return (
        <Notice tone="warning" title="Update This Runner" role="status" actions={guides}>
          <p>{blocked}</p>
          <p>Until then, install Antigravity and sign in from {shellName} on this machine, as the runner&apos;s user.</p>
          {terminalSetup}
        </Notice>
      );
    case "checking":
      return (
        <Notice tone="info" title="Checking Google Antigravity" role="status">
          <p className="signin-waiting"><Spinner decorative />Looking for Antigravity and checking this machine&apos;s sign-in…</p>
        </Notice>
      );
    case "unsupported":
      return (
        <Notice tone="neutral" title="Not Available on This Machine" role="status" actions={guides}>
          <p>Setup from Connections supports Linux and macOS machines. Install Antigravity and sign in from {shellName} on this machine instead.</p>
          {terminalSetup}
        </Notice>
      );
    case "installing":
    case "updating": {
      const operation = install?.running;
      return (
        <Notice tone="info" title={phase === "updating" ? "Updating Google Antigravity" : "Installing Google Antigravity"} role="status">
          <p className="signin-waiting"><Spinner decorative />{antigravityInstallStageSentence(operation?.stage)}</p>
          <p>
            {operation?.targetVersion ? `Version v${operation.targetVersion}. ` : ""}
            {phase === "updating" && install?.activeVersion
              ? `v${install.activeVersion} stays active until the new version passes its checks.`
              : "Wollipog checks Google's release against its published checksum and tests it before using it."}
          </p>
        </Notice>
      );
    }
    case "missing_runtime":
      if (!install) {
        return (
          <Notice tone="neutral" title="Not Installed" role="status"
            actions={<>{checkAgain}<GuideLink href={ANTIGRAVITY_SETUP_GUIDANCE.installDocsUrl}>Install Guide</GuideLink></>}>
            <p>Antigravity isn&apos;t installed for this machine&apos;s runner user. Run Google&apos;s install command in the machine&apos;s terminal as that user, then check again. Wollipog doesn&apos;t install it for you.</p>
            <CodeWell value={terminal.installCommand} name="Google Antigravity Install Command" />
          </Notice>
        );
      }
      return install.failed ? (
        <Notice tone="danger" title="Install Failed" role="alert"
          actions={<>{installButton("Try Again", true)}{checkAgain}<GuideLink href={ANTIGRAVITY_SETUP_GUIDANCE.installDocsUrl}>Install Guide</GuideLink></>}>
          <p>{antigravityInstallFailureSentence(install.failed.operation.failure)} Nothing was installed.</p>
          <p>You can also run Google&apos;s install command in the machine&apos;s terminal as the runner&apos;s user, then check again.</p>
          <CodeWell value={terminal.installCommand} name="Google Antigravity Install Command" />
        </Notice>
      ) : (
        <Notice tone="neutral" title="Not Installed" role="status"
          actions={<>{installButton("Install Google Antigravity", true)}{checkAgain}<GuideLink href={ANTIGRAVITY_SETUP_GUIDANCE.installDocsUrl}>Install Guide</GuideLink></>}>
          <p>Antigravity isn&apos;t installed for this machine&apos;s runner user. Wollipog can install Google&apos;s latest release in its own folder on the machine, without changing the user&apos;s shell or PATH.</p>
          <p>Or run Google&apos;s install command in the machine&apos;s terminal as that user, then check again.</p>
          <CodeWell value={terminal.installCommand} name="Google Antigravity Install Command" />
        </Notice>
      );
    case "sign_in_required":
      return ending ? (
        <Notice tone={ending.tone} title={ending.title} role={ending.tone === "danger" ? "alert" : "status"}
          actions={<>{signIn("Try Again")}{checkAgain}{managedOffer}</>}>
          <p>{ending.sentence}</p>
        </Notice>
      ) : (
        <Notice tone="warning" title="Sign-In Required" role="status" actions={<>{signIn("Sign In with Google")}{checkAgain}{managedOffer}</>}>
          <p>Antigravity is installed, but this machine has no Google sign-in for it, or the sign-in has expired. Sign in from this device: Wollipog runs Google&apos;s sign-in on the machine.</p>
        </Notice>
      );
    case "verification_failed":
      return (
        <Notice tone="danger" title="Check Failed" role="alert" actions={<>{checkAgain}{signIn("Sign In Again")}{managedOffer}</>}>
          <p>{setup ? antigravityCheckFailureSentence(setup) : null}</p>
          {/* The runner reports fixed sentences, never the CLI's own output, so the executable it
              checked is the one variable detail. A long path wraps at any character. */}
          {setup?.executable && (
            <p>Checked executable: <span className="connection-fact-mono">{setup.executable.path}</span></p>
          )}
          {ending && <p>{ending.sentence}</p>}
        </Notice>
      );
    case "ready":
      return (
        <Notice tone="success" title="Signed In" role="status" actions={<>{checkAgain}{managedOffer}</>}>
          <p>This machine&apos;s Google sign-in opened an Antigravity session and listed the account&apos;s models.</p>
        </Notice>
      );
    case "signing_in":
      return null;
  }
}

/** A running sign-in: open Google's page, then paste the code it shows. The field is uncontrolled so
 * the code is never in the DOM's attributes; it is sent once and cleared. */
function AntigravitySignIn({ runnerId, setup, blocked, running, act }: {
  runnerId: string;
  setup: AntigravitySetupView;
  blocked: string | null;
  running: Running;
  act: (kind: Exclude<Running, null>, work: () => Promise<unknown>) => Promise<void>;
}) {
  const api = useApi();
  const signIn = setup.signIn!;
  const fieldId = `antigravity-code-${useId().replace(/:/gu, "")}`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [hasCode, setHasCode] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  const cancel = signIn.status === "verifying" ? null : (
    <BusyButton className="btn sm" busy={running === "cancel"} progress="Canceling…"
      disabled={blocked !== null || (running !== null && running !== "cancel")} title={blocked ?? undefined}
      onClick={() => void act("cancel", () => api.cancelAntigravitySignIn(runnerId, signIn.operationId))}>
      Cancel
    </BusyButton>
  );
  // The code leaves the field the moment it is submitted: it is held only by this request, never
  // left in the field's live value while the request runs or after it fails. A failure asks for
  // the code again.
  const submit = async () => {
    const input = inputRef.current;
    const code = input?.value ?? "";
    if (running || !input || !code.trim()) return;
    input.value = "";
    setHasCode(false);
    setCodeError(null);
    await act("submit", async () => {
      try {
        await api.submitAntigravitySignInCode(runnerId, signIn.operationId, code);
      } catch (cause) {
        setCodeError(`${(cause as Error).message} Paste the code again.`);
        inputRef.current?.focus();
      }
    });
  };

  if (signIn.status !== "awaiting_code" || !signIn.verificationUrl) {
    const waiting = signIn.status === "starting" ? "Starting Google sign-in on the machine…"
      : signIn.status === "verifying" ? "Checking access with the new sign-in…"
        : "Waiting for Google to confirm the sign-in…";
    return (
      <Notice tone="info" title="Signing In" role="status" actions={cancel}>
        <p className="signin-waiting"><Spinner decorative />{waiting}</p>
      </Notice>
    );
  }
  return (
    <Notice tone="info" title="Signing In" role="status" actions={cancel}>
      {/* `.signin` is the container that stacks the code field over Submit Code when narrow. */}
      <div className="signin">
        <Steps className="signin-steps">
          <li>
            <a className="btn sm" href={signIn.verificationUrl} target="_blank" rel="noreferrer">
              Open Google Sign-In
              <ExternalLinkIcon size={14} aria-hidden="true" />
            </a>
          </li>
          <li className="signin-step-field">
            <form className="signin-code-form" noValidate onSubmit={(event) => { event.preventDefault(); void submit(); }}>
              <div className="field">
                <label className="field-label" htmlFor={fieldId}>Paste the Code Google Shows</label>
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
                disabled={!hasCode || blocked !== null}>
                Submit Code
              </BusyButton>
            </form>
          </li>
        </Steps>
      </div>
    </Notice>
  );
}

/** Google's guide, opened in a new tab, as a small secondary button beside the notice's actions. */
function GuideLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a className="btn sm" href={href} target="_blank" rel="noreferrer">
      {children}
      <ExternalLinkIcon size={14} aria-hidden="true" />
    </a>
  );
}
