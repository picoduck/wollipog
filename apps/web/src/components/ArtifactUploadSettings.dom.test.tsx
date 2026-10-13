import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { api, ApiError } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { InstanceScopeProvider } from "../instance-scope.js";
import { instanceStorageKey } from "../instance-storage.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { ArtifactUploadSettings } from "./ArtifactUploadSettings.js";
import { ArtifactUploadNotice, ARTIFACT_UPLOAD_NOTICE_KEY } from "./ArtifactUploadNotice.js";

const dom = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement, HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event, Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  getComputedStyle: dom.getComputedStyle.bind(dom),
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const trigger = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.getAttribute("aria-label")?.startsWith("Artifact Uploads:"))!;
const description = (container: HTMLElement) => container.querySelector(".setting-row-desc:not([aria-hidden])")?.textContent;
async function choose(container: HTMLElement, label: string) {
  await act(async () => trigger(container).click());
  const option = [...document.querySelectorAll<HTMLElement>("[role=option]")].find((el) => el.textContent?.startsWith(label));
  assert.ok(option, `the list offers ${label}`);
  await act(async () => option.click());
}

test("artifact preference defaults to Manual and confirms both saved modes only after the server accepts them", async () => {
  const get = api.artifactUploadSettings;
  const put = api.updateArtifactUploadSettings;
  const saves: string[] = [];
  api.artifactUploadSettings = async () => ({ preference: "manual" });
  api.updateArtifactUploadSettings = async (input) => { saves.push(input.preference); return input; };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ArtifactUploadSettings />));
    assert.equal(saves.length, 0, "opening Settings must never save or enable uploads");
    // The Evidence group (#3023): its head names where the preference is kept.
    assert.equal(container.querySelector(".settings-group-title")?.textContent, "Evidence");
    assert.equal(container.querySelector(".settings-group-scope")?.textContent, "Your Account");
    // One sentence under the title, the chosen option's; the rest is under About Artifact Uploads.
    assert.equal(description(container), "Upload only when the task or project asks for it.");
    const about = container.querySelector<HTMLDetailsElement>(".settings-group-foot > details.disclosure")!;
    assert.ok(about, "the rest of the text is a disclosure under the surface");
    assert.equal(about.querySelector("summary")?.textContent, "About Artifact Uploads");
    assert.equal(about.open, false, "closed until asked for");
    assert.match(about.textContent ?? "", /Native TUI sessions do not receive this guidance automatically/, "Settings must explain the native TUI delivery limit");
    assert.match(about.textContent ?? "", /Explicit task and project hosting requirements take priority/);
    assert.equal(trigger(container).getAttribute("aria-label"), "Artifact Uploads: Manual");
    for (const [label, value, sentence] of [
      ["Use Wollipog Automatically", "wollipog_automatic", "Authorize private uploads of relevant task evidence, including screenshots and videos."],
      ["Use External Hosting", "external_hosting", "Prefer the task's external hosting workflow."],
    ] as const) {
      await choose(container, label);
      assert.equal(saves.at(-1), value);
      assert.equal(trigger(container).getAttribute("aria-label"), `Artifact Uploads: ${label}`);
      assert.equal(description(container), sentence, "the description follows the value");
      // The §8.6 check and its announcement, not a paragraph under the row.
      assert.ok(container.querySelector(".setting-row-saved"), "the Saved check shows after the change");
      assert.equal(container.querySelector("[role=status]")?.textContent, "Artifact Uploads saved");
    }
    assertNoDomNode(container.querySelector("[role=alert]"), "nothing failed");
  } finally {
    await act(async () => root.unmount()); container.remove();
    api.artifactUploadSettings = get; api.updateArtifactUploadSettings = put;
  }
});

test("a failed save is a danger notice above the surface whose Retry repeats the change", async () => {
  const get = api.artifactUploadSettings;
  const put = api.updateArtifactUploadSettings;
  const saves: string[] = [];
  api.artifactUploadSettings = async () => ({ preference: "external_hosting" });
  api.updateArtifactUploadSettings = async () => { throw new ApiError("upload preference store is read-only", 500); };
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<ArtifactUploadSettings />));
    await choose(container, "Manual");
    assert.equal(trigger(container).getAttribute("aria-label"), "Artifact Uploads: Use External Hosting", "the confirmed value stays");
    assertNoDomNode(container.querySelector(".setting-row-saved"));
    const notice = container.querySelector<HTMLElement>("[role=alert]")!;
    assert.ok(notice, "the failure is announced");
    assert.ok(notice.closest(".settings-group"), "inside the Evidence group");
    assert.ok(notice.compareDocumentPosition(container.querySelector(".settings-group-surface")!) & Node.DOCUMENT_POSITION_FOLLOWING,
      "above the surface");
    assert.equal(notice.textContent?.startsWith("Artifact Uploads wasn't saved. Try again."), true, notice.textContent ?? "");
    assert.equal(notice.querySelector("[title]")?.getAttribute("title"), "upload preference store is read-only", "the server's words are the detail");
    api.updateArtifactUploadSettings = async (input) => { saves.push(input.preference); return input; };
    const retry = [...notice.querySelectorAll("button")].find((button) => button.textContent === "Retry")!;
    await act(async () => retry.click());
    assert.deepEqual(saves, ["manual"], "Retry repeats the change that failed");
    assert.equal(trigger(container).getAttribute("aria-label"), "Artifact Uploads: Manual");
    assertNoDomNode(container.querySelector("[role=alert]"));
  } finally {
    await act(async () => root.unmount()); container.remove();
    api.artifactUploadSettings = get; api.updateArtifactUploadSettings = put;
  }
});

