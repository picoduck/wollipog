import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  RUNNER_CAPABILITY_MIN_PROTOCOL,
  type AccessScopeChangePreview,
  type IdentityAdministrationView,
  type ProjectLocationView,
  type ProjectView,
  type ResourceOwner,
  type ResourceScope,
  type RunnerView,
} from "@wollipog/protocol";
import type { ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { Modal } from "../components/Modal.js";
import { ProjectLocationDialog } from "../components/ProjectLocationDialog.js";
import "../styles.css";

/**
 * Add Location (#2966) in a real browser, where row heights, the coarse-pointer tokens, the phone
 * sheet and which element scrolls are layout rather than numbers a DOM test supplies.
 *
 * Storefront already has one location; Studio Mac lists nine more, one of them used by Client
 * Portal and one (Marketing Site) shared only with Builders, so choosing it shows the access
 * mismatch. Build Box is offline with one folder. Query string, so every state is a clean reload:
 * `?theme=light`; `?onboarding=1` opens it as New Project's hand-off; `?update=1` is a server that
 * can't register new folders; `?machines=offline` has no machine online; `?parent=1` opens it from
 * a New Session dialog, whose phone sheet it takes over with Back.
 */

const params = new URLSearchParams(window.location.search);
document.documentElement.setAttribute("data-theme", params.get("theme") === "light" ? "light" : "dark");

const ORG = "org-1";
const scopeOf = (owner: ResourceOwner): ResourceScope => ({ organizationId: ORG, owner });
const organizationScope = scopeOf({ kind: "organization", organizationId: ORG });
const buildersScope = scopeOf({ kind: "team", teamId: "team-builders" });
const HOME = "/home/ada";

const identity: IdentityAdministrationView = {
  context: {
    userId: "user-ada", userName: "Ada", organizationId: ORG, organizationName: "Acme", role: "admin",
    deviceId: "device", localBootstrap: false,
  },
  organizations: [{ organizationId: ORG, name: "Acme", createdAt: 1 }],
  memberships: [
    { organizationId: ORG, organizationName: "Acme", userId: "user-ada", userName: "Ada", userStatus: "active", role: "admin", createdAt: 1 },
  ],
  teams: [
    { teamId: "team-builders", organizationId: ORG, name: "Builders", memberUserIds: ["user-ada", "user-ben", "user-cy"], createdAt: 1 },
  ],
};

const STUDIO_FOLDERS: Array<[id: string, name: string, scope?: ResourceScope]> = [
  ["storefront-web", "Storefront Web"],
  ["billing-service", "Billing Service"],
  ["client-portal", "Client Portal"],
  ["data-pipelines", "Data Pipelines"],
  ["design-system", "Design System"],
  ["docs-site", "Docs Site"],
  ["marketing-site", "Marketing Site", buildersScope],
  ["mobile-app", "Mobile App"],
  ["release-tools", "Release Tools"],
  ["terraform-modules", "Terraform Modules"],
];

const locationOf = (projectId: string, workspaceId: string, name: string): ProjectLocationView => ({
  id: `location-${projectId}-${workspaceId}`, projectId, runnerId: "runner-1", workspaceId, name,
  path: `${HOME}/repos/${workspaceId}`, source: "managed", availability: "available", isDefault: true,
  createdAt: 1, updatedAt: 1, scope: organizationScope, canManage: true,
});

const projectBase = (id: string, name: string, locations: ProjectLocationView[]): ProjectView => ({
  id, name, hidden: false, scope: organizationScope, canManage: true, locations,
  activeSessionCount: 0, unarchivedSessionCount: 0, totalSessionCount: 0, createdAt: 1, updatedAt: 1,
});

const onboarding = params.get("onboarding") === "1";
const initialProjects = (): ProjectView[] => [
  onboarding
    ? projectBase("acme", "Acme Storefront", [])
    : projectBase("storefront", "Storefront", [locationOf("storefront", "storefront-web", "Storefront Web")]),
  projectBase("client-portal", "Client Portal", [locationOf("client-portal", "client-portal", "Client Portal")]),
];

const machinesOffline = params.get("machines") === "offline";
const initialRunners = (): RunnerView[] => [
  {
    runnerId: "runner-1", hostname: "studio", displayName: "Studio Mac", os: "macos", version: "1",
    status: machinesOffline ? "offline" : "online", scope: organizationScope, agents: [],
    workspaces: STUDIO_FOLDERS.map(([id, name, scope]) => ({
      id, name, path: `${HOME}/repos/${id}`, scope: scope ?? organizationScope, canManage: true,
    })),
    connectedAt: 1, lastSeen: 1, protocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.directoryListing,
  },
  {
    runnerId: "runner-2", hostname: "build", displayName: "Build Box", os: "linux", version: "1",
    status: "offline", scope: organizationScope, agents: [],
    workspaces: [{ id: "infrastructure", name: "Infrastructure", path: "/srv/infrastructure", scope: organizationScope, canManage: true }],
    connectedAt: 1, lastSeen: 1, protocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.directoryListing,
  },
];

const HOME_FOLDERS = ["acme-storefront", "archive", "notes", "repos", "scratch"];
const FOLDERS: Record<string, { parent: string | null; entries: string[] }> = {
  "/": { parent: null, entries: ["home"] },
  "/home": { parent: "/", entries: ["ada"] },
  [HOME]: { parent: "/home", entries: HOME_FOLDERS },
  [`${HOME}/acme-storefront`]: { parent: HOME, entries: ["apps", "docs", "packages"] },
  [`${HOME}/repos`]: { parent: HOME, entries: STUDIO_FOLDERS.map(([id]) => id) },
};

declare global {
  interface Window {
    __ADD_LOCATION_E2E__: {
      added: Array<{ workspaceId: string; generateSetup: boolean }>;
      created: Array<{ runnerId: string; name: string; path: string; generateSetup: boolean }>;
      closed: number;
    };
  }
}
window.__ADD_LOCATION_E2E__ = { added: [], created: [], closed: 0 };

let applyAccess: (kind: "project" | "workspace", id: string, owner: ResourceOwner) => void = () => {};

const preview = (resource: "project" | "workspace", current: ResourceScope, owner: ResourceOwner): AccessScopeChangePreview => ({
  resource, resourceId: "fixture", currentScope: current, targetScope: scopeOf(owner),
  affectedProjects: [], activeSessionCount: 0, totalSessionCount: 0, sessionsToNarrow: 0,
  compatible: true, confirmationToken: "fixture-token",
});

const client = {
  getIdentity: async () => identity,
  listDirectory: async (_runnerId: string, path: string) => {
    const at = path || HOME;
    const folder = FOLDERS[at] ?? (at.startsWith(`${HOME}/`) ? { parent: at.slice(0, at.lastIndexOf("/")), entries: [] } : null);
    if (!folder) throw new Error(`cannot read directory: ${at}`);
    return {
      path: at,
      parent: folder.parent,
      entries: folder.entries.map((name) => ({ name, path: `${at === "/" ? "" : at}/${name}`, isDir: true })),
    };
  },
  previewProjectAccessScope: async (_id: string, owner: ResourceOwner) => ({ preview: preview("project", organizationScope, owner) }),
  previewWorkspaceAccessScope: async (_runnerId: string, _workspaceId: string, owner: ResourceOwner) =>
    ({ preview: preview("workspace", buildersScope, owner) }),
  updateProjectAccessScope: async (projectId: string, owner: ResourceOwner) => { applyAccess("project", projectId, owner); return {}; },
  updateWorkspaceAccessScope: async (_runnerId: string, workspaceId: string, owner: ResourceOwner) => {
    applyAccess("workspace", workspaceId, owner);
    return {};
  },
} as unknown as ApiClient;

function Harness() {
  const [projects, setProjects] = useState(initialProjects);
  const [runners, setRunners] = useState(initialRunners);
  const [open, setOpen] = useState(true);
  const parentRef = useRef<HTMLButtonElement>(null);
  // What the live snapshot does after an access change: the new access arrives with the data.
  applyAccess = (kind, id, owner) => {
    if (kind === "project") {
      setProjects((current) => current.map((item) => item.id === id ? { ...item, scope: scopeOf(owner) } : item));
    } else {
      setRunners((current) => current.map((runner) => ({
        ...runner,
        workspaces: runner.workspaces.map((workspace) => workspace.id === id ? { ...workspace, scope: scopeOf(owner) } : workspace),
      })));
    }
  };
  const project = projects[0]!;
  const dialog = open && (
    <ProjectLocationDialog
      project={project}
      projects={projects}
      runners={new Map(runners.map((runner) => [runner.runnerId, runner]))}
      boxes={new Map()}
      canCreateLocation={params.get("update") !== "1"}
      accessScopeManagementSupported
      onboarding={onboarding}
      setupFileSupported
      returnFocusRef={params.get("parent") === "1" ? parentRef : undefined}
      onClose={() => { window.__ADD_LOCATION_E2E__.closed += 1; setOpen(false); }}
      onManageConnections={() => {}}
      onAdd={async (candidate, generateSetup) => {
        window.__ADD_LOCATION_E2E__.added.push({ workspaceId: candidate.workspaceId, generateSetup });
      }}
      onCreate={async (location, generateSetup) => {
        window.__ADD_LOCATION_E2E__.created.push({ ...location, generateSetup });
      }}
    />
  );
  if (params.get("parent") !== "1") return <>{dialog}</>;
  return (
    <>
      <Modal title="New Session" onClose={() => undefined}>
        <button ref={parentRef} type="button" className="btn" onClick={() => setOpen(true)}>Add Location…</button>
      </Modal>
      {dialog}
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <ApiProvider client={client}>
    <Harness />
  </ApiProvider>,
);
