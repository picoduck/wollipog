import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { createApiClient } from "../api.js";
import type { InstanceProfile, InstanceRegistrySnapshot } from "../desktop-instances.js";
import { InstanceProvider } from "../InstanceProvider.js";
import type { InstanceRuntime } from "../instance-runtime.js";
import { useInstances, type InstanceManager } from "../instances-context.js";
import { createCloseGuardLinks } from "../desktop-close-guard.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { InstanceRecoveryShell } from "./InstanceRecoveryShell.js";
import { RemoteInstanceBanner } from "./RemoteInstanceBanner.js";
import { assertSameDomNode } from "../dom-test-assertions.js";

const domWindow = new Window({ url: "https://tauri.localhost/" });
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
  PointerEvent: domWindow.PointerEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  PopStateEvent: domWindow.PopStateEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const TOKEN = "abcdefghijklmnop";
const local: InstanceProfile = { id: "local", serverInstanceId: "local", kind: "local", label: "This Machine", origin: "http://127.0.0.1:4317", createdAt: "" };
const studio: InstanceProfile = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  serverInstanceId: "11111111-1111-4111-8111-111111111111",
  kind: "remote",
  label: "Studio",
  origin: "https://studio.test",
  createdAt: "2026-01-01T00:00:00Z",
};

function runtime(instanceId: string): InstanceRuntime {
  const transport = { instanceId, publicOrigin: `https://${instanceId}.test`, async request() { return new Response("{}"); }, close() {} };
  return {
    instanceId,
    publicOrigin: transport.publicOrigin,
    api: createApiClient(transport),
    ui: { instanceId, runtimeKey: `${instanceId}:1`, createSocket() { throw new Error("no socket in this test"); }, close() {} },
    close() {},
  };
}

/** The desktop app's registry, with Studio active and its saved pairing rejected. */
function fixture() {
  let registry: InstanceRegistrySnapshot = { profiles: [local, studio], activeInstanceId: studio.id };
  let added = 0;
  let addGate: Promise<void> | null = null;
  /** Holds the next add until the returned function is called. */
  const holdNextAdd = () => {
    let release!: () => void;
    addGate = new Promise<void>((resolve) => { release = resolve; });
    return release;
  };
  const desktop = {
    isTauri: () => true,
    async invoke<T>(command: string, args?: Record<string, unknown> | Uint8Array): Promise<T> {
      const input = (args ?? {}) as Record<string, string>;
      if (command === "instance_registry") return structuredClone(registry) as T;
      if (command === "set_active_instance") registry = { ...registry, activeInstanceId: input.profileId! };
      else if (command === "add_remote_instance") {
        const gate = addGate;
        addGate = null;
        if (gate) await gate;
        added += 1;
        const profile: InstanceProfile = {
          id: `bbbbbbbb-bbbb-4bbb-8bbb-00000000000${added}`,
          serverInstanceId: `server-${added}`,
          kind: "remote",
          label: input.label!,
          origin: input.origin!,
          createdAt: "2026-01-02T00:00:00Z",
        };
        registry = { ...registry, profiles: [...registry.profiles, profile] };
      } else if (command !== "repair_remote_instance") throw new Error(`unexpected ${command}`);
      return structuredClone(registry) as T;
    },
    channel<T>() { return { onmessage: (_event: T) => {} }; },
  };
  const createRemoteRuntime = async (profileId: string) => {
    if (profileId === studio.id) throw { code: "authentication-required", message: "The pairing token was rejected. Generate a new pairing link." };
    return runtime(profileId);
  };
  return { desktop, createRemoteRuntime, holdNextAdd };
}

const settle = async () => {
  await act(async () => {
    for (let index = 0; index < 4; index += 1) {
      await new Promise<void>((resolve) => domWindow.setTimeout(resolve, 0));
      await new Promise<void>((resolve) => domWindow.requestAnimationFrame(() => resolve()));
    }
  });
};

