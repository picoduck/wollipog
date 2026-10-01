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
import type { MachineSkillVersionPreview, SkillVersionPreview, SkillVersionSummary } from "../skills.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { MACHINE_VERSION_PREVIEW_DELAY_MS, SkillMachineVersionDialog } from "./SkillMachineVersionDialog.js";
import { SkillVersionHistoryDialog } from "./SkillVersionHistoryDialog.js";

/**
 * #1984: Version History and Machine Version name versions by number, read older versions as the
 * list ends, and keep each load state to itself: a failed read is replaced by a later success, and a
 * read that answers after a newer choice is dropped.
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
const wait = async (ms: number) => {
  await act(async () => { await new Promise((resolve) => domWindow.setTimeout(resolve, ms)); });
  await settle();
};
/** A promise the test settles. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const file = (body: string) => ({ path: "SKILL.md", encoding: "utf8" as const, content: body });
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const rows = () => [...dialog().querySelectorAll<HTMLButtonElement>('[aria-label="Versions"] > button')];
const radios = () => [...dialog().querySelectorAll<HTMLInputElement>('input[type="radio"]')];
const titles = () => [...dialog().querySelectorAll(".choice-row-title")].map((title) => title.textContent);
const heading = () => dialog().querySelector(".skill-review-changes-title")?.textContent ?? null;

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

async function click(element: HTMLElement) {
  await act(async () => { element.click(); });
  await settle();
}

const history = (client: ApiClient) => mount(client, <SkillVersionHistoryDialog skillId="skill-1" onClose={() => undefined} onRestored={async () => undefined} />);

test("Version History against a control plane without numbers or notes names versions by short fingerprint", async () => {
  const client = {
    ...api,
    listSkillVersions: async () => ({ versions: [
      { id: "skillv_new", digest: "b".repeat(64), createdAt: 2 },
      { id: "skillv_old", digest: "a".repeat(64), createdAt: 1 },
    ], nextCursor: null }),
    previewSkillVersion: async (): Promise<SkillVersionPreview> => ({
      version: { id: "skillv_old", digest: "a".repeat(64), createdAt: 1, files: [file("Old")] },
      currentVersion: { id: "skillv_new", digest: "b".repeat(64), files: [file("New")] },
    }),
  } as ApiClient;
  const unmount = await history(client);
  assert.deepEqual(rows().map((row) => row.querySelector(".row-title")!.textContent), ["b".repeat(12), "a".repeat(12)]);
  // Without notes there is no second line, rather than a "No note" the server never said.
  assert.equal(dialog().querySelectorAll(".row-sub").length, 0);
  assert.equal(heading(), `Changes If You Restore ${"a".repeat(12)}`);
  assert.doesNotMatch(dialog().textContent!, /skillv_|[0-9a-f]{64}/);
  await unmount();
});

test("Version History: a failed list is a notice whose Retry replaces it, and older pages load without an observer", async () => {
  let calls = 0;
  const pages: Record<string, { versions: SkillVersionSummary[]; nextCursor: string | null }> = {
    first: { versions: [{ id: "skillv_3", versionNumber: 3, digest: "c", note: "Third" }, { id: "skillv_2", versionNumber: 2, digest: "b", note: null }], nextCursor: "skillv_2" },
    skillv_2: { versions: [{ id: "skillv_1", versionNumber: 1, digest: "a", note: "First" }], nextCursor: null },
  };
  const client = {
    ...api,
    listSkillVersions: async (_id: string, before?: string) => {
      calls++;
      if (calls === 1) throw new Error("The library is unavailable.");
      return pages[before ?? "first"]!;
    },
    previewSkillVersion: async (_id: string, versionId: string): Promise<SkillVersionPreview> => ({
      version: { id: versionId, versionNumber: Number(versionId.slice(7)), digest: "x", files: [file(versionId)] },
      currentVersion: { id: "skillv_3", versionNumber: 3, digest: "c", files: [file("current")] },
    }),
  } as ApiClient;
  const unmount = await history(client);
  assert.match(dialog().textContent!, /Couldn't Load Versions/);
  assert.equal(rows().length, 0);
  await click([...dialog().querySelectorAll("button")].find((button) => button.textContent === "Retry")!);
  assert.doesNotMatch(dialog().textContent!, /Couldn't Load Versions/);
  // happy-dom has no IntersectionObserver, so every older page is read in turn.
  assert.deepEqual(rows().map((row) => row.querySelector(".row-title")!.textContent), ["v3", "v2", "v1"]);
  assert.deepEqual(rows().map((row) => row.querySelector(".row-sub")!.textContent), ["Third", "No note", "First"]);
  assertNoDomNode(dialog().querySelector(".skill-version-list-end"), "every page was read, so the list has no end marker");
  await unmount();
});

test("Version History: a preview that answers after another version was chosen is dropped", async () => {
  const slow = deferred<SkillVersionPreview>();
  const preview = (id: string, number: number): SkillVersionPreview => ({
    version: { id, versionNumber: number, digest: id, files: [file(id)] },
    currentVersion: { id: "skillv_3", versionNumber: 3, digest: "skillv_3", files: [file("current")] },
  });
  const client = {
    ...api,
    listSkillVersions: async () => ({ versions: [
      { id: "skillv_3", versionNumber: 3, digest: "c" }, { id: "skillv_2", versionNumber: 2, digest: "b" }, { id: "skillv_1", versionNumber: 1, digest: "a" },
    ], nextCursor: null }),
    previewSkillVersion: (_id: string, versionId: string) => versionId === "skillv_2" ? slow.promise : Promise.resolve(preview(versionId, 1)),
  } as ApiClient;
  const unmount = await history(client);
  // The dialog opened on v2, whose read is still out; choose v1 meanwhile.
  assert.equal(rows()[1]!.getAttribute("aria-current"), "true");
  await click(rows()[2]!);
  assert.equal(heading(), "Changes If You Restore v1");
  await act(async () => { slow.resolve(preview("skillv_2", 2)); });
  await settle();
  assert.equal(heading(), "Changes If You Restore v1");
  assert.match(dialog().querySelector(".skill-diff")!.textContent!, /skillv_1/);
  await unmount();
});

test("Version History: a restore refused because the library changed reads the list and the version again", async () => {
  let latest = "skillv_3";
  const previewed: string[] = [];
  const restores: string[] = [];
  const client = {
    ...api,
    listSkillVersions: async () => ({ versions: [
      ...(latest === "skillv_4" ? [{ id: "skillv_4", versionNumber: 4, digest: "d", note: "Someone else's edit" }] : []),
      { id: "skillv_3", versionNumber: 3, digest: "c" }, { id: "skillv_2", versionNumber: 2, digest: "b" },
    ], nextCursor: null }),
    previewSkillVersion: async (_id: string, versionId: string): Promise<SkillVersionPreview> => {
      previewed.push(versionId);
      return { version: { id: versionId, versionNumber: 2, digest: "b", files: [file("Old")] },
        currentVersion: { id: latest, versionNumber: Number(latest.slice(7)), digest: latest, files: [file("New")] } };
    },
    restoreSkillVersion: async (_id: string, _versionId: string, expectedLatestVersionId: string) => {
      restores.push(expectedLatestVersionId);
      if (restores.length === 1) {
        latest = "skillv_4";
        throw new ApiError("The library changed after preview. Preview the version again.", 409);
      }
    },
  } as unknown as ApiClient;
  const unmount = await history(client);
  const consent = () => dialog().querySelector<HTMLInputElement>('.review-consent input[type="checkbox"]')!;
  const restore = () => [...dialog().querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Restore v2")!;
  await click(consent());
  await click(restore());
  assert.match(dialog().querySelector('[role="alert"]')!.textContent!, /library changed/);
  // The list and the version were read again: v4 is current now, and the consent asks again.
  assert.deepEqual(previewed, ["skillv_2", "skillv_2"]);
  assert.deepEqual(rows().map((row) => row.querySelector(".row-title")!.textContent), ["v4", "v3", "v2"]);
  assert.equal(consent().checked, false);
  assert.equal(restore().disabled, true);
  await click(consent());
  await click(restore());
  assert.deepEqual(restores, ["skillv_3", "skillv_4"]);
  await unmount();
});

const runner = { runnerId: "runner-1", hostname: "build", displayName: "Build Machine", status: "online", protocolVersion: PROTOCOL_VERSION, agents: [] } as unknown as RunnerView;
const machineClient = (overrides: Partial<ApiClient>) => ({
  ...api,
  getSkill: async () => ({ skill: { id: "skill-1", name: "code-review" } }),
  runnerSkills: async () => ({ desired: [{ name: "code-review", versionDigest: "a", targets: [{ agentId: "claude", invocation: "agent" }] }] }),
  ...overrides,
}) as unknown as ApiClient;
const machineVersion = (client: ApiClient) => mount(client, <SkillMachineVersionDialog skillId="skill-1" runners={[runner]} onClose={() => undefined} onSaved={async () => undefined} />);
const machinePreview = (versionId: string | null, pin: string | null): MachineSkillVersionPreview => ({
  policy: { versionId: pin, revision: "r1" },
  currentVersion: { id: pin ?? "skillv_60", digest: pin ?? "skillv_60", files: [file(pin ?? "latest")] },
  // Each proposal's one file is named for it, so a collapsed diff still says which was read.
  proposedVersion: { id: versionId ?? "skillv_60", versionNumber: versionId ? Number(versionId.slice(7)) : 60, digest: versionId ?? "skillv_60",
    files: [{ path: `${versionId ?? "latest"}.md`, encoding: "utf8", content: "proposed" }] },
  expectedLatestVersionId: "skillv_60",
});

test("Machine Version reads older pages until it can name a pin older than the first page", async () => {
  const listed: Array<string | undefined> = [];
  const page = (from: number, to: number) => Array.from({ length: from - to + 1 }, (_, index) => ({ id: `skillv_${from - index}`, versionNumber: from - index, digest: `${from - index}`, note: null }));
  const client = machineClient({
    getMachineSkillVersionPolicy: async () => ({ policy: { versionId: "skillv_3", revision: "r1" } }),
    listSkillVersions: async (_id: string, before?: string) => {
      listed.push(before);
      return before ? { versions: page(10, 1), nextCursor: null } : { versions: page(60, 11), nextCursor: "skillv_11" };
    },
  });
  const unmount = await machineVersion(client);
  assert.deepEqual(listed, [undefined, "skillv_11"]);
  const checked = radios().findIndex((radio) => radio.checked);
  assert.equal(titles()[checked], "Pin to v3Current");
  assert.ok(!titles().some((title) => title?.includes("Earlier Version")));
  await unmount();
});

test("Machine Version: an older control plane's policy comes from the preview, and a superseded preview is dropped", async () => {
  const previews: Array<string | null> = [];
  const slow = deferred<MachineSkillVersionPreview>();
  const client = machineClient({
    getMachineSkillVersionPolicy: async () => { throw new ApiError("Route not found", 404); },
    listSkillVersions: async () => ({ versions: [
      { id: "skillv_3", versionNumber: 3, digest: "3" }, { id: "skillv_2", versionNumber: 2, digest: "2" }, { id: "skillv_1", versionNumber: 1, digest: "1" },
    ], nextCursor: null }),
    previewMachineSkillVersion: (_id: string, _runnerId: string, versionId: string | null) => {
      previews.push(versionId);
      // The first read is the older control plane's policy; the pin to v2 answers late.
      return versionId === "skillv_2" ? slow.promise : Promise.resolve(machinePreview(versionId, null));
    },
  });
  const unmount = await machineVersion(client);
  assert.deepEqual(previews, [null]);
  assert.deepEqual(titles(), ["Track LatestCurrent", "Pin to v3", "Pin to v2", "Pin to v1"]);
  await click(radios()[2]!);
  await wait(MACHINE_VERSION_PREVIEW_DELAY_MS + 50);
  assert.deepEqual(previews, [null, "skillv_2"]);
  await click(radios()[3]!);
  await wait(MACHINE_VERSION_PREVIEW_DELAY_MS + 50);
  assert.deepEqual(previews, [null, "skillv_2", "skillv_1"]);
  assert.equal(heading(), "Changes If You Pin to v1");
  await act(async () => { slow.resolve(machinePreview("skillv_2", null)); });
  await settle();
  assert.equal(heading(), "Changes If You Pin to v1");
  assert.match(dialog().querySelector(".skill-diff")!.textContent!, /skillv_1\.md/);
  assert.doesNotMatch(dialog().querySelector(".skill-diff")!.textContent!, /skillv_2\.md/);
  assert.equal(dialog().querySelector(".review-consent")?.textContent, "Switch 1 agent to v1");
  await unmount();
});
