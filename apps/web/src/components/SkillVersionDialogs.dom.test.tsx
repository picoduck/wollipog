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
/** Whether the window is phone-width: max-width queries match while it is set. */
let phoneWidth = false;
Object.defineProperty(domWindow, "matchMedia", {
  configurable: true,
  value: (query: string) => ({ matches: phoneWidth && query.includes("max-width"), media: query, addEventListener() {}, removeEventListener() {} }),
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
  assertNoDomNode(dialog().querySelector(".skill-version-full-note"), "nor a Note in the detail (#2286)");
  assert.equal(heading(), `Changes If You Restore ${"a".repeat(12)}`);
  assert.doesNotMatch(dialog().textContent!, /skillv_|[0-9a-f]{64}/);
  await unmount();
});

test("Version History shows the selected version's whole note in its detail, and No Note only when it has none (#2286)", async () => {
  const long = "Tighten the review checklist so every caller of a changed function is read, not only the diff.\n\n" +
    "Also restores the migration checks from skillv_1, which skillv_gone had dropped.";
  const client = {
    ...api,
    listSkillVersions: async () => ({ versions: [
      { id: "skillv_3", versionNumber: 3, digest: "c", note: null },
      { id: "skillv_2", versionNumber: 2, digest: "b", note: long },
      { id: "skillv_1", versionNumber: 1, digest: "a", note: "First" },
    ], nextCursor: null }),
    previewSkillVersion: async (_id: string, versionId: string): Promise<SkillVersionPreview> => ({
      version: { id: versionId, versionNumber: Number(versionId.slice(7)), digest: versionId.slice(7).repeat(64), files: [file(`Body ${versionId.slice(7)}`)] },
      currentVersion: { id: "skillv_3", versionNumber: 3, digest: "3".repeat(64), files: [file("current")] },
    }),
  } as unknown as ApiClient;
  const noteValue =() => dialog().querySelector(".skill-version-full-note dd");
  const resize = async (phone: boolean) => {
    phoneWidth = phone;
    await act(async () => { domWindow.dispatchEvent(new domWindow.Event("resize")); });
    await settle();
  };
  try {
    const unmount = await history(client);
    // Wide: the dialog opens on v2, the version before the current one.
    assert.equal(heading(), "Changes If You Restore v2");
    assert.equal(dialog().querySelector(".skill-version-full-note dt")?.textContent, "Note");
    assert.equal(noteValue()?.textContent,
      "Tighten the review checklist so every caller of a changed function is read, not only the diff.\n\n" +
      "Also restores the migration checks from v1, which an earlier version had dropped.");
    assert.ok(!noteValue()?.classList.contains("is-empty"));
    // The row keeps its one line.
    assert.equal(rows()[1]!.querySelector(".row-sub")?.textContent,
      "Tighten the review checklist so every caller of a changed function is read, not only the diff. " +
      "Also restores the migration checks from v1, which an earlier version had dropped.");
    assert.doesNotMatch(dialog().textContent!, /skillv_/);
    // A version without a note says so, dimmed like its row.
    await click(rows()[0]!);
    assert.equal(heading(), "Files in v3");
    assert.equal(noteValue()?.textContent, "No note");
    assert.ok(noteValue()?.classList.contains("is-empty"));
    // On a phone the chosen version's detail shows the whole note too.
    await resize(true);
    await click(dialog().querySelector<HTMLButtonElement>('button[aria-label="Back to Versions"]')!);
    await click(rows()[1]!);
    assert.equal(rows().length, 0);
    assert.match(noteValue()?.textContent ?? "", /^Tighten the review checklist[^]*which an earlier version had dropped\.$/u);
    await unmount();
  } finally { phoneWidth = false; }
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

/** An IntersectionObserver that reports only when the test says the list's end came into view. */
function installManualObserver() {
  const observers = new Set<{ callback: IntersectionObserverCallback; targets: Element[] }>();
  class ManualObserver {
    private entry: { callback: IntersectionObserverCallback; targets: Element[] };
    constructor(callback: IntersectionObserverCallback) { this.entry = { callback, targets: [] }; observers.add(this.entry); }
    observe(target: Element) { this.entry.targets.push(target); }
    disconnect() { observers.delete(this.entry); }
  }
  Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, writable: true, value: ManualObserver });
  return {
    async scrollToEnd() {
      await act(async () => {
        for (const { callback, targets } of [...observers]) {
          callback(targets.map((target) => ({ isIntersecting: true, target }) as unknown as IntersectionObserverEntry), {} as IntersectionObserver);
        }
      });
      await settle();
    },
    remove() { delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver; },
  };
}

