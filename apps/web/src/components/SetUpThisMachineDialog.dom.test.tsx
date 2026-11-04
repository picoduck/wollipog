import assert from "node:assert/strict";
import test, { afterEach, describe, mock } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { IdentityAdministrationView, OnboardingInfo, RunnerView, UiSnapshotMessage } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { browserInstanceManager, InstancesContextProvider } from "../instances-context.js";
import type { LocalRunnerStatus } from "../local-runner.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { RunnersView } from "./RunnersView.js";
import {
  LOCAL_RUNNER_STATUS_POLL_MS,
  RUNNER_CONNECT_WAIT_MS,
  SetUpThisMachineDialog,
  setUpPhase,
} from "./SetUpThisMachineDialog.js";

/**
 * Set Up This Machine (#2993) with the desktop bridge mocked: `local_runner_status` and
 * `connect_local_runner` are answered by the test, the runner's progress arrives as snapshots.
 */

const domWindow = new Window({ url: "http://localhost/", width: 1440, height: 900 });
installDomTestCleanup(domWindow);
/** The media queries the stub answers `true` for; a phone adds the sheet breakpoint. */
let matchingMedia = new Set<string>();
const PHONE = "(max-width: 760px)";
Object.defineProperty(domWindow, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    get matches() { return matchingMedia.has(query); },
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }),
});
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  HTMLSelectElement: domWindow.HTMLSelectElement,
  HTMLTextAreaElement: domWindow.HTMLTextAreaElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  InputEvent: domWindow.InputEvent,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  FocusEvent: domWindow.FocusEvent,
  MutationObserver: domWindow.MutationObserver,
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
  getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
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
  push(message: UiSnapshotMessage) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

const navigation: ViewNavigation = { current: () => ({ name: "runners", section: "machines" }), push() {}, listen: () => () => {} };

function snapshot(runners: RunnerView[]): UiSnapshotMessage {
  return {
    type: "snapshot",
    capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
    runners, boxes: [], projects: [], sessions: [], runs: [], pods: [],
  };
}

const codexReady: RunnerView["agents"][number] = {
  id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex-app-server",
  available: true, authStatus: "authenticated", codexAppServer: { status: "supported", appServerAvailable: true },
};
const claudeSignedOut: RunnerView["agents"][number] = {
  id: "claude-wsl", name: "Claude Code", command: "claude", args: [], env: {}, driver: "claude-code",
  context: { kind: "wsl", distro: "Ubuntu" }, available: false, authStatus: "unauthenticated",
};

function machine(overrides: Partial<RunnerView> = {}): RunnerView {
  return {
    runnerId: "this-machine",
    hostname: "studio",
    os: "linux",
    version: "1.0.0",
    status: "online",
    agents: [codexReady, claudeSignedOut],
    workspaces: [],
    connectedAt: 1,
    lastSeen: 1,
    agentsRefreshed: true,
    protocolVersion: 63,
    ...overrides,
  };
}

const info: OnboardingInfo = {
  runnerWsUrl: "ws://127.0.0.1:4417/runner",
  host: "127.0.0.1",
  port: 4417,
  lanIps: [],
  existingRunnerIds: [],
};

const notSetUp: LocalRunnerStatus = { available: true, enabled: false, running: false, runnerId: null };
const started: LocalRunnerStatus = { available: true, enabled: true, running: true, runnerId: "this-machine" };

interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void; reject: (cause: Error) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/**
 * The desktop bridge. Each `connect_local_runner` call waits on its own deferred, so a test settles
 * it; its reply becomes what `local_runner_status` reports next, until a test sets another.
 */
function installBridge(initial: LocalRunnerStatus | Error) {
  let status = initial;
  const connects: { runnerId: string; answer: Deferred<LocalRunnerStatus> }[] = [];
  Object.defineProperty(globalThis, "isTauri", { configurable: true, writable: true, value: true });
  Object.defineProperty(domWindow, "__TAURI_INTERNALS__", {
    configurable: true,
    writable: true,
    value: {
      invoke: async (command: string, args?: { runnerId?: string }) => {
        if (command === "local_runner_status") {
          if (status instanceof Error) throw status;
          return status;
        }
        if (command === "connect_local_runner") {
          const answer = deferred<LocalRunnerStatus>();
          connects.push({ runnerId: args?.runnerId ?? "", answer });
          return answer.promise.then((next) => { status = next; return next; });
        }
        throw new Error(`${command} is not part of this test`);
      },
    },
  });
  return Object.assign(connects, { setStatus: (next: LocalRunnerStatus) => { status = next; } });
}

