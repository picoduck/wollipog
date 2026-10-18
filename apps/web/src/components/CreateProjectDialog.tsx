import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import type { ProjectView } from "@wollipog/protocol";
import { accessScopeChoices } from "../access-scopes.js";
import { ApiError } from "../api.js";
import { useApi } from "../api-context.js";
import { AccessScopeField, useAccessScopeIdentity } from "./AccessScopeControls.js";
import { Modal } from "./common.js";
import { FieldError } from "./FieldError.js";
import { FieldWarning } from "./FieldWarning.js";
import { Notice } from "./Notice.js";
import { BusyButton } from "./ui/BusyButton.js";

const COUNT_WORDS = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];

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
 * Only a refusal (a 4xx answer) proves nothing was created: the server commits a project, with a new
 * id each time, before it answers. A timeout, a lost connection, a 5xx or an unreadable reply may
 * follow a commit, so the dialog reloads the projects and, if one with the submitted name appeared,
 * carries on as created; otherwise it says the outcome is unknown rather than inviting a duplicate.
 *
 * `stacked` is New Session's: the new project is selected there, so the description says so instead
 * of promising the folders that the Projects page's hand-off asks for next.
 */
export function CreateProjectDialog({
  onClose,
  onCreated,
  accessScopeManagementSupported,
  projects,
  stacked = false,
  returnFocusRef,
}: {
  onClose: () => void;
  onCreated: (project: ProjectView) => void;
  accessScopeManagementSupported: boolean;
  /** The projects the person can see: to warn about a name already in use, and to tell a project a
   * lost reply created from one that was already there. */
  projects: readonly ProjectView[];
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
  // The live list as of now, which may already carry a project whose create reply was lost.
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const [name, setName] = useState("");
  const [edited, setEdited] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ sentence: string; detail: string | null } | null>(null);
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
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || blockedReason) return;
    const problem = nameProblem(name);
    setNameError(problem);
    setEdited(true);
    if (problem) {
      nameRef.current?.focus();
      return;
    }
    // The name as the server stores it, and the projects that already had it.
    const storedName = name.trim().replace(/\s+/g, " ");
    const existingIds = new Set(projects.filter((project) => project.name === storedName).map((project) => project.id));
    setBusy(true);
    setFailure(null);
    try {
      const { project } = await api.createProject({
        name: name.trim(),
        ...(selectedScope ? { owner: selectedScope.owner } : {}),
      });
      onCreated(project);
    } catch (cause) {
      const raw = cause instanceof Error ? cause.message.trim() : String(cause).trim();
      if (cause instanceof ApiError && cause.status < 500) {
        setFailure({ sentence: "Wollipog refused the request. Nothing was created.", detail: raw || null });
        return;
      }
      const created = await findCreatedProject(storedName, existingIds);
      if (created) {
        onCreated(created);
        return;
      }
      setFailure({
        sentence: "Wollipog didn't answer, so it may have been created. Check the Projects list before trying again.",
        detail: raw || null,
      });
    } finally {
      setBusy(false);
    }
  };
  /** The newest project named `storedName` that wasn't there before the request, from a fresh read
   * and from the live list; null when neither shows one. */
  const findCreatedProject = async (storedName: string, existingIds: ReadonlySet<string>) => {
    let reloaded: readonly ProjectView[] = [];
    try {
      reloaded = (await api.projects()).projects;
    } catch {
      // The live list below can still show it; otherwise the notice says the outcome is unknown.
    }
    const appeared = [...reloaded, ...projectsRef.current]
      .filter((project) => project.name === storedName && !existingIds.has(project.id))
      .sort((left, right) => right.createdAt - left.createdAt);
    return appeared[0] ?? null;
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
          <Notice tone="danger" role="alert" title="Couldn't Create the Project" details={failure.detail ?? undefined}>
            {failure.sentence}
          </Notice>
        )}
      </form>
    </Modal>
  );
}
