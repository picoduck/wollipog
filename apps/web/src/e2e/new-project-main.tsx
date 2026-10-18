import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { IdentityAdministrationView, ProjectView } from "@wollipog/protocol";
import { ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { CreateProjectDialog } from "../components/CreateProjectDialog.js";
import { Modal } from "../components/Modal.js";
import "../styles.css";

/**
 * New Project (#2965) in a real browser, where the Access list's width, the phone sheet and the
 * stacked layer are layout rather than numbers a DOM test supplies.
 *
 * Two projects are already named Docs Site, so typing it shows the duplicate warning. Query string,
 * so every state is a clean reload: `?theme=light`; `?role=viewer` is a Viewer; `?scopes=loading`
 * never answers the access levels; `?fail=refused` is a server that refuses the name; `?fail=1` loses
 * the reply, so the dialog can't tell whether the project was created; `?parent=1`
 * opens it over a New Session dialog, whose phone sheet it takes over with Back.
 */

const params = new URLSearchParams(window.location.search);
document.documentElement.setAttribute("data-theme", params.get("theme") === "light" ? "light" : "dark");

const ORG = "org-1";
const role = params.get("role") === "viewer" ? "viewer" : "admin";

const identity: IdentityAdministrationView = {
  context: {
    userId: "user-ada", userName: "Ada", organizationId: ORG, organizationName: "Acme", role,
    deviceId: "device", localBootstrap: false,
  },
  organizations: [{ organizationId: ORG, name: "Acme", createdAt: 1 }],
  memberships: [
    { organizationId: ORG, organizationName: "Acme", userId: "user-ada", userName: "Ada", userStatus: "active", role, createdAt: 1 },
    { organizationId: ORG, organizationName: "Acme", userId: "user-ben", userName: "Ben", userStatus: "active", role: "operator", createdAt: 1 },
    { organizationId: ORG, organizationName: "Acme", userId: "user-cy", userName: "Cy", userStatus: "active", role: "operator", createdAt: 1 },
  ],
  teams: [
    { teamId: "team-builders", organizationId: ORG, name: "Builders", memberUserIds: ["user-ada", "user-ben", "user-cy"], createdAt: 1 },
    { teamId: "team-docs", organizationId: ORG, name: "Docs Writers", memberUserIds: ["user-ada", "user-cy"], createdAt: 1 },
  ],
};

const project = (id: string, name: string): ProjectView => ({
  id, name, hidden: false, locations: [],
  activeSessionCount: 0, unarchivedSessionCount: 0, totalSessionCount: 0, createdAt: 1, updatedAt: 1,
});
const projects: ProjectView[] = [
  project("docs-1", "Docs Site"), project("docs-2", "docs site"), project("storefront", "Storefront"),
  project("billing", "Billing Service"),
];

declare global {
  interface Window {
    __NEW_PROJECT_E2E__: { created: unknown[]; closed: number };
  }
}
window.__NEW_PROJECT_E2E__ = { created: [], closed: 0 };

const client = {
  getIdentity: () => params.get("scopes") === "loading" ? new Promise(() => {}) : Promise.resolve(identity),
  createProject: async (request: { name: string }) => {
    if (params.get("fail") === "refused") throw new ApiError("A project name can't contain control characters.", 400);
    if (params.get("fail") === "1") throw new TypeError("Failed to fetch");
    window.__NEW_PROJECT_E2E__.created.push(request);
    return { project: project("project-new", request.name) };
  },
  projects: async () => ({ projects }),
} as unknown as ApiClient;

function Harness() {
  const [open, setOpen] = useState(true);
  const parentRef = useRef<HTMLButtonElement>(null);
  const stacked = params.get("parent") === "1";
  const dialog = open && (
    <CreateProjectDialog
      accessScopeManagementSupported
      projects={projects}
      stacked={stacked}
      returnFocusRef={stacked ? parentRef : undefined}
      onClose={() => { window.__NEW_PROJECT_E2E__.closed += 1; setOpen(false); }}
      onCreated={() => setOpen(false)}
    />
  );
  if (!stacked) return <>{dialog}</>;
  return (
    <>
      <Modal title="New Session" onClose={() => undefined}>
        <button ref={parentRef} type="button" className="btn" onClick={() => setOpen(true)}>New Project…</button>
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