test("a rejected fetch reads as an unreachable Wollipog, never the browser's own words", async () => {
  const get = api.artifactUploadSettings;
  const put = api.updateArtifactUploadSettings;
  let reads = 0;
  api.artifactUploadSettings = async () => {
    reads += 1;
    if (reads === 1) throw new TypeError("Failed to fetch");
    return { preference: "manual" };
  };
  api.updateArtifactUploadSettings = async () => { throw new TypeError("Failed to fetch"); };
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<ArtifactUploadSettings />));
    const alert = () => container.querySelector<HTMLElement>("[role=alert]");
    assert.match(alert()?.textContent ?? "", /^Couldn't reach Wollipog\. Check the connection, then try again\.Retry$/);
    assert.doesNotMatch(container.textContent ?? "", /Failed to fetch/);
    assert.equal(trigger(container).getAttribute("aria-disabled"), "true", "nothing to change until the read answers");
    // Retry after a failed read reads again.
    await act(async () => [...alert()!.querySelectorAll("button")].find((button) => button.textContent === "Retry")!.click());
    assert.equal(reads, 2);
    assertNoDomNode(alert());
    assert.notEqual(trigger(container).getAttribute("aria-disabled"), "true");
    await choose(container, "Use External Hosting");
    assert.match(alert()?.textContent ?? "", /^Couldn't reach Wollipog\. Check the connection, then try again\.Retry$/);
    assert.doesNotMatch(container.textContent ?? "", /Failed to fetch/);
    assert.ok([...alert()!.querySelectorAll("button")].some((button) => button.textContent === "Retry"));
  } finally {
    await act(async () => root.unmount()); container.remove();
    api.artifactUploadSettings = get; api.updateArtifactUploadSettings = put;
  }
});

test("old control planes leave Manual disabled with the reason to update", async () => {
  const get = api.artifactUploadSettings;
  api.artifactUploadSettings = async () => { throw new ApiError("Not found", 404); };
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<ArtifactUploadSettings />));
    assertNoDomNode(container.querySelector("[role=alert]"), "an old server is not a failure to retry");
    assert.equal(trigger(container).getAttribute("aria-disabled"), "true");
    assert.equal(container.querySelector(".setting-row-reason")?.textContent, "Update Wollipog to change this setting.");
  } finally { await act(async () => root.unmount()); container.remove(); api.artifactUploadSettings = get; }
});

test("a late save from another instance cannot replace the active instance's preference", async () => {
  let resolveSave!: (value: { preference: "wollipog_automatic" }) => void;
  const first = { ...api, artifactUploadSettings: async () => ({ preference: "manual" as const }),
    updateArtifactUploadSettings: () => new Promise<{ preference: "wollipog_automatic" }>((resolve) => { resolveSave = resolve; }) };
  const second = { ...api, artifactUploadSettings: async () => ({ preference: "external_hosting" as const }) };
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const render = (client: typeof api, scope: string) => root.render(<ApiProvider client={client}><InstanceScopeProvider instanceScope={scope}><ArtifactUploadSettings /></InstanceScopeProvider></ApiProvider>);
  try {
    await act(async () => render(first, "first"));
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    await act(async () => [...document.querySelectorAll<HTMLElement>("[role=option]")].find((el) => el.textContent?.includes("Use Wollipog Automatically"))!.click());
    assert.equal(container.querySelector("button")?.getAttribute("aria-label"), "Artifact Uploads: Manual", "pending saves retain the last confirmed choice");
    await act(async () => render(second, "second"));
    await act(async () => resolveSave({ preference: "wollipog_automatic" }));
    assert.equal(container.querySelector("button")?.getAttribute("aria-label"), "Artifact Uploads: Use External Hosting");
    assertNoDomNode(container.querySelector(".setting-row-saved"), "the other instance's save is not confirmed here");
  } finally { await act(async () => root.unmount()); container.remove(); }
});

test("discovery links to Behavior and dismissal persists only for its instance without saving upload preferences", async () => {
  const put = api.updateArtifactUploadSettings;
  let saves = 0;
  api.updateArtifactUploadSettings = async (input) => { saves++; return input; };
  dom.localStorage.clear();
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const render = (scope: string) => root.render(<ApiProvider><InstanceScopeProvider instanceScope={scope}><ArtifactUploadNotice /></InstanceScopeProvider></ApiProvider>);
  try {
    await act(async () => render("first"));
    assert.equal(container.querySelector("a")?.getAttribute("href"), "/settings/behavior");
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    assertNoDomNode(container.querySelector("[role=note]"));
    assert.equal(dom.localStorage.getItem(instanceStorageKey(ARTIFACT_UPLOAD_NOTICE_KEY, "first")), "1");
    await act(async () => render("second"));
    assert.ok(container.querySelector("[role=note]"));
    await act(async () => render("first"));
    assertNoDomNode(container.querySelector("[role=note]"));
    assert.equal(saves, 0);
  } finally { await act(async () => root.unmount()); container.remove(); api.updateArtifactUploadSettings = put; dom.localStorage.clear(); }
});