afterEach(() => {
  mock.timers.reset();
  matchingMedia = new Set();
  Reflect.deleteProperty(globalThis, "isTauri");
  Reflect.deleteProperty(domWindow, "__TAURI_INTERNALS__");
});

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

function WhenReady({ children }: { children: React.ReactNode }) {
  return useStoreSelector((state) => state.snapshotLoaded) ? <>{children}</> : null;
}

let sequence = 0;
const recommended = { id: "skill-wollipog", name: "using-wollipog", builtIn: true, recommendation: { dismissed: false }, assignmentCount: 0 };

async function mount(node: React.ReactNode, client: Partial<ApiClient> = {}, runners: RunnerView[] = []) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  body.append(container);
  const root = createRoot(container);
  const socket = new FakeSocket();
  sequence += 1;
  const connection: UiConnectionRuntime = {
    instanceId: `set-up-machine-${sequence}`,
    runtimeKey: `set-up-machine-${sequence}:1`,
    createSocket: () => socket,
    close() {},
  };
  const merged = {
    ...api,
    getOnboarding: async () => info,
    listSkills: async () => ({ skills: [recommended] }),
    getIdentity: async () => ({ context: { role: "owner" }, organizations: [], memberships: [], teams: [] }) as unknown as IdentityAdministrationView,
    sshConfigHosts: async () => ({ hosts: [] }),
    ...client,
  } as unknown as ApiClient;
  await act(async () => {
    root.render(
      <ApiProvider client={merged}>
        <InstancesContextProvider value={browserInstanceManager}>
          <FeedbackProvider>
            <StoreProvider connection={connection} navigation={navigation}>
              <WhenReady>{node}</WhenReady>
            </StoreProvider>
          </FeedbackProvider>
        </InstancesContextProvider>
      </ApiProvider>,
    );
  });
  await act(async () => { socket.push(snapshot(runners)); });
  await settle();
  return {
    push: async (views: RunnerView[]) => {
      await act(async () => { socket.push(snapshot(views)); });
      await settle();
    },
    /** `push` for a test on fake timers, where `settle` would never return. */
    pushNow: async (views: RunnerView[]) => {
      await act(async () => { socket.push(snapshot(views)); });
    },
    unmount: async () => {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

const dialogs = () => [...body.querySelectorAll<HTMLElement>('[role="dialog"]')];
const dialogNamed = (title: string) => dialogs().find((dialog) => dialog.querySelector(".modal-title, h2")?.textContent === title);
const dialog = () => dialogNamed("Set Up This Machine")!;
const buttonNamed = (label: string, root: HTMLElement = dialog()) => [...root.querySelectorAll<HTMLButtonElement>("button")]
  .find((candidate) => candidate.textContent?.trim() === label);
const check = (label: string) => [...dialog().querySelectorAll<HTMLLIElement>(".connection-check > li")]
  .find((row) => row.querySelector("strong")?.textContent?.endsWith(label));
const footer = () => dialog().querySelector<HTMLElement>(".modal-foot")!;

/** The one primary is the footer's, and the dialog draws no text glyph for an icon. */
function assertOnePrimaryInFooter(label: string) {
  const primaries = [...dialog().querySelectorAll<HTMLButtonElement>(".btn.primary")];
  assert.deepEqual(primaries.map((button) => button.textContent?.trim()), [label], "one primary");
  assert.ok(footer().contains(primaries[0]!), "the primary is in the footer");
  // The old local mode drew ✓ and ! as its status mark.
  assert.doesNotMatch(dialog().textContent ?? "", /[✓✕×↻!]/u, "no text glyph");
}

test("Set Up This Machine starts on open, shows its checklist with icons, then the Connection Check, then the agents as rows", async () => {
  const connects = installBridge(notSetUp);
  const changed: LocalRunnerStatus[] = [];
  const view = await mount(<SetUpThisMachineDialog onClose={() => {}} onLocalRunnerChanged={(status) => changed.push(status)} />);
  try {
    // Ready to Set Up, with the setup that starts on open already running.
    assert.equal(dialog().querySelector(".modal-desc")?.textContent, "Run agents on the computer Wollipog is running on.");
    assert.deepEqual(connects.map(({ runnerId }) => runnerId), ["this-machine"], "the setup starts on open, once");
    const checklist = [...dialog().querySelectorAll(".set-up-machine-checklist > li")];
    assert.deepEqual(checklist.map((item) => item.textContent), [
      "No Node.js, repository clone, config file or terminal command",
      "Starts automatically with Wollipog",
      "Discovers supported native and WSL coding agents",
    ]);
    assert.ok(checklist.every((item) => item.querySelector("svg")), "a check icon on every line");
    assertOnePrimaryInFooter("Set Up This Machine");
    const primary = buttonNamed("Set Up This Machine")!;
    assert.equal(primary.getAttribute("aria-busy"), "true", "its spinner while it works");
    assert.ok(primary.querySelector(".spinner"));
    assert.equal(primary.textContent?.trim(), "Set Up This Machine", "the label stays; no Setting Up… swap");
    const tertiary = buttonNamed("Install Manually Instead")!;
    assert.ok(tertiary.classList.contains("ghost"));
    assert.ok(footer().contains(tertiary), "a footer tertiary on desktop");

    // Setting Up: the runner started; Wollipog waits for it to connect.
    await act(async () => { connects[0]!.answer.resolve(started); });
    await settle();
    assert.deepEqual(changed, [started]);
    assertNoDomNode(dialog().querySelector(".set-up-machine-checklist"), "the checklist gives way to the check");
    assert.ok(check("Bundled Runner")!.classList.contains("connection-check-pass"));
    assert.ok(check("Runner Connection")!.classList.contains("connection-check-pending"));
    assert.ok(check("Agent Readiness")!.classList.contains("connection-check-waiting"));
    assert.equal(dialog().querySelectorAll(".connection-check .spinner").length, 1, "only the running step spins");
    assertOnePrimaryInFooter("Done");
    assert.equal(buttonNamed("Done")!.disabled, true);
    assert.ok(footer().textContent?.includes("Waiting for the runner…"));
    assert.equal(buttonNamed("Install Manually Instead"), undefined, "no alternative while it sets up");

    // Connected, still discovering its agents.
    await view.push([machine({ agentsRefreshed: false })]);
    assert.ok(check("Runner Connection")!.classList.contains("connection-check-pass"));
    assert.ok(check("Agent Readiness")!.classList.contains("connection-check-pending"));
    assert.equal(dialog().querySelectorAll(".connection-check .spinner").length, 1, "only the running step spins");

    // Ready: a success notice, the agents as rows with one status each, and Done.
    await view.push([machine()]);
    const notice = dialog().querySelector(".notice")!;
    assert.match(notice.textContent ?? "", /This Machine Is Ready/);
    assert.match(notice.textContent ?? "", /1 coding agent is ready to use\./);
    const rows = [...dialog().querySelectorAll('.surface[aria-label="Agents on This Machine"] > li.row')];
    assert.deepEqual(rows.map((row) => [
      row.querySelector(".row-title")?.textContent,
      row.querySelector(".row-sub")?.textContent,
      row.querySelector(".status")?.textContent,
    ]), [
      ["Codex", "Native", "Ready"],
      // The machine's own agent vocabulary (#2990): what the agent needs, not "Needs Attention".
      ["Claude Code", "WSL: Ubuntu", "Sign-In Required"],
    ]);
    assertNoDomNode(dialog().querySelector(".onboard-local-agents"), "no chip strip");
    assertOnePrimaryInFooter("Done");
    assert.equal(buttonNamed("Done")!.disabled, false);
    assert.equal(buttonNamed("Install Manually Instead"), undefined);
    const skills = dialog().querySelector('[aria-label="Recommended Skills"]')!;
    assert.ok(skills, "Recommended Skills follows the result");
    assert.ok(buttonNamed("Open Skills", skills as HTMLElement));
  } finally {
    await view.unmount();
  }
});

test("Needs Attention offers Rediscover when the agents need attention, and the primary stays Done", async () => {
  const connects = installBridge(started);
  const rediscovered: string[] = [];
  const view = await mount(<SetUpThisMachineDialog onClose={() => {}} />, {
    rediscover: async (runnerId: string) => { rediscovered.push(runnerId); return { ok: true as const }; },
  }, [machine({ agents: [claudeSignedOut] })]);
  try {
    // Already set up: the reconnect on open is the Bundled Runner step, the only one that spins.
    assert.ok(check("Bundled Runner")!.classList.contains("connection-check-pending"));
    assert.equal(dialog().querySelectorAll(".connection-check .spinner").length, 1);
    await act(async () => { connects[0]!.answer.resolve(started); });
    await settle();

    const notice = dialog().querySelector(".notice.warning, .notice")!;
    assert.match(notice.textContent ?? "", /Agents Need Attention/);
    assert.match(notice.textContent ?? "", /not signed in/);
    assert.equal(buttonNamed("Reconnect This Machine"), undefined);
    const rediscover = buttonNamed("Rediscover")!;
    assert.equal(rediscover.classList.contains("primary"), false);
    assertOnePrimaryInFooter("Done");
    assert.ok(buttonNamed("Install Manually Instead"));
    await act(async () => { rediscover.click(); });
    await settle();
    assert.deepEqual(rediscovered, ["this-machine"]);
  } finally {
    await view.unmount();
  }
});

test("a runner that set up but is not running offers Reconnect This Machine, which starts it again", async () => {
  const connects = installBridge(notSetUp);
  const view = await mount(<SetUpThisMachineDialog onClose={() => {}} />);
  try {
    await act(async () => { connects[0]!.answer.resolve({ ...started, running: false }); });
    await settle();
    assert.match(dialog().querySelector(".notice")?.textContent ?? "", /This Machine Isn't Connected/);
    assertOnePrimaryInFooter("Done");
    await act(async () => { buttonNamed("Reconnect This Machine")!.click(); });
    await settle();
    assert.equal(connects.length, 2, "Reconnect starts the runner again");
    assert.ok(check("Bundled Runner")!.classList.contains("connection-check-pending"));
  } finally {
    await view.unmount();
  }
});

test("a failed setup stays Ready to Set Up with the reason, and the footer primary tries again", async () => {
  const connects = installBridge(notSetUp);
  const view = await mount(<SetUpThisMachineDialog onClose={() => {}} />);
  try {
    await act(async () => { connects[0]!.answer.reject(new Error("credential store is locked")); });
    await settle();
    const alert = dialog().querySelector('[role="alert"]')!;
    assert.match(alert.textContent ?? "", /Wollipog couldn't set up this machine\. Try again\./);
    assert.doesNotMatch(alert.textContent ?? "", /credential store is locked/, "the cause waits behind Show Details");
    assert.ok(dialog().querySelector(".set-up-machine-checklist"));
    const primary = buttonNamed("Set Up This Machine")!;
    assert.equal(primary.getAttribute("aria-busy"), null);
    assertOnePrimaryInFooter("Set Up This Machine");
    await act(async () => { primary.click(); });
    await settle();
    assert.equal(connects.length, 2);
  } finally {
    await view.unmount();
  }
});

test("without a bundled runner the dialog says so, offers Install Manually Instead, and only Cancel", async () => {
  installBridge({ available: false, enabled: false, running: false, runnerId: null });
  const view = await mount(<SetUpThisMachineDialog onClose={() => {}} />);
  try {
    assert.match(dialog().querySelector('[role="alert"]')?.textContent ?? "",
      /Wollipog couldn't reach its bundled runner\. Close this dialog and try again\./);
    assert.deepEqual([...footer().querySelectorAll("button")].map((button) => button.textContent?.trim()),
      ["Install Manually Instead", "Cancel"]);
    assertNoDomNode(dialog().querySelector(".btn.primary"), "nothing to do here but leave");
  } finally {
    await view.unmount();
  }
});

test("Install Manually Instead stacks Install Manually over this dialog on desktop, and closing it comes back", async () => {
  const connects = installBridge(notSetUp);
  const view = await mount(<SetUpThisMachineDialog onClose={() => {}} />);
  try {
    await act(async () => { connects[0]!.answer.reject(new Error("no")); });
    await settle();
    await act(async () => { buttonNamed("Install Manually Instead")!.click(); });
    await settle();
    const manual = dialogNamed("Install Manually")!;
    assert.ok(manual, "Install Manually opens");
    assert.ok(dialog(), "Set Up This Machine stays open under it");
    assert.equal(body.querySelectorAll(".modal-backdrop.stacked").length, 1, "stacked on the parent under one dim");
    assertNoDomNode(dialog().closest("[hidden]"), "the parent stays visible on desktop");
    await act(async () => { buttonNamed("Cancel", manual)!.click(); });
    await settle();
    assert.equal(dialogNamed("Install Manually"), undefined);
    assert.ok(dialog(), "back to Set Up This Machine");
  } finally {
    await view.unmount();
  }
});

test("on a phone Install Manually Instead pushes onto the sheet with Back, which returns to this dialog", async () => {
  matchingMedia = new Set([PHONE]);
  const connects = installBridge(notSetUp);
  const view = await mount(<SetUpThisMachineDialog onClose={() => {}} />);
  try {
    await act(async () => { connects[0]!.answer.reject(new Error("no")); });
    await settle();
    const tertiary = buttonNamed("Install Manually Instead")!;
    assert.ok(tertiary.closest(".modal-body"), "the tertiary is a row at the body's end on a phone");
    await act(async () => { tertiary.click(); });
    await settle();
    assert.equal(body.querySelectorAll(".modal").length, 1, "one sheet: the child pushes onto it");
    const manual = dialogNamed("Install Manually")!;
    const back = manual.querySelector<HTMLButtonElement>(".modal-back")!;
    assert.equal(back.getAttribute("aria-label"), "Back to Set Up This Machine");
    assert.ok(dialog().closest("[hidden]"), "the parent panel is covered");
    await act(async () => { back.click(); });
    await settle();
    assert.equal(dialogNamed("Install Manually"), undefined);
    assertNoDomNode(dialog().closest("[hidden]"), "Back shows this dialog again");
  } finally {
    await view.unmount();
  }
});

test("Repair Connection… on the desktop app's own runner opens Set Up This Machine", async () => {
  installBridge({ ...started, running: false });
  const offline = machine({ status: "offline" });
  const view = await mount(<RunnersView />, {}, [offline]);
  try {
    const repair = [...body.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Repair Connection…");
    assert.ok(repair, "the offline runner offers Repair Connection…");
    await act(async () => { repair.click(); });
    await settle();
    assert.ok(dialog(), "the bundled runner is repaired by Set Up This Machine");
    assert.equal(dialogNamed("Repair Connection"), undefined);
  } finally {
    await view.unmount();
  }
});

test("the phase follows the bridge and the runner, and an open's setup counts as running before it starts", () => {
  const phase = (overrides: Partial<Parameters<typeof setUpPhase>[0]>) => setUpPhase({
    infoLoaded: true, loadFailed: false, status: started, connecting: false, connectFailed: false, readiness: "ready",
    waitExpired: false, ...overrides,
  });
  assert.equal(phase({ infoLoaded: false }), "loading");
  assert.equal(phase({ infoLoaded: false, loadFailed: true }), "load-failed");
  assert.equal(phase({ status: undefined }), "loading");
  assert.equal(phase({ status: null }), "unavailable");
  assert.equal(phase({ status: notSetUp, connecting: true }), "ready-to-set-up");
  assert.equal(phase({ connecting: true }), "setting-up");
  assert.equal(phase({ connectFailed: true }), "needs-attention");
  assert.equal(phase({ readiness: "starting" }), "setting-up");
  assert.equal(phase({ readiness: "starting", status: { ...started, running: false } }), "needs-attention");
  assert.equal(phase({ readiness: "discovering" }), "setting-up");
  assert.equal(phase({ readiness: "needs-attention" }), "needs-attention");
  assert.equal(phase({}), "ready");
  // The wait is bounded (#3524): past it, a runner not online or still discovering needs attention.
  assert.equal(phase({ readiness: "starting", waitExpired: true }), "needs-attention");
  assert.equal(phase({ readiness: "discovering", waitExpired: true }), "needs-attention");
  assert.equal(phase({ waitExpired: true }), "ready", "a runner that connects after the bound is ready");
  assert.equal(phase({ connecting: true, waitExpired: true }), "setting-up", "Reconnect waits again");
});

// The bounded wait (#3524). Fake timers start once the dialog has mounted on real ones, before the
// bridge reports the start that begins the wait.
describe("a runner that started but never finishes connecting", () => {
  const flush = () => act(async () => { for (let turn = 0; turn < 10; turn += 1) await Promise.resolve(); });
  const tick = async (ms: number) => {
    await act(async () => { mock.timers.tick(ms); });
    await flush();
  };
  const notice = () => dialog().querySelector<HTMLElement>(".notice");
  const noticeTitle = () => notice()?.querySelector(".notice-title")?.textContent;
  async function startedAndWaiting(runners: RunnerView[] = []) {
    const bridge = installBridge(notSetUp);
    const view = await mount(<SetUpThisMachineDialog onClose={() => {}} />, {
      rediscover: async () => ({ ok: true as const }),
    }, runners);
    mock.timers.enable({ apis: ["setTimeout"] });
    await act(async () => { bridge[0]!.answer.resolve(started); });
    await flush();
    assert.ok(dialog().querySelector(".connection-check"), "Setting Up shows the Connection Check");
    return { bridge, view };
  }
  function assertStoppedWaiting() {
    assertNoDomNode(dialog().querySelector(".connection-check"), "the check gives way to the notice");
    assertNoDomNode(footer().querySelector(".spinner"), "the footer stops spinning");
    assert.doesNotMatch(footer().textContent ?? "", /Waiting for the runner/u);
    assertOnePrimaryInFooter("Done");
    assert.ok(buttonNamed("Install Manually Instead"), "Install Manually Instead is offered again");
  }

  test("a runner that is not online after the bound says it hasn't connected, and Reconnect starts it again", async () => {
    const { bridge, view } = await startedAndWaiting();
    try {
      await tick(RUNNER_CONNECT_WAIT_MS - 1);
      assert.ok(check("Runner Connection")!.classList.contains("connection-check-pending"), "still waiting just before the bound");
      assert.ok(footer().textContent?.includes("Waiting for the runner…"));
      assert.equal(buttonNamed("Install Manually Instead"), undefined);

      await tick(1);
      assert.equal(noticeTitle(), "This Machine Hasn't Connected");
      assert.ok(notice()!.classList.contains("t-warning"), "a warning notice");
      assert.match(notice()!.textContent ?? "", /The bundled runner started, but it hasn't connected to Wollipog\./u);
      assertStoppedWaiting();
      assert.equal(buttonNamed("Rediscover"), undefined);

      await act(async () => { buttonNamed("Reconnect This Machine")!.click(); });
      await flush();
      assert.equal(bridge.length, 2, "Reconnect restarts the bundled runner through the connect path");
      assert.ok(check("Bundled Runner")!.classList.contains("connection-check-pending"));
      await act(async () => { bridge[1]!.answer.resolve(started); });
      await flush();
      assert.ok(check("Runner Connection")!.classList.contains("connection-check-pending"), "a new wait starts");
      await tick(RUNNER_CONNECT_WAIT_MS);
      assert.equal(noticeTitle(), "This Machine Hasn't Connected", "and it is bounded too");
    } finally {
      await view.unmount();
    }
  });

  test("a runner that connects after the bound moves the dialog to Ready on its own", async () => {
    const { view } = await startedAndWaiting();
    try {
      await tick(RUNNER_CONNECT_WAIT_MS);
      assert.equal(noticeTitle(), "This Machine Hasn't Connected");
      await view.pushNow([machine()]);
      assert.equal(noticeTitle(), "This Machine Is Ready");
      assert.equal(buttonNamed("Done")!.disabled, false);
      assert.equal(buttonNamed("Install Manually Instead"), undefined);
    } finally {
      await view.unmount();
    }
  });

  test("a runner still discovering its agents after the bound offers Rediscover, and its agents arriving later settle it", async () => {
    const { view } = await startedAndWaiting();
    try {
      await view.pushNow([machine({ agentsRefreshed: false, agents: [] })]);
      assert.ok(check("Agent Readiness")!.classList.contains("connection-check-pending"));
      await tick(RUNNER_CONNECT_WAIT_MS);
      assert.equal(noticeTitle(), "This Machine Hasn't Reported Its Agents");
      assert.ok(notice()!.classList.contains("t-warning"));
      assert.match(notice()!.textContent ?? "", /The bundled runner connected, but it hasn't reported its agents yet\./u);
      assertStoppedWaiting();
      assert.ok(buttonNamed("Rediscover"));
      assert.equal(buttonNamed("Reconnect This Machine"), undefined);

      // Agents that need attention arrive later: Needs Attention for its agents, with no action.
      await view.pushNow([machine({ agents: [claudeSignedOut] })]);
      assert.equal(noticeTitle(), "Agents Need Attention");
      await view.pushNow([machine()]);
      assert.equal(noticeTitle(), "This Machine Is Ready");
    } finally {
      await view.unmount();
    }
  });

  test("while waiting it reads the bridge again, and a runner process that exits shows This Machine Isn't Connected", async () => {
    const { bridge, view } = await startedAndWaiting();
    try {
      await tick(LOCAL_RUNNER_STATUS_POLL_MS);
      assert.ok(dialog().querySelector(".connection-check"), "a running process keeps the wait");
      bridge.setStatus({ ...started, running: false });
      await tick(LOCAL_RUNNER_STATUS_POLL_MS);
      assert.equal(noticeTitle(), "This Machine Isn't Connected");
      assert.match(notice()!.textContent ?? "", /The bundled runner isn't running\./u);
      assert.ok(buttonNamed("Reconnect This Machine"));
      assertStoppedWaiting();
    } finally {
      await view.unmount();
    }
  });
});
