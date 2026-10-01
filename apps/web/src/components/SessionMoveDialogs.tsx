import { useId, useMemo, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { runnerCapabilityRequirement, runnerSupportsProtocol, type SessionView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { shortenPath } from "../format.js";
import { viewPath } from "../navigation.js";
import { runnerDisplay } from "../runners.js";
import {
  persistProjectAssignment,
  projectMoveNotice,
  projectMovePlan,
  projectMoveRowDescription,
  projectMoveRowRefusal,
  projectTeamName,
  sessionProjectChoices,
  shouldSubmitProjectAssignment,
} from "../session-project-assignment.js";
import { useStoreActions, useStoreSelector } from "../store.js";
import { useAccessScopeIdentity } from "./AccessScopeControls.js";
import { DirectoryPicker } from "./DirectoryPicker.js";
import { PlusIcon } from "./Icons.js";
import { Modal } from "./Modal.js";
import { Notice } from "./Notice.js";
import { StatusBadge } from "./StatusBadge.js";
import { BusyButton } from "./ui/BusyButton.js";
import { ChoiceRows, type ChoiceRowOption } from "./ui/ChoiceControls.js";

type FocusTarget = { current: HTMLElement | null };

function currentBadge() {
  return <StatusBadge tone="neutral" noDot label="Current" />;
}

function useSessionMachine(session: SessionView) {
  const runner = useStoreSelector((state) => state.runners.get(session.runnerId));
  const box = useStoreSelector((state) => [...state.boxes.values()].find((candidate) => candidate.runnerId === session.runnerId));
  return { runner, name: runnerDisplay(runner, box, session.runnerId).name, online: runner?.status === "online" };
}

/**
 * Move to Project (#2163, docs/design-system.md §7.2, §7.3, §8.4, §13.2). Choosing a row only
 * selects it; the primary names what pressing it does, and an inline notice beside the choice says
 * when it adds this folder to the project or lets a team read the conversation. That notice and the
 * primary's label are the consent the separate confirmation used to ask for.
 */
export function MoveToProjectDialog({ session, onClose, returnFocusRef }: {
  session: SessionView;
  onClose: () => void;
  /** Where focus goes when the dialog closes: the menu item that opened it unmounts with its menu. */
  returnFocusRef?: FocusTarget;
}) {
  const api = useApi();
  const { navigate } = useStoreActions();
  const projects = useStoreSelector((state) => state.projects);
  const runner = useStoreSelector((state) => state.runners.get(session.runnerId));
  const choices = useMemo(() => sessionProjectChoices(session, projects.values()), [session, projects]);
  const current = session.projectId ?? "";
  const [selected, setSelected] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reasonId = useId();
  // Team names come from the identity the Access controls read; a refusal falls back to "the
  // owning team" rather than hiding the notice.
  const { identity } = useAccessScopeIdentity(choices.some((choice) => choice.audience === "team"));

  // A project that disappears while it is selected, or that can no longer take this folder (its
  // management permission was revoked), leaves nothing to move to: fall back to the current
  // assignment, which disables the primary.
  const choice = choices.find((candidate) => candidate.id === selected);
  const selectable = choice !== undefined && (choice.current || projectMoveRowRefusal(session, choice) === null);
  const effective = selected === "" || selectable ? selected : current;
  const effectiveChoice = effective === "" ? undefined : choices.find((candidate) => candidate.id === effective);
  const target = effective === "" ? undefined : projects.get(effective);
  const plan = projectMovePlan(session, target, effectiveChoice);
  const unchanged = effective === current;
  const teamName = (projectId: string) => projectTeamName(projects.get(projectId), identity?.teams);
  const folder = runner?.workspaces.find((workspace) => workspace.id === session.workspaceId)?.path
    ?? session.workspaceName ?? "this folder";
  const notice = effectiveChoice && !unchanged
    ? projectMoveNotice(plan, effectiveChoice.name, folder, teamName(effectiveChoice.id))
    : null;
  const unlisted = [...projects.values()].filter((project) => !choices.some((candidate) => candidate.id === project.id)).length;

  const move = async () => {
    const projectId = effective === "" ? null : effective;
    if (busy || unchanged || !shouldSubmitProjectAssignment(session.projectId, projectId, plan.linkLocation)) return;
    setBusy(true);
    setError(null);
    try {
      await persistProjectAssignment(api.setProject, session.id, projectId, plan.linkLocation);
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(false);
    }
  };

  const manageProjects = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onClose();
    navigate({ name: "projects" });
  };

  const options: ChoiceRowOption<string>[] = [
    {
      value: "",
      title: "No Project",
      status: current === "" ? currentBadge() : undefined,
      description: "Keep the session ungrouped.",
      disabled: busy,
    },
    ...choices.map((candidate) => {
      const refusal = projectMoveRowRefusal(session, candidate);
      return {
        value: candidate.id,
        title: candidate.name,
        status: candidate.current ? currentBadge() : undefined,
        description: projectMoveRowDescription(candidate, teamName(candidate.id)),
        disabled: busy || refusal !== null,
        disabledReason: refusal ?? undefined,
      };
    }),
  ];

  return (
    <Modal
      title="Move to Project"
      description="Files stay where they are. Only the project that lists this session changes."
      onClose={() => { if (!busy) onClose(); }}
      returnFocusRef={returnFocusRef}
      footer={(
        <>
          {unchanged && <p className="session-move-reason" id={reasonId}>Choose a different project.</p>}
          <button className="btn" type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <BusyButton
            className="btn primary"
            busy={busy}
            progress="Moving the session…"
            disabled={unchanged}
            aria-describedby={unchanged ? reasonId : undefined}
            onClick={() => void move()}
          >
            {plan.primary}
          </BusyButton>
        </>
      )}
    >
      <ChoiceRows label="Project" options={options} value={effective} onChange={setSelected} />
      {unlisted > 0 && (
        <p className="session-move-unlisted">
          Projects you can't add this folder to aren't listed.{" "}
          <a className="link" href={viewPath({ name: "projects" })} onClick={manageProjects}>Manage Projects</a>
        </p>
      )}
      {notice && <Notice tone={notice.tone} role="status">{notice.text}</Notice>}
      {error && <Notice tone="danger" role="alert">{error}</Notice>}
    </Modal>
  );
}

/**
 * Move to Workspace on control planes without projects, at compact widths and on phones (#2163):
 * the same selection model as Move to Project. New Workspace… is a body action that pushes its own
 * dialog onto the sheet, so the footer keeps Cancel and the one primary.
 */
export function MoveToWorkspaceDialog({ session, onClose, returnFocusRef }: {
  session: SessionView;
  onClose: () => void;
  returnFocusRef?: FocusTarget;
}) {
  const api = useApi();
  const machine = useSessionMachine(session);
  const workspaces = machine.runner?.workspaces ?? [];
  const current = session.workspaceId ?? "";
  const [selected, setSelected] = useState(current);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const newWorkspaceRef = useRef<HTMLButtonElement>(null);
  const reasonId = useId();
  const offlineId = useId();
  const effective = selected === "" || workspaces.some((workspace) => workspace.id === selected) ? selected : current;
  const unchanged = effective === current;
  // After New Workspace moves the session both dialogs close at once, and its own return target
  // (New Workspace… in this body) goes with this one, so it follows this dialog's.
  const moved = useRef(false);
  const createdReturnRef = useMemo<FocusTarget>(() => ({
    get current() { return moved.current ? returnFocusRef?.current ?? null : newWorkspaceRef.current; },
  }), [returnFocusRef]);

  const move = async () => {
    if (busy || unchanged) return;
    setBusy(true);
    setError(null);
    try {
      await api.setWorkspace(session.id, effective === "" ? null : effective);
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(false);
    }
  };

  const options: ChoiceRowOption<string>[] = [
    {
      value: "",
      title: "No Workspace",
      status: current === "" ? currentBadge() : undefined,
      description: "Keep the session ungrouped.",
      disabled: busy,
    },
    ...workspaces.map((workspace) => ({
      value: workspace.id,
      title: workspace.name,
      status: workspace.id === current ? currentBadge() : undefined,
      description: <span title={workspace.path}>{shortenPath(workspace.path)}</span>,
      disabled: busy,
    })),
  ];

  return (
    <>
      <Modal
        title="Move to Workspace"
        description="Files stay where they are. Only the workspace that lists this session changes."
        onClose={() => { if (!busy) onClose(); }}
        returnFocusRef={returnFocusRef}
        footer={(
          <>
            {unchanged && <p className="session-move-reason" id={reasonId}>Choose a different workspace.</p>}
            <button className="btn" type="button" onClick={onClose} disabled={busy}>Cancel</button>
            <BusyButton
              className="btn primary"
              busy={busy}
              progress="Moving the session…"
              disabled={unchanged}
              aria-describedby={unchanged ? reasonId : undefined}
              onClick={() => void move()}
            >
              Move Session
            </BusyButton>
          </>
        )}
      >
        <ChoiceRows label="Workspace" options={options} value={effective} onChange={setSelected} />
        <div className="session-move-create">
          <button
            ref={newWorkspaceRef}
            type="button"
            className="btn ghost"
            disabled={!machine.online || busy}
            aria-describedby={machine.online ? undefined : offlineId}
            onClick={() => setCreating(true)}
          >
            <PlusIcon size={16} />
            New Workspace…
          </button>
          {!machine.online && <p className="field-helper" id={offlineId}>{machine.name} is offline.</p>}
        </div>
        {error && <Notice tone="danger" role="alert">{error}</Notice>}
      </Modal>
      {creating && (
        <NewWorkspaceDialog
          session={session}
          returnFocusRef={createdReturnRef}
          onClose={() => setCreating(false)}
          onMoved={() => {
            moved.current = true;
            onClose();
          }}
        />
      )}
    </>
  );
}

/**
 * New Workspace (#2163, §7.1 md, §8.1): Name and a read-only Folder field whose Browse… stacks
 * Choose Folder above this dialog. Create and Move creates the workspace and files the session in
 * it. It replaced the form that grew inside the workspace menu.
 */
export function NewWorkspaceDialog({ session, onClose, onMoved, returnFocusRef }: {
  session: SessionView;
  onClose: () => void;
  /** The session now belongs to the new workspace. Defaults to `onClose`. */
  onMoved?: () => void;
  returnFocusRef?: FocusTarget;
}) {
  const api = useApi();
  const machine = useSessionMachine(session);
  const browseSupported = runnerSupportsProtocol(machine.runner?.protocolVersion, "directoryListing");
  // Browse in the session agent's context: a WSL-context agent must browse its distro, not the
  // runner's native host (mirrors NewSessionDialog).
  const sessionAgent = machine.runner?.agents.find((agent) => agent.id === session.agentId);
  const browseDistro = sessionAgent?.context?.kind === "wsl" ? sessionAgent.context.distro : undefined;
  const [name, setName] = useState("");
  const [folder, setFolder] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A create that succeeded before the move failed is reused on retry, not created twice.
  const created = useRef<{ name: string; path: string; id: string } | null>(null);
  const browseRef = useRef<HTMLButtonElement>(null);
  const ids = useId();
  const formId = `${ids}-form`;
  const browseReason = !machine.online
    ? `${machine.name} is offline.`
    : browseSupported ? null : runnerCapabilityRequirement(machine.runner?.protocolVersion, "directoryListing", "Directory browsing");
  const trimmed = name.trim();
  const missing = !trimmed && !folder ? "Enter a name and choose a folder."
    : !trimmed ? "Enter a name."
      : !folder ? "Choose a folder." : null;

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy || missing || !folder) return;
    setBusy(true);
    setError(null);
    try {
      const reuse = created.current?.name === trimmed && created.current.path === folder ? created.current.id : null;
      const workspaceId = reuse ?? (await api.createWorkspace(session.runnerId, { name: trimmed, path: folder })).workspace.id;
      created.current = { name: trimmed, path: folder, id: workspaceId };
      await api.setWorkspace(session.id, workspaceId);
      (onMoved ?? onClose)();
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(false);
    }
  };

  return (
    <>
      <Modal
        title="New Workspace"
        onClose={() => { if (!busy) onClose(); }}
        returnFocusRef={returnFocusRef}
        footer={(
          <>
            {missing && <p className="session-move-reason" id={`${ids}-missing`}>{missing}</p>}
            <button className="btn" type="button" onClick={onClose} disabled={busy}>Cancel</button>
            <BusyButton
              type="submit"
              form={formId}
              className="btn primary"
              busy={busy}
              progress="Creating the workspace…"
              disabled={missing !== null}
              aria-describedby={missing ? `${ids}-missing` : undefined}
            >
              Create and Move
            </BusyButton>
          </>
        )}
      >
        <form id={formId} className="form" onSubmit={(event) => void submit(event)}>
          <div className="field">
            <label className="field-label" htmlFor={`${ids}-name`}>Name</label>
            <input
              id={`${ids}-name`}
              className="input"
              value={name}
              spellCheck={false}
              placeholder="e.g. Billing Service"
              // Read-only rather than disabled while busy: Enter submits from here, and disabling
              // the focused field would drop focus on <body>, outside the dialog's Tab trap.
              readOnly={busy}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor={`${ids}-folder`}>Folder</label>
            <div className="new-workspace-folder">
              <input
                id={`${ids}-folder`}
                className="input new-workspace-folder-path"
                value={folder ?? ""}
                title={folder ?? undefined}
                readOnly
                placeholder="No folder chosen"
              />
              <button
                ref={browseRef}
                type="button"
                className="btn"
                disabled={browseReason !== null || busy}
                aria-describedby={browseReason ? `${ids}-browse` : undefined}
                onClick={() => setChoosing(true)}
              >
                Browse…
              </button>
            </div>
            {browseReason && <p className="field-helper" id={`${ids}-browse`}>{browseReason}</p>}
          </div>
        </form>
        {error && <Notice tone="danger" role="alert">{error}</Notice>}
      </Modal>
      {choosing && (
        <ChooseFolderDialog
          runnerId={session.runnerId}
          protocolVersion={machine.runner?.protocolVersion}
          distro={browseDistro}
          returnFocusRef={browseRef}
          onClose={() => setChoosing(false)}
          onPick={(path) => {
            setFolder(path);
            setChoosing(false);
          }}
        />
      )}
    </>
  );
}

/** Choose Folder: the machine's folder browser in a dialog stacked over the form that asked. */
function ChooseFolderDialog({ runnerId, protocolVersion, distro, onPick, onClose, returnFocusRef }: {
  runnerId: string;
  protocolVersion: number | null | undefined;
  distro?: string;
  onPick: (path: string) => void;
  onClose: () => void;
  returnFocusRef: FocusTarget;
}) {
  const [location, setLocation] = useState<string | null>(null);
  return (
    <Modal
      title="Choose Folder"
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      footer={(
        <>
          <button className="btn" type="button" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            type="button"
            disabled={location === null}
            onClick={() => { if (location !== null) onPick(location); }}
          >
            Use This Folder
          </button>
        </>
      )}
    >
      <DirectoryPicker
        runnerId={runnerId}
        protocolVersion={protocolVersion}
        distro={distro}
        hideActions
        onLocationChange={setLocation}
        onPick={onPick}
        onCancel={onClose}
      />
    </Modal>
  );
}
