import assert from "node:assert/strict";
import test from "node:test";
import React, { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { PROTOCOL_VERSION, type RunnerView } from "@wollipog/protocol";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { SkillBuiltInReviewDialog } from "./SkillBuiltInReviewDialog.js";
import { SkillDriftImportDialog } from "./SkillDriftImportDialog.js";
import { SkillGitImportDialog } from "./SkillGitImportDialog.js";
import { SkillMachineImportDialog } from "./SkillMachineImportDialog.js";
import { SkillOrphanImportDialog } from "./SkillOrphanImportDialog.js";
import { SkillVersionHistoryDialog } from "./SkillVersionHistoryDialog.js";

/**
 * #2129: every review dialog sends back the deployment impact its preview reported. When the server
 * refuses the accept because the skill's assignments changed since, the dialog replaces its consent
 * with the conflict, keeps its primary disabled, and Preview Again reads a fresh preview whose
 * consent names the current count; accepting that one carries the fresh impact.
 */

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
Object.defineProperty(domWindow, "matchMedia", {
  configurable: true,
  value: (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }),
});
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const document = domWindow.document as unknown as Document;
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => domWindow.setTimeout(resolve, 0)); });
};

const file = (body: string) => ({ path: "SKILL.md", encoding: "utf8" as const, content: `---\nname: code-review\n---\n${body}` });
const conflict = () => new ApiError("Assignments for this skill changed. Preview it again.", 409, "deployment_impact_changed");

/** The preview the fake server reports on each read: the first with `first` assignments, then `fresh`. */
function previews(first: number, fresh: number) {
  let reads = 0;
  return () => {
    reads++;
    return reads === 1
      ? { assignmentCount: first, deploymentImpact: "impact-1" }
      : { assignmentCount: fresh, deploymentImpact: `impact-${reads}` };
  };
}

/** Accepts the fake server records; the first is refused as a conflict. */
function accepts() {
  const sent: Array<string | undefined> = [];
  return {
    sent,
    accept(expected: string | undefined) {
      sent.push(expected);
      if (sent.length === 1) throw conflict();
    },
  };
}

function buttonNamed(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => (button.getAttribute("aria-label") ?? button.textContent?.trim()) === name);
  assert.ok(found, `a button named ${name}`);
  return found;
}

async function mount(client: ApiClient, element: ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ApiProvider client={client}><FeedbackProvider>{element}</FeedbackProvider></ApiProvider>);
  });
  await settle();
  return async () => { await act(async () => { root.unmount(); }); container.remove(); };
}

async function click(button: HTMLElement) {
  await act(async () => { button.click(); });
  await settle();
}

/**
 * From a shown preview: give the consent when there is one, accept, see the conflict instead of the
 * consent, Preview Again, and accept the fresh preview, whose consent names `fresh` assignments.
 */
