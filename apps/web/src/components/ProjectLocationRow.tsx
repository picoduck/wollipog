import { useEffect, useState, type ReactNode } from "react";
import {
  runnerCapabilityRequirement,
  runnerSupportsProtocol,
  type IdentityAdministrationView,
  type ProjectLocationView,
  type ProjectView,
  type RunnerView,
  type WorktreeSetupConfigStatus,
} from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { locationSessionCount, projectAvailabilityMeta } from "../project-management.js";
import type { RunnerDisplay } from "../runners.js";
import { AccessScopeChangeDialog, hasOtherAccessChoice } from "./AccessScopeControls.js";
import { useFeedback } from "./FeedbackProvider.js";
import { CheckIcon, ComputerIcon, ErrorIcon, FolderIcon, ServerIcon, WrenchIcon } from "./Icons.js";
import { Notice } from "./Notice.js";
import { ActionsMenu, type ActionsMenuChoice, type PageMenuAction } from "./PageHeader.js";
import { PROJECT_BUSY_REASON } from "./ProjectDetailHeader.js";
import { Spinner } from "./common.js";
import { StatusBadge } from "./StatusBadge.js";
import { useIsCompact, useIsMobile } from "./useIsMobile.js";

/** Make Default's reason on the location that already is (§9.1). */
export const ALREADY_DEFAULT = "Already the default.";

/**
 * Why a session can't start in this location, or null when it can. It follows
 * `isLaunchableProjectLocation`, and is the reason the location-bound items give (§9.1).
 */
export function locationHostReason(location: ProjectLocationView, runner: RunnerView | undefined): string | null {
  if (location.availability === "runner_removed") return "The machine was removed.";
  if (location.availability === "runner_offline" || runner?.status !== "online") return "The machine is offline.";
  if (location.availability === "workspace_missing" ||
      !runner.workspaces.some((workspace) => workspace.id === location.workspaceId)) {
    return "The machine no longer lists this folder.";
  }
  return null;
}

/** Why Reveal in File Manager is unavailable, or null. */
function revealReason(location: ProjectLocationView, runner: RunnerView | undefined): string | null {
  const host = locationHostReason(location, runner);
  if (host) return host;
  // Native Windows can't reveal a WSL path without knowing its distro.
  if (runner?.os === "windows" && location.path.startsWith("/")) return "WSL paths can't be revealed from this machine.";
  if (!runnerSupportsProtocol(runner?.protocolVersion, "hostActions")) {
    return runnerCapabilityRequirement(runner?.protocolVersion, "hostActions", "revealing files in the file manager");
  }
  return null;
}

export interface ProjectLocationMenuState {
  /** False for a viewer: the items that change the project are not offered (§3.3). */
  canManage: boolean;
  /** Under 1100px, where New Session Here leaves the row for ⋯. */
  narrow: boolean;
  /** A phone has no file manager of its own to reveal in, so Reveal is not offered. */
  phone: boolean;
  /** From `locationHostReason`. */
  hostReason: string | null;
  revealReason: string | null;
  /** Another change to the project is saving. */
  busy: boolean;
  /** Change Location Access…, with why it waits; null where it is not offered. */
  access: { reason: string | null } | null;
  /** Create Starter Setup File, while the location has no setup file; null otherwise. */
  createSetup: { reason: string | null } | null;
}

function item(label: string, onClick: PageMenuAction["onClick"], reason: string | null, extra: Partial<PageMenuAction> = {}): PageMenuAction {
  return { label, onClick, disabled: reason !== null, ...(reason ? { description: reason } : {}), ...extra };
}

/**
 * A location's ⋯ items (#2961), in order: New Session Here (under 1100px only), Reveal in File
 * Manager (not on phones), Copy Path, Make Default, Change Location Access…, Create Starter Setup
 * File, then Remove Location… last, after a separator, in danger text (§3.3). A disabled item says
 * why as its second line (§9.1). A viewer gets only the items that change nothing.
 */
export function projectLocationMenu(location: ProjectLocationView, state: ProjectLocationMenuState, actions: {
  onNewSession: () => void;
  onReveal: () => void;
  onCopyPath: () => void;
  onMakeDefault: () => void;
  onChangeAccess: () => void;
  onCreateSetup: () => void;
  onRemove: (choice: ActionsMenuChoice) => void;
}): PageMenuAction[] {
  const items: PageMenuAction[] = [];
  if (state.narrow) items.push(item("New Session Here", actions.onNewSession, state.hostReason));
  if (!state.phone) items.push(item("Reveal in File Manager", actions.onReveal, state.revealReason));
  items.push(item("Copy Path", actions.onCopyPath, null));
  if (!state.canManage) return items;
  const busy = state.busy ? PROJECT_BUSY_REASON : null;
  items.push(item("Make Default", actions.onMakeDefault, location.isDefault ? ALREADY_DEFAULT : state.hostReason ?? busy));
  if (state.access) items.push(item("Change Location Access…", actions.onChangeAccess, state.access.reason ?? busy));
  if (state.createSetup) items.push(item("Create Starter Setup File", actions.onCreateSetup, state.createSetup.reason));
  items.push(item("Remove Location…", actions.onRemove, busy, { danger: true }));
  return items;
}