async function mountApp() {
  const { desktop, createRemoteRuntime, holdNextAdd } = fixture();
  // A switch in an earlier test leaves its instance's address behind; each app starts at the root.
  domWindow.history.replaceState(null, "", "/");
  let manager!: InstanceManager;
  let showPage!: (show: boolean) => void;
  function Page() {
    manager = useInstances();
    const [shown, setShown] = useState(true);
    showPage = setShown;
    if (!shown) return null;
    // The shell's banner and the recovery screen, with its rail menu and Instances list.
    return <><RemoteInstanceBanner authenticationRequired /><InstanceRecoveryShell /></>;
  }
  const host = domWindow.document.createElement("div");
  domWindow.document.body.append(host);
  const root = createRoot(host as unknown as HTMLDivElement);
  await act(async () => {
    root.render(
      <FeedbackProvider>
        <InstanceProvider
          desktop={desktop}
          createLocalRuntime={() => runtime("local")}
          createRemoteRuntime={createRemoteRuntime}
          closeGuardLinks={createCloseGuardLinks()}
        >
          <Page />
        </InstanceProvider>
      </FeedbackProvider>,
    );
  });
  await settle();
  const body = domWindow.document.body as unknown as HTMLElement;
  const dialogs = () => Array.from(body.querySelectorAll<HTMLElement>('[role="dialog"]'));
  const cancel = async () => {
    const dialog = dialogs()[0]!;
    await act(async () => {
      Array.from(dialog.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Cancel")!.click();
    });
    await settle();
  };
  const unmount = async () => {
    await act(async () => { root.unmount(); });
    host.remove();
  };
  return {
    body,
    dialogs,
    cancel,
    unmount,
    holdNextAdd,
    manager: () => manager,
    showPage: (show: boolean) => act(async () => { showPage(show); }),
  };
}

const byText = (scope: ParentNode, selector: string, text: string) =>
  Array.from(scope.querySelectorAll<HTMLButtonElement>(selector)).find((element) => element.textContent?.trim() === text) ?? null;

test("Re-Pair… opens the provider's one dialog from the Instances list, the recovery screen and the banner, and focus returns to each", async () => {
  const app = await mountApp();
  try {
    assert.equal(app.manager().phase, "failed");
    assert.equal(app.manager().statusByProfile[studio.id]?.availability, "authentication-required");
    const row = app.body.querySelector<HTMLElement>(`.instance-row[data-instance-id="${studio.id}"]`)!;
    const openers: Array<[string, HTMLButtonElement | null]> = [
      ["the Instances list", byText(row, "button", "Re-Pair…")],
      ["the recovery screen", byText(app.body.querySelector(".instance-recovery-state")!, "button", "Re-Pair…")],
      ["the remote banner", byText(app.body.querySelector(".notice.page-banner")!, "button", "Re-Pair…")],
    ];
    for (const [where, opener] of openers) {
      assert.ok(opener, `${where} offers Re-Pair`);
      opener.focus();
      await act(async () => { opener.click(); });
      await settle();
      assert.equal(app.dialogs().length, 1, `${where} opens one dialog`);
      assert.equal(app.dialogs()[0]!.querySelector("h2")?.textContent, "Re-Pair Instance", where);
      assert.match(app.dialogs()[0]!.textContent ?? "", /Studio no longer accepts this app's saved pairing\./);
      assert.ok(!app.body.querySelector(".instance-list")?.contains(app.dialogs()[0]!), "the page does not render it");
      const surface = app.dialogs()[0]!.closest(".modal-backdrop") ?? app.dialogs()[0]!;
      assert.ok(surface.contains(domWindow.document.activeElement as never), "focus moved into the dialog");
      await app.cancel();
      assert.equal(app.dialogs().length, 0);
      assertSameDomNode(domWindow.document.activeElement as never, opener as never, `focus returns to ${where}`);
    }

    // The rail's instance menu opens the same dialog's Add form, and focus returns to the tile.
    const tile = app.body.querySelector<HTMLButtonElement>(".instance-tile-trigger")!;
    await act(async () => { tile.click(); });
    await act(async () => { byText(app.body, '[role="menuitem"]', "Add Remote Instance…")!.click(); });
    await settle();
    assert.equal(app.dialogs().length, 1);
    assert.equal(app.dialogs()[0]!.querySelector("h2")?.textContent, "Add Remote Instance");
    await app.cancel();
    assertSameDomNode(domWindow.document.activeElement as never, tile as never, "focus returns to the tile");
  } finally {
    await app.unmount();
  }
});

test("the dialog outlives the page that opened it, keeping what was typed", async () => {
  const app = await mountApp();
  try {
    await act(async () => { byText(app.body, ".instance-recovery-state button", "Add Remote Instance…")!.click(); });
    await settle();
    const name = app.dialogs()[0]!.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      name.value = "Build Farm";
      fireDomEvent.change(name);
    });
    await app.showPage(false);
    await settle();
    assert.equal(app.dialogs().length, 1, "the provider still holds the dialog");
    assert.equal(app.dialogs()[0]!.querySelector<HTMLInputElement>("input")!.value, "Build Farm");
  } finally {
    await app.unmount();
  }
});