async function assertConflictRoundTrip(primary: string, options: { consent: string | null; freshConsent: string }) {
  const footer = () => document.querySelector(".modal-foot")!;
  const consent = () => footer().querySelector<HTMLElement>(".review-consent");
  if (options.consent === null) assertNoDomNode(consent(), "a preview with no assignments has no consent");
  else {
    assert.equal(consent()?.textContent, options.consent);
    await click(consent()!.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
  }
  await click(buttonNamed(primary));

  const notice = footer().querySelector<HTMLElement>(".review-conflict");
  assert.ok(notice, "the conflict takes the consent's slot");
  assert.equal(notice.getAttribute("role"), "alert");
  assert.match(notice.textContent ?? "", /changed after the preview, so it wasn't deployed/);
  assertNoDomNode(consent(), "the stale consent is gone");
  assert.equal(buttonNamed(primary).disabled, true, "the stale preview cannot be accepted");
  assertNoDomNode(document.querySelector(".form-error"), "the conflict is not shown as a failure as well");

  await click(buttonNamed("Preview Again"));
  assertNoDomNode(footer().querySelector(".review-conflict"), "the fresh preview clears the conflict");
  assert.equal(consent()?.textContent, options.freshConsent, "the fresh preview's consent names the current count");
  assert.equal(consent()!.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked, false);
  assert.equal(buttonNamed(primary).disabled, true, "the fresh consent must be given again");
  await click(consent()!.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
  await click(buttonNamed(primary));
}

test("Import Edit as New Version: a conflict asks for a fresh preview, whose consent names the current count", async () => {
  const preview = previews(0, 1);
  const server = accepts();
  const copy = { name: "code-review", digest: "a".repeat(64), variant: "agent" as const };
  const client = {
    ...api,
    previewSkillDrift: async () => ({
      previewId: "review", drift: { ...copy, observedDigest: "b".repeat(64) }, files: [file("Edited")], previousFiles: [file("Library")],
      digest: "c".repeat(64), importable: true, disposition: "update" as const, publishedFromLatest: true, pinned: false, ...preview(),
    }),
    discardSkillDriftPreview: async () => undefined,
    getMachineSkillVersionPolicy: async () => ({ policy: null }),
    listSkillVersions: async () => ({ versions: [{ id: "v3", digest: copy.digest, versionNumber: 3 }], nextCursor: null }),
    importSkillDrift: async (_previewId: string, acceptUpdate: boolean, expected?: string) => {
      assert.equal(acceptUpdate, true);
      server.accept(expected);
      return { released: false, pinMoved: false } as never;
    },
  } as ApiClient;
  let imported = 0;
  const unmount = await mount(client, <SkillDriftImportDialog skillId="skill-1" runnerId="runner-1" machineLabel="Build Machine" copy={copy}
    onClose={() => undefined} onImported={async () => { imported++; }} />);
  await assertConflictRoundTrip("Import as v4", { consent: null, freshConsent: "Deploy to 1 existing assignment" });
  assert.deepEqual(server.sent, ["impact-1", "impact-2"]);
  assert.equal(imported, 1);
  await unmount();
});

test("Import Orphaned Copy: a conflict asks for a fresh preview, whose consent names the current count", async () => {
  const preview = previews(2, 3);
  const server = accepts();
  const copy = { kind: "kept_aside" as const, id: "copy-1", name: "code-review", skillId: "skill-1" };
  const client = {
    ...api,
    previewOrphanedSkillCopy: async () => ({
      previewId: "review", copy: { ...copy, observedDigest: "b".repeat(64) }, name: "code-review", files: [file("Kept")],
      previousFiles: [file("Library")], digest: "c".repeat(64), importable: true, disposition: "update" as const, ...preview(),
    }),
    discardOrphanedSkillCopyPreview: async () => undefined,
    listSkillVersions: async () => ({ versions: [{ id: "v2", digest: "a".repeat(64), versionNumber: 2 }], nextCursor: null }),
    importOrphanedSkillCopy: async (_previewId: string, acceptUpdate: boolean, expected?: string) => {
      assert.equal(acceptUpdate, true);
      server.accept(expected);
      return { released: true } as never;
    },
  } as unknown as ApiClient;
  const unmount = await mount(client, <SkillOrphanImportDialog runnerId="runner-1" machineLabel="Build Machine" copy={copy}
    onClose={() => undefined} onImported={async () => undefined} />);
  await assertConflictRoundTrip("Import as New Version",
    { consent: "Deploy to 2 existing assignments", freshConsent: "Deploy to 3 existing assignments" });
  assert.deepEqual(server.sent, ["impact-1", "impact-2"]);
  await unmount();
});

test("the built-in review: a conflict asks for a fresh review, whose consent names the current count", async () => {
  const preview = previews(2, 1);
  const server = accepts();
  const client = {
    ...api,
    getBuiltInSkillVersion: async () => ({
      kind: "update" as const, release: "1.0.0", digest: "d".repeat(64), files: [file("Release")],
      currentVersion: { id: "v1", digest: "e".repeat(64), files: [file("Local")] }, expectedLatestVersionId: "v1",
      gitAutoUpdate: false, ...preview(),
    }),
    acceptBuiltInSkillVersion: async (_id: string, body: { expectedDeploymentImpact?: string }) => {
      server.accept(body.expectedDeploymentImpact);
      return {} as never;
    },
  } as ApiClient;
  const unmount = await mount(client, <SkillBuiltInReviewDialog skillId="skill-1" skillName="code-review"
    onClose={() => undefined} onAccepted={async () => undefined} />);
  await assertConflictRoundTrip("Accept Built-In Update",
    { consent: "Deploy to 2 existing assignments", freshConsent: "Deploy to 1 existing assignment" });
  assert.deepEqual(server.sent, ["impact-1", "impact-2"]);
  await unmount();
});

test("Version History: a conflict asks for a fresh preview of the same version", async () => {
  const preview = previews(0, 0);
  const server = accepts();
  const previewed: string[] = [];
  const client = {
    ...api,
    listSkillVersions: async () => ({ versions: [
      { id: "v2", versionNumber: 2, digest: "b".repeat(64), createdAt: 2 },
      { id: "v1", versionNumber: 1, digest: "a".repeat(64), createdAt: 1 },
    ], nextCursor: null }),
    previewSkillVersion: async (_id: string, versionId: string) => {
      previewed.push(versionId);
      const { deploymentImpact } = preview();
      return { version: { id: "v1", versionNumber: 1, digest: "a".repeat(64), files: [file("Old")] },
        currentVersion: { id: "v2", versionNumber: 2, digest: "b".repeat(64), files: [file("New")] }, deploymentImpact };
    },
    restoreSkillVersion: async (_id: string, _versionId: string, _expectedLatestVersionId: string, expected?: string) => {
      server.accept(expected);
    },
  } as ApiClient;
  const unmount = await mount(client, <SkillVersionHistoryDialog skillId="skill-1" onClose={() => undefined} onRestored={async () => undefined} />);
  // The dialog opens on the version before the current one (#1984).
  const consent = "Deploy to machines that track the latest version";
  await assertConflictRoundTrip("Restore v1", { consent, freshConsent: consent });
  // Preview Again reads the same version; once restored, the dialog shows the current one.
  assert.deepEqual(previewed, ["v1", "v1", "v2"], "Preview Again reads the same version");
  assert.deepEqual(server.sent, ["impact-1", "impact-2"]);
  await unmount();
});

test("Import from Git: a conflict names the skill and previews the source again, keeping the selection", async () => {
  const preview = previews(0, 2);
  const server = accepts();
  const client = {
    ...api,
    previewGitSkills: async () => {
      const shown = preview();
      return { previewId: `preview-${shown.deploymentImpact}`, candidates: [{
        name: "code-review", path: "skills/code-review", commit: "a".repeat(40), digest: "b".repeat(64), files: [file("Upstream")],
        previousFiles: [file("Library")], source: { url: "https://github.com/team/repo.git", ref: "HEAD", subdirectory: "" },
        disposition: "update" as const, executablePaths: [], ...shown,
      }] };
    },
    discardGitSkillPreview: async () => undefined,
    importGitSkill: async (body: { expectedDeploymentImpact?: string }) => {
      server.accept(body.expectedDeploymentImpact);
      return {} as never;
    },
  } as ApiClient;
  const unmount = await mount(client, <SkillGitImportDialog onClose={() => undefined} onImported={async () => undefined}
    source={{ url: "https://github.com/team/repo.git", ref: "HEAD", subdirectory: "" }} />);
  await click(buttonNamed("Preview Skills"));
  await click(document.querySelector<HTMLInputElement>('.skills-section input[type="checkbox"]')!);
  await assertConflictRoundTrip("Import Selected", { consent: null, freshConsent: "Deploy to 2 existing assignments" });
  assert.match(document.body.textContent ?? "", /Imported: code-review/);
  assert.deepEqual(server.sent, ["impact-1", "impact-2"]);
  await unmount();
});

test("Import from Machine: a conflict reads the folder again, whose consent names the current count", async () => {
  const preview = previews(1, 2);
  const server = accepts();
  const runner: RunnerView = {
    runnerId: "runner-1", hostname: "runner-host", os: "linux", version: "1", status: "online", displayName: "Build Machine",
    agents: [{ id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex", available: true }],
    workspaces: [], connectedAt: 1, lastSeen: 1, protocolVersion: PROTOCOL_VERSION,
  };
  const candidate = { id: "opaque", name: "code-review", sourceDirectory: ".codex/skills", generation: "g" };
  const client = {
    ...api,
    discoverMachineSkills: async () => ({ discoveryId: "discovery", candidates: [candidate] }),
    discardMachineSkillDiscovery: async () => undefined,
    previewMachineSkill: async () => ({ previewId: "preview", candidate, files: [file("Machine")], previousFiles: [file("Library")],
      digest: "d", disposition: "update" as const, ...preview() }),
    importMachineSkill: async (_id: string, _previewId: string, acceptUpdate: boolean, expected?: string) => {
      assert.equal(acceptUpdate, true);
      server.accept(expected);
      return {} as never;
    },
  } as ApiClient;
  const unmount = await mount(client, <SkillMachineImportDialog runners={[runner]} libraryNames={new Set(["code-review"])}
    onClose={() => undefined} onImported={async () => undefined} />);
  await click([...document.querySelectorAll<HTMLButtonElement>(".row.row-2")].find((row) => row.textContent?.includes("code-review"))!);
  await assertConflictRoundTrip("Import as New Version",
    { consent: "Deploy to 1 existing assignment", freshConsent: "Deploy to 2 existing assignments" });
  assert.deepEqual(server.sent, ["impact-1", "impact-2"]);
  await unmount();
});
