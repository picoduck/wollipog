import React, { useEffect, useId, useState } from "react";
import type { OnboardingHealthCheck, OnboardingHealthStatus } from "../onboarding.js";
import { useApi } from "../api-context.js";
import { skillRecommended, skillsFromPayload, type SkillSummary } from "../skills.js";
import { CopyButton, Spinner } from "./common.js";
import { FieldWarning } from "./FieldWarning.js";
import { ErrorIcon, PlanPendingIcon, SuccessIcon, WarningIcon } from "./Icons.js";
import { Notice } from "./Notice.js";
import { OneLineCodeWell } from "./OneLineCodeWell.js";
import { BusyButton } from "./ui/BusyButton.js";

/**
 * The parts Install Manually and Repair Connection share (and, with #2993, Set Up This Machine): the
 * Connection Check, the credential's code wells, the setup-details load failure and the footer whose
 * Done turns on only when the runner connects.
 */

/** Built-in skills the signed-in user has neither assigned nor dismissed. Hidden when none remain,
 * and when the library cannot be read: a pointer never gets in the way of connecting a machine. */
export function OnboardingRecommendedSkills({ onOpen }: { onOpen: (skillId: string) => void }) {
  const api = useApi();
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  useEffect(() => {
    let active = true;
    api.listSkills()
      .then((payload) => { if (active) setSkills(skillsFromPayload(payload).filter(skillRecommended)); })
      .catch(() => {});
    return () => { active = false; };
  }, [api]);
  if (skills.length === 0) return null;
  return (
    <section className="onboard-recommended-skills" aria-label="Recommended Skills">
      <h3>Recommended Skills</h3>
      <p>
        Wollipog includes skills that teach agents in Wollipog sessions to use its tools. They are not on any machine
        until you assign them.
      </p>
      <ul className="onboard-recommended-skill-names">
        {skills.map((skill) => <li key={skill.id}>{skill.name}</li>)}
      </ul>
      <button type="button" className="btn sm" onClick={() => onOpen(skills[0]!.id)}>Open Skills</button>
    </section>
  );
}

/** What a screen reader hears before each check's title, since the icon is hidden. */
const STATUS_WORDS: Record<OnboardingHealthStatus, string> = {
  pass: "Passed",
  waiting: "Not started",
  pending: "Checking",
  warning: "Warning",
  fail: "Failed",
};

/** A hollow circle while the check waits for the person, a spinner only while Wollipog waits on the
 * machine, and a tone icon once it has an answer (§18). */
function CheckMark({ status }: { status: OnboardingHealthStatus }) {
  return status === "pass" ? <SuccessIcon />
    : status === "fail" ? <ErrorIcon />
      : status === "warning" ? <WarningIcon />
        : status === "pending" ? <Spinner decorative />
          : <PlanPendingIcon />;
}

export function OnboardingHealthChecklist({ health, labelledBy }: { health: OnboardingHealthCheck[]; labelledBy?: string }) {
  return (
    <ul className="connection-check" aria-labelledby={labelledBy} aria-label={labelledBy ? undefined : "Connection Check"} aria-live="polite">
      {health.map((check) => (
        // Each class written out in the className, where the stylesheet guard sees it rendered.
        <li
          key={check.id}
          className={check.status === "pass" ? "connection-check-pass"
            : check.status === "fail" ? "connection-check-fail"
              : check.status === "warning" ? "connection-check-warning"
                : check.status === "pending" ? "connection-check-pending" : "connection-check-waiting"}
        >
          <span className="connection-check-icon" aria-hidden="true"><CheckMark status={check.status} /></span>
          <div className="connection-check-text">
            <strong><span className="sr-only">{STATUS_WORDS[check.status]}: </span>{check.label}</strong>
            <span>{check.detail}</span>
            {check.command && <CodeWell value={check.command} name={`${check.label} Recovery Command`} />}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** The Connection Check section under a setup's steps. */
export function ConnectionCheck({ health }: { health: OnboardingHealthCheck[] }) {
  const headingId = useId();
  return (
    <section className="runner-setup-check" aria-labelledby={headingId}>
      <h3 id={headingId}>Connection Check</h3>
      <OnboardingHealthChecklist health={health} labelledBy={headingId} />
    </section>
  );
}

/** A command or file's contents in a wrapping code well with its icon copy button (§11.7). */
export function CodeWell({ value, name, block = false }: { value: string; name: string; block?: boolean }) {
  return (
    <div className="code-well">
      {block ? <pre>{value}</pre> : <code>{value}</code>}
      <CopyButton text={value} iconOnly ariaLabel={`Copy ${name}`} className="icon-btn sm" />
    </div>
  );
}

/** The one-time token, labelled by the file it is saved as, with the shown-once warning under it. */
export function CredentialTokenField({ token, file }: { token: string; file: string }) {
  return (
    <div className="field">
      <span className="field-label"><code>{file}</code></span>
      <OneLineCodeWell value={token} name="Runner Token" />
      <FieldWarning>Shown once. Save it now and restrict the file to the runner's account.</FieldWarning>
    </div>
  );
}

/** Issuing a credential failed: one sentence, with the server's words behind Show Details (§13.2). */
export function CredentialError({ message }: { message: string }) {
  return (
    <Notice tone="danger" role="alert" details={<div className="code-well"><pre>{message}</pre></div>}>
      Wollipog couldn't issue the credential. Try again.
    </Notice>
  );
}

/** The setup details could not be read (§12.4): the notice stands in for the whole body. */
export function SetupLoadFailure({ message, retrying, onRetry }: { message: string; retrying: boolean; onRetry: () => void }) {
  return (
    <Notice
      tone="danger"
      role="alert"
      title="Couldn't Load Setup Details"
      actions={<BusyButton className="btn sm" busy={retrying} progress="Loading the setup details again…" onClick={onRetry}>Retry</BusyButton>}
      details={<div className="code-well"><pre>{message}</pre></div>}
    >
      Wollipog couldn't read the connection details this setup needs.
    </Notice>
  );
}

/**
 * Where a setup stands, for its footer. `before`: no credential yet. `waiting`: a credential exists
 * and Wollipog waits for the runner. `connected`: the runner is online. `failed`: the setup details
 * did not load, so only Cancel is offered.
 */
export type RunnerSetupStage = "before" | "waiting" | "connected" | "failed";

/**
 * The footer (§7.3): Cancel and a Done primary that stays disabled, with its reason in the left
 * slot, until the runner connects.
 */
export function RunnerSetupFooter({ stage, beforeNote, onClose }: { stage: RunnerSetupStage; beforeNote: string; onClose: () => void }) {
  const reasonId = useId();
  if (stage === "failed") return <button type="button" className="btn" onClick={onClose}>Cancel</button>;
  const connected = stage === "connected";
  return (
    <>
      {!connected && (
        <p className="runner-setup-reason" id={reasonId}>
          {stage === "waiting" ? <><Spinner decorative />Waiting for the runner…</> : beforeNote}
        </p>
      )}
      <button type="button" className="btn" onClick={onClose}>Cancel</button>
      <button
        type="button"
        className="btn primary"
        disabled={!connected}
        aria-describedby={connected ? undefined : reasonId}
        onClick={onClose}
      >
        Done
      </button>
    </>
  );
}
