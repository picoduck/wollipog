import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { OnboardingInfo, RunnerCredentialSecret, RunnerView, UiSnapshotMessage } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { InstallManuallyDialog } from "./InstallManuallyDialog.js";
import { RepairConnectionDialog } from "./RepairConnectionDialog.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
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
  InputEvent: domWindow.InputEvent,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const body = domWindow.document.body as unknown as HTMLElement;

class FakeSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
  push(message: UiSnapshotMessage) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const navigation: ViewNavigation = { current: () => ({ name: "runners" }), push() {}, listen: () => () => {} };

function snapshot(runners: RunnerView[]): UiSnapshotMessage {
  return {
    type: "snapshot",
    capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: false },
    runners,
    boxes: [],
    sessions: [],
    runs: [],
    pods: [],
  };
}

function runner(overrides: Partial<RunnerView> = {}): RunnerView {
  return {
    runnerId: "gpu-lab-01",
    hostname: "gpu-lab",
    os: "linux",
    version: "1.0.0",
    status: "online",
    agents: [{
      id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex-app-server",
      available: true, authStatus: "authenticated", codexAppServer: { status: "supported", appServerAvailable: true },
    }],
    workspaces: [],
    connectedAt: 1,
    lastSeen: 1,
    agentsRefreshed: true,
    ...overrides,
  };
}

const info: OnboardingInfo = {
  runnerWsUrl: "ws://127.0.0.1:4417/runner",
  host: "0.0.0.0",
  port: 4417,
  lanIps: ["192.0.2.10"],
  existingRunnerIds: [],
};

function secretFor(runnerId: string): RunnerCredentialSecret {
  return {
    token: "wollipog_runner_secret",
    credential: {
      credentialId: "cred-1", runnerId, organizationId: "org", scope: { kind: "organization" } as never,
      label: "x", status: "pending", createdAt: 1, expiresAt: null, activatedAt: null, lastUsedAt: null, revokedAt: null, legacy: false,
    },
  };
}

let sequence = 0;
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function WhenReady({ children }: { children: React.ReactNode }) {
  return useStoreSelector((state) => state.snapshotLoaded) ? <>{children}</> : null;
}