test("Version History: a reload while an older page is read still lets older pages load (review CR-1.2)", async () => {
  const observer = installManualObserver();
  const slow = deferred<{ versions: SkillVersionSummary[]; nextCursor: string | null }>();
  let olderReads = 0;
  const first = { versions: [{ id: "skillv_3", versionNumber: 3, digest: "c" }, { id: "skillv_2", versionNumber: 2, digest: "b" }], nextCursor: "skillv_2" };
  const older = { versions: [{ id: "skillv_1", versionNumber: 1, digest: "a" }], nextCursor: null };
  let restores = 0;
  const client = {
    ...api,
    listSkillVersions: async (_id: string, before?: string) => {
      if (!before) return first;
      olderReads++;
      return olderReads === 1 ? slow.promise : older;
    },
    previewSkillVersion: async (_id: string, versionId: string): Promise<SkillVersionPreview> => ({
      version: { id: versionId, versionNumber: 2, digest: "b", files: [file("Old")] },
      currentVersion: { id: "skillv_3", versionNumber: 3, digest: "c", files: [file("New")] },
    }),
    restoreSkillVersion: async () => { restores++; throw new ApiError("The library changed after preview. Preview the version again.", 409); },
  } as unknown as ApiClient;
  try {
    const unmount = await history(client);
    await observer.scrollToEnd();
    assert.equal(olderReads, 1, "the older page is being read");
    // A refused restore reloads the list while that read is still out.
    await click(dialog().querySelector<HTMLInputElement>('.review-consent input[type="checkbox"]')!);
    await click([...dialog().querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Restore v2")!);
    assert.equal(restores, 1);
    await act(async () => { slow.resolve(older); });
    await settle();
    // The superseded read is dropped, and the list's end reads the older page again.
    assert.deepEqual(rows().map((row) => row.querySelector(".row-title")!.textContent), ["v3", "v2"]);
    await observer.scrollToEnd();
    assert.equal(olderReads, 2);
    assert.deepEqual(rows().map((row) => row.querySelector(".row-title")!.textContent), ["v3", "v2", "v1"]);
    await unmount();
  } finally { observer.remove(); }
});

test("Version History: an older version stays on screen when a refused restore reloads the first page (review CR-1.4)", async () => {
  const observer = installManualObserver();
  const client = {
    ...api,
    listSkillVersions: async (_id: string, before?: string) => before
      ? { versions: [{ id: "skillv_1", versionNumber: 1, digest: "a", note: "First" }], nextCursor: null }
      : { versions: [{ id: "skillv_3", versionNumber: 3, digest: "c" }, { id: "skillv_2", versionNumber: 2, digest: "b" }], nextCursor: "skillv_2" },
    previewSkillVersion: async (_id: string, versionId: string): Promise<SkillVersionPreview> => ({
      version: { id: versionId, versionNumber: Number(versionId.slice(7)), digest: versionId, files: [file(versionId)] },
      currentVersion: { id: "skillv_3", versionNumber: 3, digest: "skillv_3", files: [file("current")] },
    }),
    restoreSkillVersion: async () => { throw new ApiError("The library changed after preview. Preview the version again.", 409); },
  } as unknown as ApiClient;
  try {
    const unmount = await history(client);
    await observer.scrollToEnd();
    await click(rows()[2]!);
    assert.equal(heading(), "Changes If You Restore v1");
    await click(dialog().querySelector<HTMLInputElement>('.review-consent input[type="checkbox"]')!);
    await click([...dialog().querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Restore v1")!);
    // The reload dropped v1's page, but its facts and changes stay, read afresh.
    assert.equal(rows().length, 2);
    assert.equal(heading(), "Changes If You Restore v1");
    assert.match(dialog().querySelector(".skill-review-facts")!.textContent!, /Library edit/);
    assert.ok([...dialog().querySelectorAll("button")].some((button) => button.textContent === "Restore v1"));
    await unmount();
  } finally { observer.remove(); }
});

test("Version History: a preview naming a newer current version lets the listed one be restored (review CR-1.3)", async () => {
  const client = {
    ...api,
    // The list was read before v4 was made.
    listSkillVersions: async () => ({ versions: [{ id: "skillv_3", versionNumber: 3, digest: "c" }, { id: "skillv_2", versionNumber: 2, digest: "b" }], nextCursor: null }),
    previewSkillVersion: async (_id: string, versionId: string): Promise<SkillVersionPreview> => ({
      version: { id: versionId, versionNumber: Number(versionId.slice(7)), digest: versionId, files: [file(versionId)] },
      currentVersion: { id: "skillv_4", versionNumber: 4, digest: "skillv_4", files: [file("v4")] },
    }),
  } as unknown as ApiClient;
  const unmount = await history(client);
  await click(rows()[0]!);
  assert.equal(heading(), "Changes If You Restore v3");
  assert.doesNotMatch(dialog().querySelector(".modal-foot")!.textContent!, /This is the current version/);
  await click(dialog().querySelector<HTMLInputElement>('.review-consent input[type="checkbox"]')!);
  assert.equal([...dialog().querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Restore v3")!.disabled, false);
  await unmount();
});

test("Machine Version counts the machine's agents again for every preview (review CR-1.1)", async () => {
  let agents: string[] = [];
  const client = machineClient({
    getMachineSkillVersionPolicy: async () => ({ policy: null }),
    runnerSkills: async () => ({ desired: [{ name: "code-review", versionDigest: "a", targets: agents.map((agentId) => ({ agentId, invocation: "agent" })) }] }),
    listSkillVersions: async () => ({ versions: [
      { id: "skillv_3", versionNumber: 3, digest: "3" }, { id: "skillv_2", versionNumber: 2, digest: "2" }, { id: "skillv_1", versionNumber: 1, digest: "1" },
    ], nextCursor: null }),
    previewMachineSkillVersion: async (_id: string, _runnerId: string, versionId: string | null) => machinePreview(versionId, null),
  } as unknown as Partial<ApiClient>);
  const unmount = await machineVersion(client);
  await click(radios()[2]!);
  await wait(MACHINE_VERSION_PREVIEW_DELAY_MS + 50);
  assert.equal(heading(), "Changes If You Pin to v2");
  assertNoDomNode(dialog().querySelector(".review-consent"), "no agent runs the skill here yet, so nothing switches");
  // Two agents are assigned while the dialog is open.
  agents = ["claude", "codex"];
  await click(radios()[3]!);
  await wait(MACHINE_VERSION_PREVIEW_DELAY_MS + 50);
  assert.equal(dialog().querySelector(".review-consent")?.textContent, "Switch 2 agents to v1");
  await unmount();
});

test("Version History: a list that can't be read again after a restore names nothing current (review CR-2.1)", async () => {
  let lists = 0;
  const before = { versions: [{ id: "skillv_3", versionNumber: 3, digest: "c" }, { id: "skillv_2", versionNumber: 2, digest: "b" }], nextCursor: null };
  const after = { versions: [{ id: "skillv_4", versionNumber: 4, digest: "b", note: "Restored from v2" }, ...before.versions], nextCursor: null };
  const client = {
    ...api,
    listSkillVersions: async () => {
      lists++;
      if (lists === 2) throw new Error("The control plane is restarting.");
      return lists === 1 ? before : after;
    },
    previewSkillVersion: async (_id: string, versionId: string): Promise<SkillVersionPreview> => ({
      version: { id: versionId, versionNumber: Number(versionId.slice(7)), digest: versionId, files: [file(versionId)] },
      currentVersion: { id: "skillv_3", versionNumber: 3, digest: "skillv_3", files: [file("current")] },
    }),
    restoreSkillVersion: async () => undefined,
  } as unknown as ApiClient;
  const unmount = await history(client);
  await click(dialog().querySelector<HTMLInputElement>('.review-consent input[type="checkbox"]')!);
  await click([...dialog().querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Restore v2")!);
  assert.match(dialog().textContent!, /Restored v2\./);
  // The old list stays, said to be out of date, with no version called current and none selected.
  const notice = dialog().querySelector<HTMLElement>(".skill-version-pane.list .notice")!;
  assert.match(notice.textContent!, /Couldn't Load Versions.*may be out of date/);
  assert.deepEqual(rows().map((row) => row.querySelector(".row-title")!.textContent), ["v3", "v2"]);
  assert.equal(dialog().querySelectorAll(".row .status").length, 0);
  assert.equal(rows().filter((row) => row.getAttribute("aria-current") === "true").length, 0);
  const primary = dialog().querySelector<HTMLButtonElement>(".modal-foot .btn.primary")!;
  assert.equal(primary.textContent, "Restore Version");
  assert.equal(primary.disabled, true);
  // Retry reads the list that has the restored version as current.
  await click([...notice.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Retry")!);
  assertNoDomNode(dialog().querySelector(".skill-version-pane.list .notice"), "the fresh list replaces the notice");
  assert.deepEqual(rows().map((row) => row.querySelector(".row-title")!.textContent), ["v4", "v3", "v2"]);
  assert.equal(rows()[0]!.querySelector(".status")?.textContent, "Current");
  await unmount();
});

test("Machine Version keeps a pin it can't reach selectable when an older page fails, and names it after Retry (review CR-3.1)", async () => {
  let olderReads = 0;
  const page = (from: number, to: number) => Array.from({ length: from - to + 1 }, (_, index) => ({ id: `skillv_${from - index}`, versionNumber: from - index, digest: `${from - index}`, note: null }));
  const client = machineClient({
    getMachineSkillVersionPolicy: async () => ({ policy: { versionId: "skillv_1", revision: "r1" } }),
    listSkillVersions: async (_id: string, before?: string) => {
      if (!before) return { versions: page(60, 11), nextCursor: "skillv_11" };
      olderReads++;
      if (olderReads === 1) throw new Error("The control plane is restarting.");
      return { versions: page(10, 1), nextCursor: null };
    },
  });
  const unmount = await machineVersion(client);
  const checked = () => titles()[radios().findIndex((radio) => radio.checked)];
  assert.equal(olderReads, 1);
  assert.equal(checked(), "Pin to an Earlier VersionCurrent");
  assert.match(dialog().querySelector(".skill-version-list-error")!.textContent!, /Older versions couldn't be loaded/);
  await click([...dialog().querySelectorAll<HTMLButtonElement>(".skill-version-list-error button")].find((button) => button.textContent === "Retry")!);
  assert.equal(olderReads, 2);
  assert.equal(checked(), "Pin to v1Current");
  assert.ok(!titles().some((title) => title?.includes("Earlier Version")));
  await unmount();
});

test("Version History keeps a version chosen on a phone when the window widens past the breakpoint (review CR-E2-1.1)", async () => {
  const previewed: string[] = [];
  const client = {
    ...api,
    listSkillVersions: async () => ({ versions: [
      { id: "skillv_3", versionNumber: 3, digest: "c" }, { id: "skillv_2", versionNumber: 2, digest: "b" }, { id: "skillv_1", versionNumber: 1, digest: "a" },
    ], nextCursor: null }),
    previewSkillVersion: async (_id: string, versionId: string): Promise<SkillVersionPreview> => {
      previewed.push(versionId);
      return { version: { id: versionId, versionNumber: Number(versionId.slice(7)), digest: versionId, files: [file(versionId)] },
        currentVersion: { id: "skillv_3", versionNumber: 3, digest: "skillv_3", files: [file("current")] } };
    },
  } as unknown as ApiClient;
  phoneWidth = true;
  try {
    const unmount = await history(client);
    // A phone opens on the list, with nothing chosen.
    assert.deepEqual(previewed, []);
    await click(rows()[2]!);
    assert.deepEqual(previewed, ["skillv_1"]);
    phoneWidth = false;
    await act(async () => { domWindow.dispatchEvent(new domWindow.Event("resize")); });
    await settle();
    assert.equal(rows()[2]!.getAttribute("aria-current"), "true");
    assert.equal(heading(), "Changes If You Restore v1");
    assert.deepEqual(previewed, ["skillv_1"]);
    await unmount();
  } finally { phoneWidth = false; }
});

test("Version History keeps focus in the dialog when a phone-width crossing hides the focused row (review CR-E2-2.1)", async () => {
  const client = {
    ...api,
    listSkillVersions: async () => ({ versions: [{ id: "skillv_3", versionNumber: 3, digest: "c" }, { id: "skillv_2", versionNumber: 2, digest: "b" }], nextCursor: null }),
    previewSkillVersion: async (_id: string, versionId: string): Promise<SkillVersionPreview> => ({
      version: { id: versionId, versionNumber: Number(versionId.slice(7)), digest: versionId, files: [file(versionId)] },
      currentVersion: { id: "skillv_3", versionNumber: 3, digest: "skillv_3", files: [file("current")] },
    }),
  } as unknown as ApiClient;
  try {
    const unmount = await history(client);
    await act(async () => { rows()[1]!.focus(); });
    assert.equal(document.activeElement, rows()[1]);
    phoneWidth = true;
    await act(async () => { domWindow.dispatchEvent(new domWindow.Event("resize")); });
    await settle();
    // The sheet shows the chosen version; the row that had focus is gone, and focus is on Back.
    assert.equal(rows().length, 0);
    assert.ok(dialog().contains(document.activeElement), "focus stays inside the dialog");
    assert.equal(document.activeElement?.getAttribute("aria-label"), "Back to Versions");
    await unmount();
  } finally { phoneWidth = false; }
});

test("Version History keeps focus in the dialog through every phone pane change (review CR-E2-3.1)", async () => {
  const client = {
    ...api,
    listSkillVersions: async () => ({ versions: [{ id: "skillv_3", versionNumber: 3, digest: "c" }, { id: "skillv_2", versionNumber: 2, digest: "b" }], nextCursor: null }),
    previewSkillVersion: async (_id: string, versionId: string): Promise<SkillVersionPreview> => ({
      version: { id: versionId, versionNumber: Number(versionId.slice(7)), digest: versionId.padEnd(64, "0"), files: [file(versionId)] },
      currentVersion: { id: "skillv_3", versionNumber: 3, digest: "skillv_3", files: [file("current")] },
    }),
  } as unknown as ApiClient;
  const resize = async (phone: boolean) => {
    phoneWidth = phone;
    await act(async () => { domWindow.dispatchEvent(new domWindow.Event("resize")); });
    await settle();
  };
  const buttonLabelled = (label: string) => dialog().querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  phoneWidth = true;
  try {
    const unmount = await history(client);
    // Choosing a row from the keyboard replaces the list with the version: focus goes to Back.
    await act(async () => { rows()[1]!.focus(); });
    await click(rows()[1]!);
    assert.equal(rows().length, 0);
    assert.ok(dialog().contains(document.activeElement), "choosing keeps focus inside the dialog");
    assert.equal(document.activeElement?.getAttribute("aria-label"), "Back to Versions");
    // Back to the list, then wider: both panes show. Focus Copy in the version, then narrow again,
    // which hides the version: focus goes to the chosen row.
    await click(buttonLabelled("Back to Versions"));
    await resize(false);
    await act(async () => { buttonLabelled("Copy Fingerprint").focus(); });
    assert.equal(document.activeElement?.getAttribute("aria-label"), "Copy Fingerprint");
    await resize(true);
    assertNoDomNode(dialog().querySelector('button[aria-label="Copy Fingerprint"]'), "the version pane is hidden on the list step");
    assert.ok(dialog().contains(document.activeElement), "narrowing keeps focus inside the dialog");
    assert.equal(document.activeElement, rows()[1]);
    await unmount();
  } finally { phoneWidth = false; }
});

test("Version History keeps focus in the dialog when the chosen row is disabled by a running restore (review CR-E2-4.1)", async () => {
  const restoring = deferred<void>();
  const client = {
    ...api,
    listSkillVersions: async () => ({ versions: [{ id: "skillv_3", versionNumber: 3, digest: "c" }, { id: "skillv_2", versionNumber: 2, digest: "b" }], nextCursor: null }),
    previewSkillVersion: async (_id: string, versionId: string): Promise<SkillVersionPreview> => ({
      version: { id: versionId, versionNumber: Number(versionId.slice(7)), digest: versionId.padEnd(64, "0"), files: [file(versionId)] },
      currentVersion: { id: "skillv_3", versionNumber: 3, digest: "skillv_3", files: [file("current")] },
    }),
    restoreSkillVersion: () => restoring.promise,
  } as unknown as ApiClient;
  const resize = async (phone: boolean) => {
    phoneWidth = phone;
    await act(async () => { domWindow.dispatchEvent(new domWindow.Event("resize")); });
    await settle();
  };
  phoneWidth = true;
  try {
    const unmount = await history(client);
    await click(rows()[1]!);
    await click(dialog().querySelector<HTMLButtonElement>('button[aria-label="Back to Versions"]')!);
    await resize(false);
    await click(dialog().querySelector<HTMLInputElement>('.review-consent input[type="checkbox"]')!);
    await click([...dialog().querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Restore v2")!);
    // The restore is still running, so every row is disabled.
    assert.ok(rows().every((row) => row.disabled));
    await act(async () => { dialog().querySelector<HTMLButtonElement>('button[aria-label="Copy Fingerprint"]')!.focus(); });
    await resize(true);
    assert.ok(dialog().contains(document.activeElement), "focus stays inside the dialog while the chosen row is disabled");
    await act(async () => { restoring.resolve(); });
    await settle();
    await unmount();
  } finally { phoneWidth = false; }
});

test("on a phone, Back from the keyboard returns focus to the chosen version, so a second Enter never closes (#2368)", async () => {
  const restoring = deferred<void>();
  let closed = 0;
  const client = {
    ...api,
    listSkillVersions: async () => ({ versions: [
      { id: "skillv_3", versionNumber: 3, digest: "c" }, { id: "skillv_2", versionNumber: 2, digest: "b" }, { id: "skillv_1", versionNumber: 1, digest: "a" },
    ], nextCursor: null }),
    previewSkillVersion: async (_id: string, versionId: string): Promise<SkillVersionPreview> => ({
      version: { id: versionId, versionNumber: Number(versionId.slice(7)), digest: versionId.padEnd(64, "0"), files: [file(versionId)] },
      currentVersion: { id: "skillv_3", versionNumber: 3, digest: "skillv_3", files: [file("current")] },
    }),
    restoreSkillVersion: () => restoring.promise,
  } as unknown as ApiClient;
  const back = () => dialog().querySelector<HTMLButtonElement>('button[aria-label="Back to Versions"]')!;
  const header = () => dialog().querySelector<HTMLButtonElement>(".modal-head .icon-btn")!;
  phoneWidth = true;
  try {
    const unmount = await mount(client, <SkillVersionHistoryDialog skillId="skill-1" onClose={() => { closed += 1; }} onRestored={async () => undefined} />);
    // Choose v2, not the first row, so the chosen row is told apart from the first.
    await act(async () => { rows()[1]!.focus(); });
    await click(rows()[1]!);
    assert.ok(document.activeElement === back(), "focus is on Back on the version step");
    await act(async () => { back().focus(); });
    await click(back());
    assert.equal(rows().length, 3);
    assert.equal(header().getAttribute("aria-label"), "Close");
    assert.ok(document.activeElement !== header(), "focus is not on the header button, now Close");
    assert.ok(document.activeElement === rows()[1], "focus is on the chosen version");
    // The second Enter acts on that row: it shows the version again and the dialog stays open.
    await click(document.activeElement as HTMLButtonElement);
    assert.equal(heading(), "Changes If You Restore v2");
    assert.equal(closed, 0);

    // Back while a restore runs: every row is disabled, so the dialog holds focus, not Close.
    await click(dialog().querySelector<HTMLInputElement>('.review-consent input[type="checkbox"]')!);
    await click([...dialog().querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Restore v2")!);
    await act(async () => { back().focus(); });
    await click(back());
    assert.ok(rows().every((row) => row.disabled));
    assert.ok(document.activeElement === dialog(), `the dialog holds focus, not ${document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName}`);
    assert.equal(closed, 0);
    await act(async () => { restoring.resolve(); });
    await settle();
    await unmount();
  } finally { phoneWidth = false; }
});
