import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { PROJECT_CREATION_REQUEST_WINDOW_MS, type ProjectView } from "@wollipog/protocol";
import { accessScopeChoices } from "../access-scopes.js";
import { ApiError } from "../api.js";
import { useApi } from "../api-context.js";
import { browserRandomUUID } from "../browser-crypto.js";
import { AccessScopeField, useAccessScopeIdentity } from "./AccessScopeControls.js";
import { Modal } from "./common.js";
import { FieldError } from "./FieldError.js";
import { FieldWarning } from "./FieldWarning.js";
import { Notice } from "./Notice.js";
import { BusyButton } from "./ui/BusyButton.js";

const COUNT_WORDS = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];

interface RetryableRequest {
  id: string;
  name: string;
  scopeKey: string;
  /** When the id was first sent, by the wall clock and by the monotonic one. */
  sentAt: number;
  sentAtMonotonic: number;
  honored: boolean;
  unanswered: boolean;
}

/** Try Again is withdrawn this long before the server forgets the id (#3468), so clock skew and a
 * slow request can't land a retry just past the window. */
const RETRY_SAFETY_MARGIN_MS = 60 * 60_000;

/** How much longer a retry of `request` is safe. Either clock running out ends it: the wall clock
 * keeps counting while the device sleeps, and the monotonic one ignores a clock set backward. */
function retryRemainingMs(request: RetryableRequest): number {
  const elapsed = Math.max(Date.now() - request.sentAt, performance.now() - request.sentAtMonotonic);
  return PROJECT_CREATION_REQUEST_WINDOW_MS - RETRY_SAFETY_MARGIN_MS - elapsed;
}

function retryExpired(request: RetryableRequest): boolean {
  return retryRemainingMs(request) <= 0;
}

/** The duplicate-name warning (#2965): the count and the existing project's own spelling, or null
 * when no project already uses the name. Case-insensitive, like the pickers that would show both. */
export function duplicateProjectNameWarning(name: string, projects: readonly Pick<ProjectView, "name">[]): string | null {
  const wanted = name.trim().toLocaleLowerCase();
  if (!wanted) return null;
  const matches = projects.filter((project) => project.name.trim().toLocaleLowerCase() === wanted);
  if (matches.length === 0) return null;
  const existing = matches[0]!.name.trim();
  const lead = matches.length === 1
    ? `A project is already named ${existing}.`
    : `${COUNT_WORDS[matches.length] ?? matches.length} projects are already named ${existing}.`;
  return `${lead} A unique name keeps them apart in lists.`;
}

/**
 * New Project (#2965, docs/design-system.md §7.1–§7.3, §8.1, §8.5, §13.2): one name and, where the
 * server manages access, the access the project starts with. Every trigger says "New Project", so
 * the title does too; the primary keeps the verb, Create Project.
 *
 * The form is a short one, so the primary stays enabled while the name is empty and pressing it shows
 * the field error (§8.5). A name another project already uses is a warning, never a refusal: two
 * teams may name one repository alike. A Viewer, or access levels that are loading or failed, keep
 * the primary off with the reason in the footer (§7.3). A failed request is a danger notice above the
 * footer with the server's words behind Show Details.
 *
 * Only a refusal (a 4xx answer) proves nothing was created: the server commits a project before it
 * answers. A timeout, a lost connection, a 5xx or an unreadable reply may follow a commit, and
 * nothing in the list ties a project to this request (a namesake, or a rename, would look the same).
 *
 * So every request carries a `requestId` (#3468), kept while the name and access stay the same: a
 * server that honors it answers a repeat with the first request's project instead of creating
 * another. After a lost reply the notice offers Try Again only when `retrySupported` held for every
 * send of that id and still holds: a server that ignored the id once (before an upgrade, or after a
 * downgrade) may have created a project that a retry would duplicate. The server forgets an id after
 * `PROJECT_CREATION_REQUEST_WINDOW_MS`, so the offer ends an hour before that. Otherwise, or once
 * the name or access changes, the notice says the outcome is unknown and points at the Projects
 * list. A refused retry proves nothing about the unanswered send before it, so it doesn't say
 * nothing was created.
 *
 * `stacked` is New Session's: the new project is selected there, so the description says so instead
 * of promising the folders that the Projects page's hand-off asks for next.
 */