/** What a location's setup status says, from the setup-file request. */
type SetupState =
  | { kind: "hidden" }
  | { kind: "update" }
  | { kind: "checking" }
  | { kind: "failed"; message: string }
  | { kind: "read"; status: WorktreeSetupConfigStatus };

/**
 * The location's setup file, read once it can be: nothing while the location can't host a session,
 * and a request to update the machine when its runner is too old to say. `reread` asks again.
 */
function useLocationSetup(project: ProjectView, location: ProjectLocationView, runner: RunnerView | undefined,
  enabled: boolean, canHost: boolean): [SetupState, () => void] {
  const api = useApi();
  const supported = runnerSupportsProtocol(runner?.protocolVersion, "worktreeSetupConfig");
  const readable = enabled && canHost && supported;
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<SetupState>({ kind: "checking" });
  useEffect(() => {
    if (!readable) return;
    let active = true;
    setResult({ kind: "checking" });
    void api.projectLocationWorktreeSetup(project.id, location.id).then((response) => {
      if (active) setResult({ kind: "read", status: response.status });
    }).catch((cause: unknown) => {
      if (active) setResult({ kind: "failed", message: cause instanceof Error ? cause.message : String(cause) });
    });
    return () => { active = false; };
  }, [api, attempt, location.id, project.id, readable]);
  const state: SetupState = !enabled || !canHost ? { kind: "hidden" } : !supported ? { kind: "update" } : result;
  return [state, () => setAttempt((current) => current + 1)];
}

/** The setup status as one meta item (§11.3), or null when there is nothing to say. */
function setupMeta(state: SetupState, machine: string): ReactNode {
  const meta = (icon: ReactNode, text: string, title?: string) => (
    <span key="setup" className="project-location-setup" title={title ?? text}>
      {icon}<span className="project-location-setup-text">{text}</span>
    </span>
  );
  switch (state.kind) {
    case "hidden": return null;
    case "update": return meta(<WrenchIcon size={14} />, `Update Wollipog on ${machine} to check setup`);
    case "checking": return meta(<Spinner decorative />, "Checking setup…");
    case "failed": return meta(<ErrorIcon size={14} />, "Couldn't check setup", state.message);
    case "read":
      return state.status.status === "absent" ? meta(<WrenchIcon size={14} />, "No setup file")
        : state.status.status === "valid" ? meta(<CheckIcon size={14} className="project-location-setup-ready" />, "Setup file ready")
          : meta(<ErrorIcon size={14} />, "Setup file has an error");
  }
}

/**
 * One project location as a two-line row (#2961, §5.2): the machine's icon; its name, Default and
 * its availability; then the machine, the path and the setup status. Trailing: the session count and
 * New Session Here from 1100px, and ⋯ for the rest. Under 1100px the path takes its own line. An
 * invalid setup file adds a danger notice under the row.
 */
