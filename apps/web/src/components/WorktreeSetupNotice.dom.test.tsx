import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { PROTOCOL_VERSION, type ControlPlaneToUi, type SessionCommandPermission, type SessionView } from "@wollipog/protocol";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { useWorktreeSetupSuggestion, WORKTREE_SETUP_DOCS_URL, WorktreeSetupNotice } from "./WorktreeSetupNotice.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow, document: domWindow.document, navigator: domWindow.navigator,
  localStorage: domWindow.localStorage, Element: domWindow.Element,
  HTMLElement: domWindow.HTMLElement, Node: domWindow.Node, React, IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const VIEWER = "Your Viewer role is read-only.";

function describedBy(control: Element): string[] {
  const ids = control.getAttribute("aria-describedby")?.split(/\s+/u).filter(Boolean) ?? [];
  return ids.map((id) => domWindow.document.getElementById(id)?.textContent ?? `<missing ${id}>`);
}

function buttonIn(container: Element, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")]
    .find((candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent) === label);
  assert.ok(match, `missing ${label}`);
  return match as HTMLButtonElement;
}

async function mount(element: React.ReactElement) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(element));
  return {
    container,
    render: async (next: React.ReactElement) => act(async () => root.render(next)),
    unmount: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}

test("the setup notice names its Project and offers Generate Setup File and an external Learn More", async () => {
  const view = await mount(<WorktreeSetupNotice projectName="Payments Service" onGenerate={() => {}} onDismiss={() => {}} />);
  try {
    const notice = view.container.querySelector("aside")!;
    assert.equal(notice.getAttribute("aria-label"), "Set Up Payments Service");
    assert.equal(notice.querySelector(".notice-title")?.textContent, "Set Up Payments Service");
    assert.ok(notice.querySelector(".notice-icon .lucide-wrench"), "a wrench, not the info tone icon");
    assert.deepEqual([...notice.querySelectorAll("button")].map((button) => button.getAttribute("aria-label") ?? button.textContent),
      // The dismiss button sits in the title row (§13.2), ahead of the body and its actions.
      ["Dismiss Setup Notice", "Generate Setup File"]);
    const learnMore = notice.querySelector("a")!;
    assert.equal(learnMore.textContent, "Learn More");
    assert.equal(learnMore.getAttribute("href"), WORKTREE_SETUP_DOCS_URL);
    assert.equal(learnMore.getAttribute("target"), "_blank");
    // `a.btn` has no underline (styles.css); the icon marks it as leaving Wollipog.
    assert.match(learnMore.className, /\bbtn\b/u);
    assert.ok(learnMore.querySelector("svg.lucide-external-link"));
    assertNoDomNode(view.container.querySelector("button button, button a, a button"));
    assert.equal(notice.querySelector(".notice-body p")?.textContent,
      "Add a setup file so new worktrees for this project install dependencies and run setup steps automatically.");
    assert.doesNotMatch(view.container.textContent ?? "", /repository signals|Nothing runs/u);
  } finally {
    await view.unmount();
  }
});

test("while Generate runs it keeps its label and shows a spinner, and dismissing waits for it", async () => {
  const view = await mount(<WorktreeSetupNotice projectName="Payments Service" generating onGenerate={() => {}} onDismiss={() => {}} />);
  try {
    const generate = buttonIn(view.container, "Generate Setup File");
    assert.equal(generate.getAttribute("aria-busy"), "true");
    assert.equal(generate.getAttribute("data-busy-spinner"), "prepended");
    assert.equal(generate.textContent, "Generate Setup File");
    assert.equal(buttonIn(view.container, "Dismiss Setup Notice").disabled, true);
    assert.doesNotMatch(view.container.textContent ?? "", /Generating…/u);
  } finally {
    await view.unmount();
  }
});

test("the slot's compact form carries its title as the accessible name and the slot's trailing controls", async () => {
  const view = await mount(
    <WorktreeSetupNotice projectName="Payments Service" compact trailing={<button type="button">+1 More</button>}
      onGenerate={() => {}} onDismiss={() => {}} />,
  );
  try {
    const notice = view.container.querySelector("aside")!;
    assert.match(notice.className, /\bcompact\b/u);
    assert.equal(notice.getAttribute("aria-label"), "Set Up Payments Service");
    assertNoDomNode(notice.querySelector(".notice-title"));
    assert.ok(buttonIn(notice, "+1 More"));
    assert.ok(buttonIn(notice, "Dismiss Setup Notice"));
  } finally {
    await view.unmount();
  }
});

test("a refused Generate is disabled, states the reason, and sends nothing, while Dismiss still works (#1864)", async () => {
  const calls: string[] = [];
  const view = await mount(
    <WorktreeSetupNotice projectName="Payments Service" generateRefusal={VIEWER}
      onGenerate={() => calls.push("generate")} onDismiss={() => calls.push("dismiss")} />,
  );
  try {
    const generate = buttonIn(view.container, "Generate Setup File");
    assert.equal(generate.disabled, true);
    assert.equal(generate.getAttribute("title"), VIEWER);
    assert.deepEqual(describedBy(generate), [VIEWER]);
    const reason = domWindow.document.getElementById(generate.getAttribute("aria-describedby")!);
    assert.ok(reason && view.container.contains(reason as never), "the reason is rendered inside the notice");
    await act(async () => generate.click());
    assert.deepEqual(calls, []);

    const dismiss = buttonIn(view.container, "Dismiss Setup Notice");
    assert.equal(dismiss.disabled, false, "dismissing hides the notice for this person only, so it stays available");
    await act(async () => dismiss.click());
    assert.deepEqual(calls, ["dismiss"]);
  } finally {
    await view.unmount();
  }
});

class FakeSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
  push(message: ControlPlaneToUi) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

const navigation: ViewNavigation = { current: () => ({ name: "inbox" }), push() {}, listen: () => () => {} };

/** The Sessions list's setup suggestion, as `SessionsListNotices` composes it (#2221). */
function ProjectSetupSuggestion({ session, projectName, onGenerated }: {
  session: SessionView & { projectId: string };
  projectName: string;
  onGenerated: (sessionId: string) => void;
}) {
  const setup = useWorktreeSetupSuggestion(session, onGenerated);
  return (
    <WorktreeSetupNotice projectName={projectName} generating={setup.generating} dismissing={setup.dismissing}
      error={setup.error} generateRefusal={setup.generateRefusal} onGenerate={setup.generate} onDismiss={setup.dismiss} />
  );
}

/** A connected suggestion on a store that knows the session's Machine as "Build Box". */
async function withSuggestion(
  options: { worktreeSetup?: SessionCommandPermission; generate?: () => Promise<unknown> },
  run: (view: { container: HTMLDivElement; calls: string[] }) => Promise<void>,
) {
  const session = {
    id: "session-setup", runnerId: "runner-1", title: "Setup Session", status: "idle",
    driver: "codex-app-server", pendingApproval: null, projectId: "payments",
    ...(options.worktreeSetup ? {
      commandPermissions: {
        stop: { allowed: true }, restart: { allowed: true }, stopBackgroundJob: { allowed: true },
        worktreeSetup: options.worktreeSetup,
      },
    } : {}),
  } as unknown as SessionView & { projectId: string };
  const calls: string[] = [];
  const client = {
    generateWorktreeSetup: async (id: string) => {
      calls.push(`generate:${id}`);
      await options.generate?.();
    },
    dismissWorktreeSetupNotice: async (projectId: string) => { calls.push(`dismiss:${projectId}`); },
  };
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "setup-suggestion", runtimeKey: "setup-suggestion:1", createSocket: () => socket, close() {},
  };
  const view = await mount(
    <ApiProvider client={client as never}>
      <StoreProvider connection={connection} navigation={navigation}>
        <ProjectSetupSuggestion session={session} projectName="Payments Service"
          onGenerated={(id) => { calls.push(`generated:${id}`); }} />
      </StoreProvider>
    </ApiProvider>,
  );
  await act(async () => socket.push({
    type: "snapshot",
    capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false },
    runners: [{
      runnerId: "runner-1", hostname: "build-box", displayName: "Build Box", os: "linux", version: "1",
      status: "online", agents: [], workspaces: [], connectedAt: 1, lastSeen: 1, protocolVersion: PROTOCOL_VERSION,
    }],
    boxes: [], sessions: [], runs: [], pods: [],
  }));
  try {
    await run({ container: view.container, calls });
  } finally {
    await view.unmount();
  }
}

const settle = () => act(async () => { await new Promise((resolve) => domWindow.setTimeout(resolve, 0)); });

test("Generate writes the file, dismisses the suggestion for the Project, and opens the file", async () => {
  for (const worktreeSetup of [{ allowed: true } as const, undefined]) {
    await withSuggestion({ worktreeSetup }, async ({ container, calls }) => {
      const generate = buttonIn(container, "Generate Setup File");
      assert.equal(generate.disabled, false);
      assert.equal(generate.getAttribute("aria-describedby"), null);
      await act(async () => generate.click());
      await settle();
      assert.deepEqual(calls, ["generate:session-setup", "dismiss:payments", "generated:session-setup"]);
    });
  }
});

test("a failed Generate reads as one sentence naming the machine, and the raw error goes to the console", async () => {
  const warned: unknown[][] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warned.push(args); };
  try {
    await withSuggestion({ generate: async () => { throw new Error("runner rpc timeout: git ls-files exited 128"); } },
      async ({ container, calls }) => {
        await act(async () => buttonIn(container, "Generate Setup File").click());
        await settle();
        assert.deepEqual(calls, ["generate:session-setup"], "nothing is dismissed or opened");
        assert.equal(container.querySelector('[role="alert"]')?.textContent,
          "Couldn’t read the repository on Build Box. Check that it’s online, then try again.");
        assert.doesNotMatch(container.textContent ?? "", /rpc|ls-files|128/u);
        assert.equal(buttonIn(container, "Generate Setup File").getAttribute("aria-busy"), null, "Generate is available again");
      });
  } finally {
    console.warn = warn;
  }
  assert.equal(warned.length, 1);
  assert.match(String((warned[0]![1] as Error).message), /git ls-files exited 128/u);
});

test("a Viewer sees the refusal and cannot generate, but can dismiss the suggestion for themself (#1864)", async () => {
  await withSuggestion({ worktreeSetup: { allowed: false, reason: VIEWER } }, async ({ container, calls }) => {
    const generate = buttonIn(container, "Generate Setup File");
    assert.equal(generate.disabled, true);
    assert.deepEqual(describedBy(generate), [VIEWER]);
    await act(async () => generate.click());
    await settle();
    assert.deepEqual(calls, [], "neither generate nor its follow-up dismiss is sent");

    await act(async () => buttonIn(container, "Dismiss Setup Notice").click());
    await settle();
    assert.deepEqual(calls, ["dismiss:payments"]);
  });
});