export function CreateProjectDialog({
  onClose,
  onCreated,
  accessScopeManagementSupported,
  retrySupported = false,
  projects,
  stacked = false,
  returnFocusRef,
}: {
  onClose: () => void;
  onCreated: (project: ProjectView) => void;
  accessScopeManagementSupported: boolean;
  /** The server honors `CreateProjectRequest.requestId` (the snapshot's `idempotentProjectCreation`). */
  retrySupported?: boolean;
  /** The projects the person can see, to warn about a name already in use. */
  projects: readonly Pick<ProjectView, "name">[];
  /** Opened over New Session, which selects the project once it's created. */
  stacked?: boolean;
  /** The control that opened this dialog, for focus to return to (a button inside New Session). */
  returnFocusRef?: { current: HTMLElement | null };
}) {
  const api = useApi();
  const ids = useId();
  const nameId = `${ids}-name`;
  const helperId = `${ids}-name-helper`;
  const errorId = `${ids}-name-error`;
  const warningId = `${ids}-name-warning`;
  const reasonId = `${ids}-reason`;
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [edited, setEdited] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // `refused_retry`: a retry was refused after an earlier send of its id went unanswered.
  const [failure, setFailure] = useState<{ kind: "refused" | "refused_retry" | "unknown"; detail: string | null } | null>(null);
  // The request a repeat reuses (#3468): its id, what it asks for, when it was first sent, whether
  // every send of it reached a server that honors ids, and whether any send went unanswered.
  const request = useRef<RetryableRequest | null>(null);
  // Read when a reply is lost, since the server may have changed while the request was out.
  const retrySupportedNow = useRef(retrySupported);
  retrySupportedNow.current = retrySupported;
  // Re-renders when the open Try Again offer expires, so the notice withdraws it on time.
  const [, setExpiredAt] = useState(0);
  const [scopeKey, setScopeKey] = useState("");
  const { identity, error: identityError } = useAccessScopeIdentity(accessScopeManagementSupported);
  const scopeChoices = useMemo(() => identity ? accessScopeChoices(identity) : [], [identity]);
  useEffect(() => {
    if (!identity || scopeKey) return;
    const defaultKey = identity.context.role === "owner" || identity.context.role === "admin"
      ? `organization:${identity.context.organizationId}`
      : `user:${identity.context.userId}`;
    setScopeKey(scopeChoices.some((choice) => choice.key === defaultKey)
      ? defaultKey : scopeChoices[0]?.key ?? "");
  }, [identity, scopeChoices, scopeKey]);
  const viewer = accessScopeManagementSupported && identity?.context.role === "viewer";
  const scopesLoading = accessScopeManagementSupported && !identity && !identityError;
  const selectedScope = scopeChoices.find((choice) => choice.key === scopeKey);
  const blockedReason = !accessScopeManagementSupported ? null
    : viewer ? "Your Viewer role can't create projects."
    : identityError ? "Access levels couldn't be loaded."
    : scopesLoading ? "Checking access levels…"
    : !selectedScope ? "No access level is available to you."
    : null;
  const nameProblem = (value: string) => value.trim() ? null : "Enter a project name.";
  const duplicate = duplicateProjectNameWarning(name, projects);
  const close = () => {
    if (!busy) onClose();
  };
  const sameRequest = request.current !== null &&
    request.current.name === name.trim() && request.current.scopeKey === scopeKey;
  const canRetry = failure?.kind === "unknown" && sameRequest && request.current!.honored && retrySupported &&
    !retryExpired(request.current!);
  useEffect(() => {
    if (!canRetry) return;
    const timer = window.setTimeout(() => setExpiredAt(Date.now()), Math.max(0, retryRemainingMs(request.current!)));
    return () => window.clearTimeout(timer);
  }, [canRetry]);
  /** Create Project submits the form; Try Again calls this without an event. */
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy || blockedReason) return;
    const retrying = event === undefined;
    // A Try Again still on screen past its window (a tab asleep for a day) promises what the server
    // can no longer keep: it withdraws instead of sending.
    if (retrying && (!request.current || retryExpired(request.current))) {
      setExpiredAt(Date.now());
      nameRef.current?.focus();
      return;
    }
    const problem = nameProblem(name);
    setNameError(problem);
    setEdited(true);
    if (problem) {
      nameRef.current?.focus();
      return;
    }
    // An expired id is still reused: a server that remembers it returns its project, and one that
    // forgot it creates one as a new id would.
    const current = sameRequest ? request.current! : {
      id: browserRandomUUID(), name: name.trim(), scopeKey, honored: true, unanswered: false,
      sentAt: Date.now(), sentAtMonotonic: performance.now(),
    };
    current.honored &&= retrySupported;
    request.current = current;
    // Try Again keeps its notice, and with it the focus, until the retry settles.
    setBusy(true);
    if (!retrying) setFailure(null);
    try {
      const { project } = await api.createProject({
        name: current.name,
        ...(selectedScope ? { owner: selectedScope.owner } : {}),
        requestId: current.id,
      });
      onCreated(project);
    } catch (cause) {
      const raw = cause instanceof Error ? cause.message.trim() : String(cause).trim();
      if (cause instanceof ApiError && cause.status < 500) {
        setFailure({ kind: current.unanswered ? "refused_retry" : "refused", detail: raw || null });
        // The project that id created is gone, so the id has nothing left to protect.
        if (cause.code === "PROJECT_REQUEST_UNAVAILABLE") request.current = null;
        // A refused retry takes Try Again away; the name keeps the focus it would have dropped.
        if (retrying) nameRef.current?.focus();
        return;
      }
      current.unanswered = true;
      if (!retrySupportedNow.current) current.honored = false;
      setFailure({ kind: "unknown", detail: raw || null });
      if (retrying && !current.honored) nameRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };
  const describedBy = [nameError ? errorId : helperId, !nameError && duplicate ? warningId : null]
    .filter(Boolean).join(" ");
  return (
    <Modal
      title="New Project"
      description={stacked
        ? "It's selected for this session once it's created."
        : "Groups sessions by repository. You'll add its folders next."}
      onClose={close}
      returnFocusRef={returnFocusRef}
      footer={(
        <>
          {blockedReason && <span className="new-project-reason" id={reasonId}>{blockedReason}</span>}
          <button type="button" className="btn" onClick={close} disabled={busy}>Cancel</button>
          <BusyButton
            type="submit"
            className="btn primary"
            form="create-project-form"
            busy={busy}
            progress="Creating the project…"
            disabled={blockedReason !== null}
            aria-describedby={blockedReason ? reasonId : undefined}
          >
            Create Project
          </BusyButton>
        </>
      )}
    >
      <form id="create-project-form" className="form" noValidate onSubmit={(event) => void submit(event)}>
        {viewer && (
          <Notice tone="neutral" compact role="note">
            Your Viewer role can't create projects. Ask an admin for Operator access.
          </Notice>
        )}
        <div className="field">
          <label htmlFor={nameId}>Project Name</label>
          <input
            ref={nameRef}
            id={nameId}
            autoFocus
            value={name}
            maxLength={120}
            autoComplete="off"
            aria-invalid={nameError ? true : undefined}
            aria-describedby={describedBy}
            // Read-only rather than disabled while creating, so a name submitted with Enter keeps focus.
            readOnly={busy}
            onChange={(event) => {
              setName(event.target.value);
              setEdited(true);
              // An error showing clears as soon as the value is valid (§8.5).
              if (nameError) setNameError(nameProblem(event.target.value));
            }}
            onBlur={() => { if (edited && !busy) setNameError(nameProblem(name)); }}
          />
          {nameError
            ? <FieldError id={errorId}>{nameError}</FieldError>
            : <p className="field-helper" id={helperId}>Use a name you'll recognize in the Sessions list.</p>}
          {!nameError && duplicate && <FieldWarning id={warningId}>{duplicate}</FieldWarning>}
        </div>
        {accessScopeManagementSupported && scopeChoices.length > 0 && (
          <AccessScopeField choices={scopeChoices} value={scopeKey} onChange={setScopeKey} disabled={busy}
            label="Access" helper="Locations you add need at least this much access." />
        )}
        {scopesLoading && (
          // The Access field's place while the access levels load (§12.3).
          <div className="field" role="status">
            <span>Access</span>
            <span className="sr-only">Loading access levels…</span>
            <div className="skeleton-row new-project-access-skeleton" aria-hidden="true" />
          </div>
        )}
        {identityError && (
          <Notice tone="danger" role="alert" title="Couldn't Load Access Levels" details={identityError}>
            Wollipog needs them to choose who can use this project. Close this and try again.
          </Notice>
        )}
        {failure && (
          <Notice
            tone="danger"
            role="alert"
            title="Couldn't Create the Project"
            details={failure.detail ?? undefined}
            actions={canRetry && (
              <BusyButton className="btn sm" busy={busy} progress="Trying again…" onClick={() => void submit()}>
                Try Again
              </BusyButton>
            )}
          >
            {failure.kind === "refused" ? "Wollipog refused the request. Nothing was created."
              : failure.kind === "refused_retry"
                ? "Wollipog refused the retry, but the earlier try may have created it. Check the Projects list before trying again."
                : canRetry ? "Wollipog didn't answer, so it may have been created. Try again to finish; it won't be created twice."
                  : "Wollipog didn't answer, so it may have been created. Check the Projects list before trying again."}
          </Notice>
        )}
      </form>
    </Modal>
  );
}
