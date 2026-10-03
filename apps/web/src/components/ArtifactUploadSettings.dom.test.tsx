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
  Event: dom.Event, React, IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  getComputedStyle: dom.getComputedStyle.bind(dom),
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

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
    const trigger = () => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.getAttribute("aria-label")?.startsWith("Artifact Uploads:"))!;
    assert.equal(trigger().getAttribute("aria-label"), "Artifact Uploads: Manual");
    for (const [label, value] of [["Use Wollipog Automatically", "wollipog_automatic"], ["Use External Hosting", "external_hosting"]]) {
      await act(async () => trigger().click());
      const option = [...document.querySelectorAll<HTMLElement>("[role=option]")].find((el) => el.textContent?.includes(label!));
      assert.ok(option);
      await act(async () => option.click());
      assert.equal(saves.at(-1), value);
      assert.equal(trigger().getAttribute("aria-label"), `Artifact Uploads: ${label}`);
    }
    api.updateArtifactUploadSettings = async () => { throw new Error("Server unavailable"); };
    await act(async () => trigger().click());
    await act(async () => [...document.querySelectorAll<HTMLElement>("[role=option]")].find((el) => el.textContent?.startsWith("Manual"))!.click());
    assert.equal(trigger().getAttribute("aria-label"), "Artifact Uploads: Use External Hosting");
    assert.match(container.querySelector("[role=alert]")?.textContent ?? "", /Server unavailable/);
  } finally {
    await act(async () => root.unmount()); container.remove();
    api.artifactUploadSettings = get; api.updateArtifactUploadSettings = put;
  }
});

test("old control planes leave Manual disabled with an actionable explanation", async () => {
  const get = api.artifactUploadSettings;
  api.artifactUploadSettings = async () => { throw new ApiError("Not found", 404); };
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<ArtifactUploadSettings />));
    assert.match(container.querySelector("[role=alert]")?.textContent ?? "", /Update Wollipog/);
    assert.equal(container.querySelector<HTMLButtonElement>("button")?.getAttribute("aria-disabled"), "true");
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
    assert.doesNotMatch(container.textContent ?? "", /preference saved/);
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