async function mount(node: React.ReactNode, client: Partial<ApiClient>, runners: RunnerView[] = []) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  body.append(container);
  const root = createRoot(container);
  const socket = new FakeSocket();
  sequence += 1;
  const connection: UiConnectionRuntime = {
    instanceId: `runner-setup-${sequence}`,
    runtimeKey: `runner-setup-${sequence}:1`,
    createSocket: () => socket,
    close() {},
  };
  const merged = { ...api, listSkills: async () => ({ skills: [] }), ...client } as unknown as ApiClient;
  await act(async () => {
    root.render(
      <ApiProvider client={merged}>
        <StoreProvider connection={connection} navigation={navigation}>
          <WhenReady>{node}</WhenReady>
        </StoreProvider>
      </ApiProvider>,
    );
  });
  await act(async () => { socket.push(snapshot(runners)); });
  await act(settle);
  return {
    push: async (views: RunnerView[]) => {
      await act(async () => { socket.push(snapshot(views)); });
      await act(settle);
    },
    unmount: async () => {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

const dialog = () => body.querySelector<HTMLElement>('[role="dialog"]')!;
const buttonNamed = (label: string) => [...dialog().querySelectorAll<HTMLButtonElement>("button")]
  .find((candidate) => candidate.textContent?.trim() === label);
const check = (label: string) => [...dialog().querySelectorAll<HTMLLIElement>(".connection-check > li")]
  .find((row) => row.querySelector("strong")?.textContent?.endsWith(label));
const footer = () => dialog().querySelector<HTMLElement>(".modal-foot")!;

test("Install Manually opens with no spinner, then waits for the runner after the credential, and Done turns on when it connects", async () => {
  const issued: string[] = [];
  const view = await mount(<InstallManuallyDialog onClose={() => {}} />, {
    getOnboarding: async () => ({ ...info, existingRunnerIds: ["runner"] }),
    issueRunnerCredential: async (runnerId: string) => { issued.push(runnerId); return secretFor(runnerId); },
  });
  try {
    assert.equal(dialog().querySelector(".modal-title, h2")?.textContent, "Install Manually");
    assert.ok(body.querySelector(".modal.sheet-full"), "a full-height phone sheet");
    assertNoDomNode(dialog().querySelector(".spinner"), "nothing spins before the person acts");
    const connection = check("Runner Connection")!;
    assert.ok(connection.classList.contains("connection-check-waiting"));
    assert.ok(connection.querySelector(".connection-check-icon svg"), "a hollow circle");
    assert.equal(footer().querySelector(".runner-setup-reason")?.textContent, "Done turns on when the runner connects.");
    assert.equal(buttonNamed("Done")?.disabled, true);
    const generate = buttonNamed("Generate Credential")!;
    assert.equal(generate.classList.contains("primary"), false, "Generate Credential is never a primary");
    assert.equal(dialog().querySelectorAll(".btn.primary").length, 1, "Done is the only primary");

    // Rename the runner, then issue its credential.
    const name = dialog().querySelector<HTMLInputElement>("input")!;
    // React's change plugin watches the focused input and its keyup, as a person would type.
    await act(async () => {
      name.focus();
      Object.getOwnPropertyDescriptor(domWindow.HTMLInputElement.prototype, "value")!.set!.call(name, "gpu-lab-01");
      name.dispatchEvent(new domWindow.InputEvent("input", { bubbles: true }) as unknown as Event);
      name.dispatchEvent(new domWindow.KeyboardEvent("keyup", { bubbles: true, key: "1" }) as unknown as Event);
    });
    assert.equal(name.value, "gpu-lab-01");
    assert.match(dialog().textContent ?? "", /one-time credential for gpu-lab-01\./);
    await act(async () => { buttonNamed("Generate Credential")!.click(); });
    await act(settle);
    assert.deepEqual(issued, ["gpu-lab-01"]);
    assert.equal(buttonNamed("Generate Credential"), undefined, "a credential is issued once per dialog");
    assert.ok(dialog().textContent?.includes("Shown once. Save it now and restrict the file to the runner's account."));
    const waiting = check("Runner Connection")!;
    assert.ok(waiting.classList.contains("connection-check-pending"));
    assert.ok(waiting.querySelector(".spinner"));
    assert.ok(waiting.textContent?.includes("Waiting for gpu-lab-01 to connect…"));
    assert.ok(footer().textContent?.includes("Waiting for the runner…"));
    assert.equal(buttonNamed("Done")?.disabled, true);
    // The workspace was left blank, so it is not checked at all.
    assert.equal(check("Workspace"), undefined);

    await view.push([runner()]);
    assert.ok(check("Runner Connection")!.classList.contains("connection-check-pass"));
    assert.equal(buttonNamed("Done")?.disabled, false);
    assertNoDomNode(footer().querySelector(".runner-setup-reason"));
    assertNoDomNode(dialog().querySelector(".connection-check-fail"), "no workspace failure");
  } finally {
    await view.unmount();
  }
});

test("Connects To reads in words, and a remote host adds one compact warning and the plaintext acknowledgement", async () => {
  const view = await mount(<InstallManuallyDialog onClose={() => {}} />, { getOnboarding: async () => info });
  try {
    const trigger = dialog().querySelector<HTMLButtonElement>('button[aria-label^="Connects To"], .ui-select button')!;
    assert.ok(trigger.textContent?.includes("This computer (127.0.0.1)"));
    assertNoDomNode(dialog().querySelector(".notice.t-warning"));
    assert.ok(!dialog().textContent?.includes("--allow-insecure-transport"));
    await act(async () => { trigger.click(); });
    const option = [...body.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((candidate) => candidate.textContent?.includes("192.0.2.10 (local network)"))!;
    assert.ok(option, "the LAN address reads in words");
    await act(async () => { option.click(); });
    await act(settle);
    const warnings = dialog().querySelectorAll(".notice.t-warning.compact");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!.textContent ?? "", /port 4417/);
    assert.match(warnings[0]!.textContent ?? "", /isn't encrypted/);
    assert.doesNotMatch(warnings[0]!.textContent ?? "", /CONTROL_PLANE_HOST/);
    assert.ok([...dialog().querySelectorAll(".code-well code")].some((code) => code.textContent?.endsWith("--allow-insecure-transport")));
  } finally {
    await view.unmount();
  }
});

test("a setup-details load failure shows the danger notice with Retry and only Cancel, in a normal-height sheet", async () => {
  let attempts = 0;
  const view = await mount(<InstallManuallyDialog onClose={() => {}} />, {
    getOnboarding: async () => { attempts += 1; throw new Error("HTTP 503"); },
  });
  try {
    const notice = dialog().querySelector(".notice.t-danger")!;
    assert.equal(notice.querySelector(".notice-title")?.textContent, "Couldn't Load Setup Details");
    assert.ok([...notice.querySelectorAll("button")].some((candidate) => candidate.textContent?.trim() === "Retry"));
    assert.ok([...notice.querySelectorAll("button")].some((candidate) => candidate.textContent?.trim() === "Show Details"));
    assert.deepEqual([...footer().querySelectorAll("button")].map((candidate) => candidate.textContent), ["Cancel"]);
    assertNoDomNode(body.querySelector(".modal.sheet-full"), "the load failure keeps the normal sheet height");
    await act(async () => { [...notice.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === "Retry")!.click(); });
    await act(settle);
    assert.equal(attempts, 2);
  } finally {
    await view.unmount();
  }
});

test("Repair Connection shows the runner as text, two steps, and checks only the workspaces it already knows", async () => {
  const known = runner({ status: "offline", workspaces: [{ id: "models", name: "Models", path: "/data/models" }] });
  const view = await mount(<RepairConnectionDialog runnerId="gpu-lab-01" onClose={() => {}} />, {
    issueRunnerCredential: async () => { throw new Error("This runner already has an active credential; rotate it instead."); },
    rotateRunnerCredential: async (runnerId: string) => secretFor(runnerId),
  }, [known]);
  try {
    assert.equal(dialog().querySelector(".modal-title, h2")?.textContent, "Repair Connection");
    assert.ok(body.querySelector(".modal.sheet-full"), "a full-height phone sheet");
    assert.ok(dialog().textContent?.includes("gpu-lab-01"));
    assert.equal(dialog().querySelectorAll("input").length, 0, "no host, workspace or runner fields");
    assert.equal(dialog().querySelectorAll(".runner-setup-steps > li").length, 2);
    assert.deepEqual([...dialog().querySelectorAll(".runner-setup-steps > li > h3")].map((h) => h.textContent),
      ["Replace the Credential", "Restart the Runner"]);
    assertNoDomNode(dialog().querySelector(".spinner"));
    assert.equal(buttonNamed("Done")?.disabled, true);

    await act(async () => { buttonNamed("Generate Replacement Credential")!.click(); });
    await act(settle);
    assert.ok(dialog().querySelector(".code-well.one-line code")?.textContent === "wollipog_runner_secret");
    assert.equal(buttonNamed("Generate Replacement Credential"), undefined);
    assert.ok(check("Runner Connection")!.querySelector(".spinner"));

    // The runner comes back with the workspace it already had, not a default "my-repo".
    await view.push([runner({ workspaces: [{ id: "models", name: "Models", path: "/data/models" }] })]);
    assert.ok(check("Runner Connection")!.classList.contains("connection-check-pass"));
    assert.ok(check("Workspace")!.classList.contains("connection-check-pass"));
    assert.doesNotMatch(dialog().textContent ?? "", /has not advertised/);
    assert.equal(buttonNamed("Done")?.disabled, false);
  } finally {
    await view.unmount();
  }
});
