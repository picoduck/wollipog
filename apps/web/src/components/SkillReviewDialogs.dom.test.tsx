import assert from "node:assert/strict";
import test from "node:test";
import React, { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import type { OrphanedSkillCopy, SkillBuiltInReview, SkillDriftPreview } from "../skills.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { SkillBuiltInReviewDialog } from "./SkillBuiltInReviewDialog.js";
import { SkillDriftImportDialog } from "./SkillDriftImportDialog.js";
import { SkillOrphanImportDialog } from "./SkillOrphanImportDialog.js";

/**
 * #1973: the edited-copy, orphaned-copy and built-in reviews are one description sentence, a facts
 * row, at most one compact notice (two for a built-in update that turns off Git updates) and the diff
 * under "Changes From vN", with the alternative to importing as the footer's destructive tertiary.
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

const digest = "4f1c".padEnd(64, "0");
const observedDigest = "9b2e".padEnd(64, "0");
const file = (body: string) => ({ path: "SKILL.md", encoding: "utf8" as const, content: `---\nname: code-review\n---\n${body}` });

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

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const body = () => dialog().querySelector<HTMLElement>(".modal-body")!;
const footer = () => dialog().querySelector<HTMLElement>(".modal-foot")!;
const texts = (selector: string) => [...dialog().querySelectorAll(selector)].map((node) => node.textContent?.trim());
const facts = () => Object.fromEntries([...dialog().querySelectorAll(".skill-review-facts > div")]
  .map((pair) => [pair.querySelector("dt")!.textContent, pair.querySelector("dd")!.textContent]));
const buttonNamed = (name: string) => [...dialog().querySelectorAll<HTMLButtonElement>("button")]
  .find((button) => button.textContent?.trim() === name);
/** The body's text before the diff: what the review says about the change. */
const prose = () => [...body().children].filter((node) => !node.classList.contains("skill-review-changes"))
  .map((node) => node.textContent).join(" ") + ` ${dialog().querySelector(".modal-desc")?.textContent ?? ""}`;

/** No implementation detail, digest-as-version or parenthesised variant reaches the reader. */
function assertPlainLanguage() {
  const text = `${prose()} ${dialog().querySelector(".skill-review-changes-head")?.textContent ?? ""} ${footer().textContent}`;
  assert.doesNotMatch(text, /disable-model-invocation/);
  assert.doesNotMatch(text, /\b[0-9a-f]{12}\b/);
  assert.doesNotMatch(text, /[()]/);
}

/** At most `count` compact notices, all before the diff. */
function assertNotices(expected: string[]) {
  const notices = [...body().querySelectorAll(":scope > .notice")];
  assert.deepEqual(notices.map((notice) => notice.textContent?.trim()), expected);
  for (const notice of notices) assert.ok(notice.classList.contains("compact"), "a review's notice is compact");
  const changes = body().querySelector(".skill-review-changes")!;
  for (const notice of notices) {
    assert.ok(notice.compareDocumentPosition(changes) & domWindow.Node.DOCUMENT_POSITION_FOLLOWING, "the notice comes before the diff");
  }
}

function driftPreview(overrides: Partial<SkillDriftPreview> = {}): SkillDriftPreview {
  return {
    previewId: "review-1", drift: { name: "code-review", digest, variant: "agent", observedDigest },
    files: [file("Edited.\n")], previousFiles: [file("Library.\n")], digest: observedDigest, importable: true,
    disposition: "update", publishedFromLatest: true, pinned: false, assignmentCount: 2, ...overrides,
  };
}

function driftClient(preview: () => Promise<SkillDriftPreview>, options: { pinnedId?: string; calls?: string[] } = {}) {
  return {
    ...api,
    previewSkillDrift: preview,
    discardSkillDriftPreview: async (id: string) => { options.calls?.push(`discard:${id}`); },
    getMachineSkillVersionPolicy: async () => ({ policy: options.pinnedId ? { versionId: options.pinnedId, revision: "r1" } : null }),
    listSkillVersions: async (_id: string, before?: string) => before
      ? { versions: [{ id: "v2", digest: "b".repeat(64), versionNumber: 2 }], nextCursor: null }
      : { versions: [{ id: "v3", digest, versionNumber: 3 }], nextCursor: "v3" },
  } as unknown as ApiClient;
}

test("the edited-copy review: facts, the pin notice, Changes From v3 and Import as v4, after a skeleton", async () => {
  let resolve!: (preview: SkillDriftPreview) => void;
  const calls: string[] = [];
  const client = driftClient(() => new Promise((done) => { resolve = done; }), { pinnedId: "v3", calls });
  const restores: Array<() => void> = [];
  let closed = 0;
  const unmount = await mount(client, <SkillDriftImportDialog skillId="skill-1" runnerId="runner-1" machineLabel="Studio Workstation"
    copy={{ name: "code-review", digest, variant: "agent" }} onClose={() => { closed++; }} onImported={async () => undefined}
    onRestore={(closeReview) => restores.push(closeReview)} />);

  // Reading: the diff's place holds one skeleton block that says what is read.
  const loading = dialog().querySelector(".skill-review-loading");
  assert.equal(loading?.getAttribute("role"), "status");
  assert.equal(loading?.textContent, "Reading the edited copy…");
  assertNoDomNode(dialog().querySelector(".skill-diff"));
  assert.equal(facts()["Result"], "Loading", "a fact still being read is a skeleton");
  assert.equal(buttonNamed("Restore Library Version…")?.disabled, true, "the alternative waits for the read like Cancel");

  await act(async () => { resolve(driftPreview({ pinned: true })); });
  await settle();
  assert.equal(dialog().querySelector(".modal-title")?.textContent, "Import Edit as New Version");
  assert.equal(dialog().querySelector(".modal-desc")?.textContent,
    "Importing records the files edited on Studio Workstation as a new version of code-review.");
  assert.deepEqual(facts(), { "Machine": "Studio Workstation", "Edited Copy Of": "v3", "Copy": "Agent Invocable", "Result": "New version v4" });
  assertNotices(["Studio Workstation is pinned to v3. Importing moves its pin to v4."]);
  assert.equal(dialog().querySelector(".skill-review-changes-title")?.textContent, "Changes From v3");
  assert.equal(dialog().querySelector(".skill-review-changes-note")?.textContent,
    "Review every file, including scripts. Reviewing and importing never run skill contents.");
  assert.equal(dialog().querySelector(".skill-diff")?.getAttribute("aria-label"), "Changes From v3");
  assertNoDomNode(dialog().querySelector(".skill-review-loading"), "the skeleton and the diff never show together");
  assertPlainLanguage();

  // The footer: the destructive alternative far left, then the consent, Cancel and the primary.
  assert.deepEqual([...footer().children].map((node) => node.classList.contains("modal-tertiary") ? "tertiary"
    : node.classList.contains("review-consent") ? "consent" : node.textContent?.trim()),
  ["tertiary", "consent", "Cancel", "Import as v4"]);
  const restore = footer().querySelector<HTMLButtonElement>(".modal-tertiary > button")!;
  assert.equal(restore.textContent, "Restore Library Version…");
  assert.ok(restore.classList.contains("ghost") && restore.classList.contains("danger"));
  await act(async () => { restore.click(); });
  assert.equal(restores.length, 1, "the restore opens its confirmation through the page");
  assert.equal(closed, 0, "nothing closes until the restore is confirmed");
  await act(async () => { restores[0]!(); });
  assert.equal(closed, 1, "a confirmed restore closes the review");
  assert.deepEqual(calls, ["discard:review-1"], "and discards its preview");
  await unmount();
});

test("the edited-copy review shows one notice, the one that matters most", async () => {
  // An older copy outranks the pin and the Manual Only setting.
  let unmount = await mount(driftClient(async () => driftPreview({ publishedFromLatest: false, pinned: true }), { pinnedId: "v3" }),
    <SkillDriftImportDialog skillId="skill-1" runnerId="runner-1" machineLabel="Build Machine"
      copy={{ name: "code-review", digest: "b".repeat(64), variant: "manual" }} onClose={() => undefined} onImported={async () => undefined} />);
  assert.equal(facts()["Edited Copy Of"], "v2", "a version past the first page is found on the next");
  assert.equal(facts()["Copy"], "Manual Only");
  assertNotices(["This copy was edited from v2. Importing replaces the newer library content shown as removed lines."]);
  assertPlainLanguage();
  await unmount();

  // A Manual Only copy says that the setting is not imported, in words.
  unmount = await mount(driftClient(async () => driftPreview({ files: [file("Edited.\n")] })),
    <SkillDriftImportDialog skillId="skill-1" runnerId="runner-1" machineLabel="Build Machine"
      copy={{ name: "code-review", digest, variant: "manual" }} onClose={() => undefined} onImported={async () => undefined} />);
  assertNotices(["The copy was Manual Only. That setting isn't imported; choose it when you assign the skill."]);
  assertPlainLanguage();
  await unmount();

  // An edit that matches the library creates no version, so it is not labelled as one.
  unmount = await mount(driftClient(async () => driftPreview({ disposition: "identical", assignmentCount: 0 })),
    <SkillDriftImportDialog skillId="skill-1" runnerId="runner-1" machineLabel="Build Machine"
      copy={{ name: "code-review", digest, variant: "agent" }} onClose={() => undefined} onImported={async () => undefined} />);
  assert.equal(dialog().querySelector(".modal-desc")?.textContent,
    "The edited files already match v3, so importing only releases Build Machine's hold.");
  assert.equal(facts()["Result"], "No new version, matches v3");
  assertNotices([]);
  assert.equal(buttonNamed("Import Edit")?.disabled, false);
  await unmount();
});

test("the edited-copy review names versions in words when the version list cannot be read", async () => {
  const client = {
    ...driftClient(async () => driftPreview({ pinned: true })),
    listSkillVersions: async () => { throw new Error("offline"); },
  } as ApiClient;
  const unmount = await mount(client, <SkillDriftImportDialog skillId="skill-1" runnerId="runner-1" machineLabel="Build Machine"
    copy={{ name: "code-review", digest, variant: "agent" }} onClose={() => undefined} onImported={async () => undefined} />);
  assert.deepEqual(facts(), { "Machine": "Build Machine", "Edited Copy Of": "Unknown", "Copy": "Agent Invocable", "Result": "New version" });
  assertNotices(["Build Machine is pinned to a version of this skill. Importing moves its pin to the new version."]);
  assert.equal(dialog().querySelector(".skill-review-changes-title")?.textContent, "Changes From the Latest Version");
  assert.ok(buttonNamed("Import as New Version"));
  assertPlainLanguage();
  await unmount();
});

test("the edited-copy review shows a read that failed in the diff's place, with Retry", async () => {
  let reads = 0;
  const unmount = await mount(driftClient(async () => {
    reads++;
    if (reads === 1) throw new Error("The machine is offline.");
    return driftPreview();
  }), <SkillDriftImportDialog skillId="skill-1" runnerId="runner-1" machineLabel="Build Machine"
    copy={{ name: "code-review", digest, variant: "agent" }} onClose={() => undefined} onImported={async () => undefined} />);
  const failure = dialog().querySelector(".skill-review-changes .notice");
  assert.match(failure?.textContent ?? "", /Couldn't Read the Edited Copy.*The machine is offline\./);
  assert.equal(facts()["Result"], "Unknown");
  assertNoDomNode(dialog().querySelector(".skill-review-loading"));
  await act(async () => { buttonNamed("Retry")!.click(); });
  await settle();
  assert.ok(dialog().querySelector(".skill-diff"));
  assertNoDomNode(dialog().querySelector(".skill-review-changes .notice"), "a successful read clears the failure");
  await unmount();
});

function orphanClient(preview: Partial<Awaited<ReturnType<ApiClient["previewOrphanedSkillCopy"]>>>, calls: string[] = []) {
  return {
    ...api,
    previewOrphanedSkillCopy: async () => ({
      previewId: "review-1", copy: { kind: "kept_aside", id: "copy-1", observedDigest }, name: "code-review",
      files: [file("Kept.\n")], previousFiles: [], digest: observedDigest, importable: true, disposition: "new",
      assignmentCount: 0, ...preview,
    }),
    discardOrphanedSkillCopyPreview: async (id: string) => { calls.push(`discard:${id}`); },
    listSkillVersions: async () => ({ versions: [{ id: "v2", digest, versionNumber: 2 }], nextCursor: null }),
  } as unknown as ApiClient;
}

test("the orphaned-copy review of a deleted skill: Import Orphaned Copy, its facts and Discard Copy…", async () => {
  const copy: OrphanedSkillCopy = { kind: "deleted_skill", name: "triage-helper", digest, variant: "agent", observedDigest, held: true };
  const calls: string[] = [];
  const discards: Array<() => void> = [];
  let closed = 0;
  const unmount = await mount(orphanClient({ name: "triage-helper", copy: { kind: "deleted_skill", name: "triage-helper", digest, variant: "agent", observedDigest } }, calls),
    <SkillOrphanImportDialog runnerId="runner-1" machineLabel="Build Machine" copy={copy} onClose={() => { closed++; }}
      onImported={async () => undefined} onDiscard={(closeReview) => discards.push(closeReview)} />);
  assert.equal(dialog().querySelector(".modal-title")?.textContent, "Import Orphaned Copy");
  assert.equal(dialog().querySelector(".modal-desc")?.textContent,
    "Importing adds exactly these files to the library, then Build Machine discards its copy if it still matches.");
  assert.deepEqual(facts(), { "Machine": "Build Machine", "Deleted Skill": "triage-helper", "Result": "New skill" });
  assertNotices([]);
  assert.equal(dialog().querySelector(".skill-review-changes-title")?.textContent, "Files");
  assertNoDomNode(footer().querySelector(".review-consent"), "a new skill deploys nothing");
  assert.equal(buttonNamed("Import as New Skill")?.disabled, false);
  assertPlainLanguage();

  const discard = footer().querySelector<HTMLButtonElement>(".modal-tertiary > button")!;
  assert.equal(discard.textContent, "Discard Copy…");
  await act(async () => { discard.click(); });
  assert.equal(closed, 0);
  await act(async () => { discards[0]!(); });
  assert.equal(closed, 1, "a confirmed discard closes the review");
  assert.deepEqual(calls, ["discard:review-1"]);
  await unmount();
});

test("the orphaned-copy review of a kept-aside Manual Only copy that updates a skill", async () => {
  const keptAsideAt = Date.UTC(2026, 8, 3, 14, 2);
  const copy: OrphanedSkillCopy = { kind: "kept_aside", id: "copy-1", name: "code-review", digest, variant: "manual", keptAsideAt,
    observedDigest, observedFingerprint: "c".repeat(64), skillId: "skill-1" };
  const unmount = await mount(orphanClient({ disposition: "update", previousFiles: [file("Library.\n")], assignmentCount: 1 }),
    <SkillOrphanImportDialog runnerId="runner-1" machineLabel="Build Machine" copy={copy} onClose={() => undefined}
      onImported={async () => undefined} onDiscard={() => undefined} discardDisabled />);
  assert.deepEqual(facts(), {
    "Machine": "Build Machine",
    "Kept Aside": new Date(keptAsideAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }),
    "Result": "New version of code-review",
  });
  assertNotices(["The copy was Manual Only. That setting isn't imported; choose it when you assign the skill."]);
  assert.equal(dialog().querySelector(".skill-review-changes-title")?.textContent, "Changes From v2");
  assert.equal(footer().querySelector(".review-consent")?.textContent, "Deploy to 1 existing assignment");
  assert.equal(buttonNamed("Import as New Version")?.disabled, true, "the consent comes first");
  assert.equal(buttonNamed("Discard Copy…")?.disabled, true, "a copy the machine cannot discard now keeps the alternative disabled");
  await unmount();
});

function builtInClient(review: Partial<SkillBuiltInReview>) {
  return {
    ...api,
    getBuiltInSkillVersion: async () => ({
      kind: "update", release: "1.1.0", digest: "r".repeat(64), files: [file("Release.\n")],
      currentVersion: { id: "v3", digest: "m".repeat(64), versionNumber: 3, files: [file("Mine.\n")] },
      expectedLatestVersionId: "v3", assignmentCount: 2, gitAutoUpdate: false, ...review,
    }),
  } as unknown as ApiClient;
}

test("the built-in update review: facts, its notice and the Git warning, and Accept Built-In Update after consent", async () => {
  const unmount = await mount(builtInClient({ gitAutoUpdate: true }),
    <SkillBuiltInReviewDialog skillId="skill-1" skillName="code-review" kind="update" onClose={() => undefined} onAccepted={async () => undefined} />);
  assert.equal(dialog().querySelector(".modal-title")?.textContent, "Review Built-In Update");
  assert.equal(dialog().querySelector(".modal-desc")?.textContent,
    "This Wollipog release updates code-review, whose latest library version has changes made here.");
  assert.deepEqual(facts(), { "Release": "1.1.0", "Library Version": "v3, changed here", "Result": "New version v4" });
  assertNotices([
    "Earlier versions stay in Version History; pinned machines keep their version.",
    "Accepting turns off this skill's automatic Git updates.",
  ]);
  assert.equal(dialog().querySelector(".skill-review-changes-title")?.textContent, "Changes From v3");
  assert.equal(dialog().querySelector(".skill-review-changes-note")?.textContent,
    "Review every file, including scripts. Reviewing and accepting never run skill contents.");
  assert.equal(footer().querySelector(".review-consent")?.textContent, "Deploy to 2 existing assignments");
  assert.equal(buttonNamed("Accept Built-In Update")?.disabled, true);
  assertPlainLanguage();
  await unmount();
});

test("a built-in version that matches the library needs no consent and accepts at once", async () => {
  const unmount = await mount(builtInClient({ kind: "adopt", digest: "m".repeat(64), files: [file("Mine.\n")] }),
    <SkillBuiltInReviewDialog skillId="skill-1" skillName="code-review" kind="adopt" onClose={() => undefined} onAccepted={async () => undefined} />);
  assert.equal(dialog().querySelector(".modal-title")?.textContent, "Review Built-In Version");
  assert.equal(dialog().querySelector(".modal-desc")?.textContent,
    "The built-in version matches v3, so accepting only records where it comes from.");
  assert.deepEqual(facts(), { "Release": "1.1.0", "Library Version": "v3", "Result": "No new version" });
  assertNotices(["Later releases update it on machines that track the latest version. Its assignments and every machine pin stay as they are."]);
  assertNoDomNode(footer().querySelector(".review-consent"));
  assert.equal(buttonNamed("Accept Built-In Version")?.disabled, false);
  await unmount();
});

test("the reviews read the version list only after the preview, so its names never predate the diff", async () => {
  // Drift: the version list is not read while the preview is still being read.
  let resolve!: (preview: SkillDriftPreview) => void;
  const reads: string[] = [];
  const base = driftClient(() => new Promise((done) => { resolve = done; }));
  let unmount = await mount({
    ...base,
    listSkillVersions: async (id: string, before?: string) => { reads.push("versions"); return base.listSkillVersions(id, before); },
  } as ApiClient, <SkillDriftImportDialog skillId="skill-1" runnerId="runner-1" machineLabel="Build Machine"
    copy={{ name: "code-review", digest, variant: "agent" }} onClose={() => undefined} onImported={async () => undefined} />);
  assert.deepEqual(reads, [], "no version is named before the preview's library is known");
  await act(async () => { resolve(driftPreview()); });
  await settle();
  assert.deepEqual(reads, ["versions"]);
  assert.ok(buttonNamed("Import as v4"));
  await unmount();

  // A library that moved after the preview (the copy was of the latest, v3, but the list now leads
  // with v4) names the latest in words; the import's fence refuses that preview anyway.
  unmount = await mount({
    ...driftClient(async () => driftPreview({ publishedFromLatest: true })),
    listSkillVersions: async () => ({ versions: [{ id: "v4", digest: "e".repeat(64), versionNumber: 4 },
      { id: "v3", digest, versionNumber: 3 }], nextCursor: null }),
  } as unknown as ApiClient, <SkillDriftImportDialog skillId="skill-1" runnerId="runner-1" machineLabel="Build Machine"
    copy={{ name: "code-review", digest, variant: "agent" }} onClose={() => undefined} onImported={async () => undefined} />);
  assert.equal(dialog().querySelector(".skill-review-changes-title")?.textContent, "Changes From the Latest Version");
  assert.equal(facts()["Edited Copy Of"], "v3");
  assert.equal(facts()["Result"], "New version");
  assert.ok(buttonNamed("Import as New Version"));
  await unmount();

  // Orphaned copy: the same order.
  let resolveOrphan!: () => void;
  const orphanReads: string[] = [];
  const orphan = orphanClient({ disposition: "update", previousFiles: [file("Library.\n")] });
  unmount = await mount({
    ...orphan,
    previewOrphanedSkillCopy: async (...args: Parameters<ApiClient["previewOrphanedSkillCopy"]>) => {
      await new Promise<void>((done) => { resolveOrphan = done; });
      return orphan.previewOrphanedSkillCopy(...args);
    },
    listSkillVersions: async (id: string) => { orphanReads.push("versions"); return orphan.listSkillVersions(id); },
  } as ApiClient, <SkillOrphanImportDialog runnerId="runner-1" machineLabel="Build Machine"
    copy={{ kind: "kept_aside", id: "copy-1", name: "code-review", observedDigest, observedFingerprint: "c".repeat(64), skillId: "skill-1" }}
    onClose={() => undefined} onImported={async () => undefined} />);
  assert.deepEqual(orphanReads, []);
  await act(async () => { resolveOrphan(); });
  await settle();
  assert.deepEqual(orphanReads, ["versions"]);
  assert.equal(dialog().querySelector(".skill-review-changes-title")?.textContent, "Changes From v2");
  await unmount();
});

test("a built-in review names an unnumbered library version in words, never as None", async () => {
  const unmount = await mount(builtInClient({ currentVersion: { id: "v3", digest: "m".repeat(64), files: [file("Mine.\n")] } }),
    <SkillBuiltInReviewDialog skillId="skill-1" skillName="code-review" kind="update" onClose={() => undefined} onAccepted={async () => undefined} />);
  assert.deepEqual(facts(), { "Release": "1.1.0", "Library Version": "Latest, changed here", "Result": "New version" });
  await unmount();
});

test("the built-in review is titled for what the skill offers before the review is read", async () => {
  const unmount = await mount({ ...api, getBuiltInSkillVersion: () => new Promise(() => {}) } as ApiClient,
    <SkillBuiltInReviewDialog skillId="skill-1" skillName="code-review" kind="adopt" onClose={() => undefined} onAccepted={async () => undefined} />);
  assert.equal(dialog().querySelector(".modal-title")?.textContent, "Review Built-In Version");
  assert.equal(dialog().querySelector(".skill-review-loading")?.textContent, "Reading the built-in version…");
  assert.deepEqual(facts(), { "Release": "Loading", "Library Version": "Loading", "Result": "Loading" });
  await unmount();
});