export function ProjectLocationRow({
  project,
  location,
  runner,
  machine,
  setupSupported,
  accessSupported,
  identity,
  identityError,
  busy,
  onNewSession,
  onReveal,
  onCopyPath,
  onMakeDefault,
  onRemove,
  onAccessChanged,
}: {
  project: ProjectView;
  location: ProjectLocationView;
  runner: RunnerView | undefined;
  machine: RunnerDisplay;
  /** The server can read setup files. */
  setupSupported: boolean;
  /** The server manages access scopes. */
  accessSupported: boolean;
  identity: IdentityAdministrationView | null;
  identityError: string | null;
  busy: boolean;
  onNewSession: () => void;
  onReveal: () => void;
  onCopyPath: () => void;
  onMakeDefault: () => void;
  /** Called with ⋯'s choice, so the confirmation can bring the row's ⋯ back as its phone Back (§7.5). */
  onRemove: (choice: ActionsMenuChoice) => void;
  onAccessChanged: () => void;
}) {
  const api = useApi();
  const { showToast } = useFeedback();
  const phone = useIsMobile();
  const narrow = useIsCompact() || phone;
  const [changingAccess, setChangingAccess] = useState(false);
  const [creatingSetup, setCreatingSetup] = useState(false);
  const hostReason = locationHostReason(location, runner);
  const [setup, reread] = useLocationSetup(project, location, runner, setupSupported, hostReason === null);
  const canManage = project.canManage !== false;
  const count = locationSessionCount(location);

  const accessReason = identityError ? "Access controls couldn't be loaded."
    : !identity ? "Access is still loading."
      : location.canManage === false ? "You can't change this location's access."
        : location.scope && !hasOtherAccessChoice(identity, location.scope) ? "There's no other access to choose."
          : null;
  const accessOffered = accessSupported && Boolean(location.scope) && identity?.context.role !== "viewer";
  const absent = setup.kind === "read" && setup.status.status === "absent";

  const createSetup = async () => {
    setCreatingSetup(true);
    try {
      await api.generateProjectLocationWorktreeSetup(project.id, location.id);
    } catch (cause) {
      showToast("Couldn't create the setup file.", { tone: "error", detail: (cause as Error).message });
      return;
    } finally {
      setCreatingSetup(false);
    }
    showToast(`Setup file created for ${location.name}.`, { tone: "success" });
    // Read back rather than assumed, so the row says what the machine now has.
    reread();
    // Best effort: the session's setup suggestion keeps its own Dismiss.
    void api.dismissWorktreeSetupNotice(project.id).catch((cause: unknown) => {
      console.warn("Dismissing the worktree setup notice failed", cause);
    });
  };

  const menu = projectLocationMenu(location, {
    canManage,
    narrow,
    phone,
    hostReason,
    revealReason: revealReason(location, runner),
    busy,
    access: accessOffered ? { reason: accessReason } : null,
    createSetup: absent ? { reason: creatingSetup ? "Creating the setup file…" : null } : null,
  }, {
    onNewSession,
    onReveal,
    onCopyPath,
    onMakeDefault,
    onChangeAccess: () => setChangingAccess(true),
    onCreateSetup: () => void createSetup(),
    onRemove,
  });

  const machineItem = <span key="machine" className="project-location-machine">{machine.name}</span>;
  const pathItem = (
    <span key="path" className="project-location-path" title={location.path}><bdi>{location.path}</bdi></span>
  );
  const setupItem = setupMeta(setup, machine.name);
  const invalid = setup.kind === "read" && setup.status.status === "invalid" ? setup.status.error : null;

  return (
    <li className="project-location">
      <div className="row row-2">
        <span className="row-icon">{machine.kind === "ssh" ? <ServerIcon /> : <ComputerIcon />}</span>
        <span className="row-body">
          <span className="row-line">
            <span className="row-title project-location-name" title={location.name}>{location.name}</span>
            {location.isDefault && <span className="project-location-default">Default</span>}
            <StatusBadge meta={projectAvailabilityMeta(location.availability)} />
          </span>
          {/* Under 1100px the machine and setup status come first and the path wraps to its own line. */}
          <span className="row-sub project-location-meta">
            {narrow ? [machineItem, setupItem, pathItem] : [machineItem, pathItem, setupItem]}
          </span>
        </span>
        {!narrow && count !== null && (
          <span className="row-trail project-location-count">{count} Session{count === 1 ? "" : "s"}</span>
        )}
        {!narrow && hostReason === null && (
          <button type="button" className="btn sm" onClick={onNewSession}>New Session Here</button>
        )}
        <ActionsMenu size="sm" label={`${location.name} Actions`} items={menu} />
      </div>
      {invalid !== null && (
        <Notice tone="danger" compact className="project-location-notice"
          details={<div className="code-well"><code>{invalid}</code></div>}>
          {`The setup file can't be used: ${invalid.split("\n")[0]}`}
        </Notice>
      )}
      {changingAccess && identity && location.scope && (
        <AccessScopeChangeDialog
          resource={{ kind: "workspace", runnerId: location.runnerId, workspaceId: location.workspaceId, name: location.name }}
          scope={location.scope}
          identity={identity}
          onClose={() => setChangingAccess(false)}
          onUpdated={onAccessChanged}
        />
      )}
    </li>
  );
}

/**
 * No locations (#2961, §12.1): one inline row inside the Locations surface with its one action, and
 * Open Connections only while no machine is online to add a folder from.
 */
export function ProjectLocationsEmpty({ canManage, machineOnline, onAdd, onOpenConnections }: {
  canManage: boolean;
  machineOnline: boolean;
  onAdd: () => void;
  onOpenConnections: () => void;
}) {
  return (
    <div className="surface">
      <div className="row project-locations-empty">
        <span className="row-icon"><FolderIcon /></span>
        <span className="project-locations-empty-text">
          {canManage
            ? "Add the folder on one of your machines where this project's sessions run."
            : "This project has no locations yet."}
        </span>
        {canManage && <button type="button" className="btn sm" onClick={onAdd}>Add Location…</button>}
        {!machineOnline && <button type="button" className="btn sm" onClick={onOpenConnections}>Open Connections</button>}
      </div>
    </div>
  );
}