test("a dialog replaced while its request runs does not close its replacement when the request ends", async () => {
  const app = await mountApp();
  try {
    await act(async () => { byText(app.body, ".instance-recovery-state button", "Add Remote Instance…")!.click(); });
    await settle();
    const first = app.dialogs()[0]!;
    const [name, link] = Array.from(first.querySelectorAll<HTMLInputElement>('input:not([type="checkbox"])'));
    await act(async () => {
      name!.value = "Laptop";
      fireDomEvent.change(name!);
      link!.value = `https://laptop.test/#pair=${TOKEN}`;
      fireDomEvent.change(link!);
    });
    await act(async () => { first.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); });
    const release = app.holdNextAdd();
    await act(async () => { byText(first, "button", "Add Instance")!.click(); });
    await settle();

    // Something replaces the busy dialog through the manager, as the API allows.
    await act(async () => { app.manager().openInstanceDialog({ mode: "repair", profileId: studio.id }); });
    await settle();
    assert.equal(app.dialogs().length, 1);
    assert.equal(app.dialogs()[0]!.querySelector("h2")?.textContent, "Re-Pair Instance");

    await act(async () => { release(); });
    await settle();
    assert.ok(app.manager().registry.profiles.some((profile) => profile.label === "Laptop"), "the first request finished");
    assert.equal(app.dialogs().length, 1, "the replacement stays open");
    assert.equal(app.dialogs()[0]!.querySelector("h2")?.textContent, "Re-Pair Instance");
  } finally {
    await app.unmount();
  }
});

test("Add Instance saves without switching when Switch After Adding is unchecked, and switches when it is checked", async () => {
  const app = await mountApp();
  try {
    const add = async (label: string, origin: string, switchAfter: boolean) => {
      await act(async () => { byText(app.body, ".instance-recovery-state button", "Add Remote Instance…")!.click(); });
      await settle();
      const dialog = app.dialogs()[0]!;
      const [name, link] = Array.from(dialog.querySelectorAll<HTMLInputElement>('input:not([type="checkbox"])'));
      await act(async () => {
        name!.value = label;
        fireDomEvent.change(name!);
        link!.value = `${origin}/#pair=${TOKEN}`;
        fireDomEvent.change(link!);
      });
      if (!switchAfter) await act(async () => { dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); });
      await act(async () => { byText(dialog, "button", "Add Instance")!.click(); });
      await settle();
      assert.equal(app.dialogs().length, 0, "the dialog closes once the instance is saved");
    };

    await add("Laptop", "https://laptop.test", false);
    assert.ok(app.manager().registry.profiles.some((profile) => profile.label === "Laptop"), "Laptop is saved");
    assert.equal(app.manager().activeProfile.id, studio.id, "the active instance does not change");

    await add("Build Farm", "https://farm.test", true);
    await settle();
    assert.equal(app.manager().activeProfile.label, "Build Farm", "the app switches to it");
    assert.equal(app.manager().registry.activeInstanceId, app.manager().activeProfile.id);
  } finally {
    await app.unmount();
  }
});
