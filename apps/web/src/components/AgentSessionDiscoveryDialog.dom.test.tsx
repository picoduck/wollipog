import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { PROTOCOL_VERSION, type ExternalSessionDescriptor, type RunnerView } from "@wollipog/protocol";
import { api } from "../api.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import {
  AgentSessionDiscoveryDialog,
  agentSupportsSessionDiscovery,
  sessionMatchesAgent,
} from "./AgentSessionDiscoveryDialog.js";

const domWindow = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  KeyboardEvent: domWindow.KeyboardEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const runner: RunnerView = {
  runnerId: "runner-1",
  hostname: "workstation",
  os: "linux",
  version: "1.0.0",
  status: "online",
  protocolVersion: PROTOCOL_VERSION,
  connectedAt: 1,
  lastSeen: 1,
  workspaces: [],
  agents: [
    {
      id: "codex-app",
      name: "Codex",
      command: "codex",
      args: ["app-server"],
      env: {},
      driver: "codex-app-server",
      context: { kind: "native" },
      available: true,
      source: "discovered",
    },
    {
      id: "codex-exec",
      name: "Codex (exec compatibility)",
      command: "codex",
      args: [],
      env: {},
      driver: "codex",
      context: { kind: "native" },
      available: true,
      source: "discovered",
    },
    {
      id: "claude",
      name: "Claude Code",
      command: "claude",
      args: [],
      env: {},
      driver: "claude-code",
      context: { kind: "native" },
      available: true,
    },
    {
      id: "pi",
      name: "Pi",
      command: "pi",
      args: [],
      env: {},
      driver: "pi",
      context: { kind: "native" },
      available: true,
    },
    {
      id: "gemini",
      name: "Gemini",
      command: "gemini",
      args: [],
      env: {},
      driver: "acp",
      context: { kind: "native" },
      available: true,
      acp: {
        logout: false,
        loadSession: true,
        sessionList: true,
        sessionDelete: false,
        sessionResume: true,
        sessionClose: false,
      },
    },
  ],
};

test("App Server is selectable and its remapped Codex sessions stay scoped to it", () => {
  const appServer = runner.agents.find((agent) => agent.id === "codex-app")!;
  const session: ExternalSessionDescriptor = {
    agentSessionId: "codex-thread",
    driver: "codex-app-server",
    cwd: "/repos/project",
    context: { kind: "native" },
    title: "Codex Thread",
    createdAt: 1,
    updatedAt: 2,
    messageCount: 3,
  };
  assert.equal(agentSupportsSessionDiscovery(appServer), true);
  assert.equal(sessionMatchesAgent(session, appServer), true);
  assert.equal(sessionMatchesAgent({ ...session, driver: "codex" }, appServer), false);
});

test("Pi is selectable only when the runner proves source-preserving session adoption", async () => {
  const pi = runner.agents.find((agent) => agent.id === "pi")!;
  assert.equal(agentSupportsSessionDiscovery(pi), true);
  assert.equal(sessionMatchesAgent({
    agentSessionId: "pi-session",
    driver: "pi",
    cwd: "/repos/project",
    context: { kind: "native" },
    title: "Pi Session",
    createdAt: 1,
    updatedAt: 2,
    messageCount: 2,
  }, pi), true);

  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const mountPoint = happyContainer as unknown as HTMLDivElement;
  // Dialogs are portalled to <body>, so the test queries the body.
  const container = domWindow.document.body as unknown as HTMLDivElement;
  const root = createRoot(mountPoint);
  try {
    await act(async () => {
      root.render(<AgentSessionDiscoveryDialog runner={{ ...runner, protocolVersion: 155 }} onClose={() => {}} />);
    });
    const radio = container.querySelector('input[data-agent-id="pi"]') as HTMLInputElement;
    assert.equal(radio.getAttribute("aria-disabled"), "true");
    assert.match(container.textContent ?? "", /Update this machine's runner to find this agent's sessions\./);
  } finally {
    await act(async () => { root.unmount(); });
    mountPoint.remove();
  }
});

test("an old runner explains why Codex App Server discovery requires an update", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const mountPoint = happyContainer as unknown as HTMLDivElement;
  // Dialogs are portalled to <body>, so the test queries the body.
  const container = domWindow.document.body as unknown as HTMLDivElement;
  const root = createRoot(mountPoint);
  try {
    await act(async () => {
      root.render(<AgentSessionDiscoveryDialog runner={{ ...runner, protocolVersion: 62 }} onClose={() => {}} />);
    });

    const appServerRadio = container.querySelector('input[data-agent-id="codex-app"]') as HTMLInputElement;
    assert.equal(appServerRadio.getAttribute("aria-disabled"), "true");
    assert.equal(appServerRadio.checked, false, "an agent that cannot be scanned is never preselected");
    const copy = container.textContent ?? "";
    // The reason is the row's visible second line, not a badge or a tooltip (#2994).
    const reason = Array.from(container.querySelectorAll(".choice-row-reason"))
      .find((element) => element.textContent === "Update this machine's runner to find this agent's sessions.");
    assert.ok(reason, "the disabled agent shows its reason as visible text");
    assert.doesNotMatch(copy, /Runner Update Required/);
    assert.doesNotMatch(copy, /Codex(?: —)? Interactive session discovery/);
    assert.doesNotMatch(copy, /protocol|v6[23]/);
    // Discovery's exec row restarts existing sessions only; it is not an adoption fallback.
    assertNoDomNode(container.querySelector('input[data-agent-id="codex-exec"]'));
  } finally {
    await act(async () => { root.unmount(); });
    mountPoint.remove();
  }
});

test("agent selection keeps ACP session sources when the same provider has a native driver", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const mountPoint = happyContainer as unknown as HTMLDivElement;
  // Dialogs are portalled to <body>, so the test queries the body.
  const container = domWindow.document.body as unknown as HTMLDivElement;
  const root = createRoot(mountPoint);
  const claudeAcp = {
    id: "claude-acp",
    name: "Claude Code (ACP)",
    command: "claude-acp",
    args: [],
    env: {},
    driver: "acp" as const,
    context: { kind: "native" as const },
    available: true,
    acp: {
      logout: false,
      loadSession: true,
      sessionList: true,
      sessionDelete: false,
      sessionResume: true,
      sessionClose: false,
    },
  };
  try {
    await act(async () => {
      root.render(
        <AgentSessionDiscoveryDialog
          runner={{ ...runner, agents: [...runner.agents, claudeAcp] }}
          onClose={() => {}}
        />,
      );
    });

    assert.ok(container.querySelector('input[data-agent-id="claude"]'), "native Claude discovery remains available");
    assert.ok(container.querySelector('input[data-agent-id="claude-acp"]'), "ACP Claude sessions remain discoverable");
  } finally {
    await act(async () => { root.unmount(); });
    mountPoint.remove();
  }
});

const matchingSession: ExternalSessionDescriptor = {
  agentSessionId: "claude-session",
  driver: "claude-code",
  cwd: "/repos/project",
  context: { kind: "native" },
  title: "Matching Claude Session",
  createdAt: 1,
  updatedAt: 2,
  messageCount: 4,
};

const unrelatedSession: ExternalSessionDescriptor = {
  agentSessionId: "gemini-session",
  agentId: "gemini",
  driver: "acp",
  cwd: "/repos/other",
  context: { kind: "native" },
  title: "Unrelated Gemini Session",
  createdAt: 1,
  updatedAt: 3,
  messageCount: 2,
};

test("agent session discovery waits for a selection and scopes the result list", async () => {
  const priorList = api.listExternalSessions;
  const calls: Array<[string, string | undefined]> = [];
  api.listExternalSessions = async (runnerId, agentId) => {
    calls.push([runnerId, agentId]);
    return { sessions: [matchingSession, unrelatedSession] };
  };

  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const mountPoint = happyContainer as unknown as HTMLDivElement;
  // Dialogs are portalled to <body>, so the test queries the body.
  const container = domWindow.document.body as unknown as HTMLDivElement;
  const root = createRoot(mountPoint);
  try {
    await act(async () => {
      root.render(<AgentSessionDiscoveryDialog runner={runner} onClose={() => {}} />);
    });

    assert.equal(calls.length, 0, "opening the dialog must not scan before the user selects an agent");
    assert.ok(container.querySelector('[role="radiogroup"][aria-label="Agent"]'));
    assert.match(container.textContent ?? "", /Codex App Server/);
    assert.doesNotMatch(container.textContent ?? "", /Non-Interactive|codex exec/);

    const findButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Find Sessions")) as HTMLButtonElement;
    assert.equal(findButton.disabled, true);
    assert.equal(container.querySelector(".modal-foot .agent-session-find-reason")?.textContent, "Choose an agent to scan.");

    const claudeRadio = container.querySelector('input[data-agent-id="claude"]') as HTMLInputElement;
    await act(async () => { claudeRadio.click(); });
    assert.equal(findButton.disabled, false);

    await act(async () => {
      findButton.focus();
      findButton.click();
      await new Promise((resolve) => domWindow.setTimeout(resolve, 0));
    });

    assert.equal(
      (domWindow.document.activeElement as unknown as HTMLElement).getAttribute("aria-label"),
      "Agent Session Discovery Results",
      "the step transition must retain keyboard focus inside the dialog",
    );
    assert.deepEqual(calls, [["runner-1", "claude"]]);
    assert.match(container.textContent ?? "", /Matching Claude Session/);
    assert.doesNotMatch(container.textContent ?? "", /Unrelated Gemini Session/);
    assert.match(container.textContent ?? "", /Change Agent/);
    assert.doesNotMatch(container.textContent ?? "", /Selected Agent/);

    const rescanButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Rescan")) as HTMLButtonElement;
    rescanButton.focus();
    assert.equal(domWindow.document.activeElement, rescanButton);
    await act(async () => {
      rescanButton.click();
      await new Promise((resolve) => domWindow.setTimeout(resolve, 0));
    });
    assert.equal(
      domWindow.document.activeElement,
      rescanButton,
      "rescanning must not move focus away from the persistent control",
    );

    const chooseAnother = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Change Agent")) as HTMLButtonElement;
    await act(async () => { chooseAnother.click(); });
    assert.equal(
      (domWindow.document.activeElement as unknown as HTMLElement).getAttribute("aria-label"),
      "Agent Selection",
      "returning to agent selection must retain keyboard focus inside the dialog",
    );
  } finally {
    await act(async () => { root.unmount(); });
    api.listExternalSessions = priorList;
    mountPoint.remove();
  }
});

test("a stale scan cannot overwrite the most recently selected agent", async () => {
  const priorList = api.listExternalSessions;
  let resolveClaude!: (value: { sessions: ExternalSessionDescriptor[] }) => void;
  let resolveGemini!: (value: { sessions: ExternalSessionDescriptor[] }) => void;
  const claudeResponse = new Promise<{ sessions: ExternalSessionDescriptor[] }>((resolve) => {
    resolveClaude = resolve;
  });
  const geminiResponse = new Promise<{ sessions: ExternalSessionDescriptor[] }>((resolve) => {
    resolveGemini = resolve;
  });
  api.listExternalSessions = async (_runnerId, agentId) => {
    if (agentId === "claude") return claudeResponse;
    if (agentId === "gemini") return geminiResponse;
    throw new Error(`unexpected agent ${agentId}`);
  };

  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const mountPoint = happyContainer as unknown as HTMLDivElement;
  // Dialogs are portalled to <body>, so the test queries the body.
  const container = domWindow.document.body as unknown as HTMLDivElement;
  const root = createRoot(mountPoint);
  try {
    await act(async () => {
      root.render(<AgentSessionDiscoveryDialog runner={runner} onClose={() => {}} />);
    });

    const findButton = () => Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Find Sessions")) as HTMLButtonElement;

    await act(async () => {
      (container.querySelector('input[data-agent-id="claude"]') as HTMLInputElement).click();
    });
    await act(async () => { findButton().click(); });

    const chooseAnother = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Change Agent")) as HTMLButtonElement;
    await act(async () => { chooseAnother.click(); });
    await act(async () => {
      (container.querySelector('input[data-agent-id="gemini"]') as HTMLInputElement).click();
    });
    await act(async () => { findButton().click(); });

    await act(async () => {
      resolveGemini({ sessions: [unrelatedSession] });
      await geminiResponse;
    });
    assert.match(container.textContent ?? "", /Unrelated Gemini Session/);

    await act(async () => {
      resolveClaude({ sessions: [matchingSession] });
      await claudeResponse;
    });
    assert.match(container.textContent ?? "", /Unrelated Gemini Session/);
    assert.doesNotMatch(container.textContent ?? "", /Matching Claude Session/);
    assert.equal(container.querySelector(".agent-session-results-agent")?.textContent, "Gemini");
  } finally {
    await act(async () => { root.unmount(); });
    api.listExternalSessions = priorList;
    mountPoint.remove();
  }
});

async function renderDialog(element: React.ReactElement) {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const mountPoint = happyContainer as unknown as HTMLDivElement;
  // Dialogs are portalled to <body>, so the test queries the body.
  const container = domWindow.document.body as unknown as HTMLDivElement;
  const root = createRoot(mountPoint);
  await act(async () => { root.render(element); });
  return {
    container,
    button: (name: string) => Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === name) as HTMLButtonElement | undefined,
    async unmount() {
      await act(async () => { root.unmount(); });
      mountPoint.remove();
    },
  };
}

const claudeOnly: RunnerView = { ...runner, agents: runner.agents.filter((agent) => agent.id === "claude") };

test("the only agent that can be scanned is selected on open, so Find Sessions is ready (#2994)", async () => {
  // App Server cannot be scanned by a v62 runner, so Claude Code is the only one that can.
  const view = await renderDialog(
    <AgentSessionDiscoveryDialog
      runner={{ ...runner, protocolVersion: 62, agents: runner.agents.filter((agent) => ["claude", "codex-app"].includes(agent.id)) }}
      onClose={() => {}}
    />,
  );
  try {
    assert.equal((view.container.querySelector('input[data-agent-id="claude"]') as HTMLInputElement).checked, true);
    assert.equal((view.container.querySelector('input[data-agent-id="codex-app"]') as HTMLInputElement).checked, false);
    assert.equal(view.button("Find Sessions")?.disabled, false);
  } finally {
    await view.unmount();
  }
});

test("each agent's meta line names its integration only when its name does not (#2994)", async () => {
  const view = await renderDialog(<AgentSessionDiscoveryDialog runner={runner} onClose={() => {}} />);
  try {
    const meta = (id: string) => {
      const row = view.container.querySelector(`input[data-agent-id="${id}"]`)!.closest(".choice-row")!;
      return row.querySelector(".choice-row-desc")?.textContent;
    };
    assert.equal(meta("claude"), "Native");
    assert.equal(meta("codex-app"), "Native");
    assert.equal(meta("pi"), "Native");
    assert.equal(meta("gemini"), "ACP · Native");
  } finally {
    await view.unmount();
  }
});

test("initialAgentId selects that agent among several (#2994)", async () => {
  const view = await renderDialog(<AgentSessionDiscoveryDialog runner={runner} initialAgentId="gemini" onClose={() => {}} />);
  try {
    assert.equal((view.container.querySelector('input[data-agent-id="gemini"]') as HTMLInputElement).checked, true);
    assert.equal(view.button("Find Sessions")?.disabled, false);
  } finally {
    await view.unmount();
  }
});

test("scanning shows skeleton rows, then each result has one action that says what it does (#2994)", async () => {
  const priorList = api.listExternalSessions;
  let resolve!: (value: { sessions: ExternalSessionDescriptor[] }) => void;
  api.listExternalSessions = () => new Promise((done) => { resolve = done; });
  const view = await renderDialog(
    <AgentSessionDiscoveryDialog runner={{ ...claudeOnly, displayName: "Studio Mac" }} onClose={() => {}} />,
  );
  try {
    await act(async () => { view.button("Find Sessions")!.click(); });
    assert.equal(view.container.querySelectorAll(".agent-session-result-skeleton").length, 3);
    assert.match(view.container.textContent ?? "", /Scanning Claude Code sessions on Studio Mac…/);

    await act(async () => {
      resolve({
        sessions: [
          matchingSession,
          { ...matchingSession, agentSessionId: "untitled", title: "", resumable: true },
          { ...matchingSession, agentSessionId: "read-only", title: "History Only", resumable: false },
        ],
      });
    });
    const rows = Array.from(view.container.querySelectorAll(".agent-session-results > li"));
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((row) => row.querySelector("button")?.textContent?.trim()), [
      "Continue Here",
      "Continue Here",
      "Import as Read-Only",
    ]);
    assert.equal(rows[1]!.querySelector(".row-title")?.textContent, "Untitled Session");
    assert.match(rows[2]!.textContent ?? "", /No Claude Code agent on this machine can continue it, so it opens as read-only history\./);
    assert.match(rows[0]!.textContent ?? "", /4 Messages/);
    assert.equal(rows[0]!.querySelector(".agent-session-path")?.getAttribute("title"), "/repos/project");
    assert.ok(view.button("Done"), "the results step closes with Done");
  } finally {
    await view.unmount();
    api.listExternalSessions = priorList;
  }
});

test("no sessions offers Rescan, which scans again (#2994)", async () => {
  const priorList = api.listExternalSessions;
  let calls = 0;
  api.listExternalSessions = async () => {
    calls += 1;
    return { sessions: [] };
  };
  const view = await renderDialog(<AgentSessionDiscoveryDialog runner={claudeOnly} onClose={() => {}} />);
  try {
    await act(async () => { view.button("Find Sessions")!.click(); });
    assert.match(view.container.textContent ?? "", /No Sessions Found/);
    assert.match(view.container.textContent ?? "", /Claude Code has no sessions on this machine that Wollipog isn't already showing\./);
    const rescans = Array.from(view.container.querySelectorAll("button")).filter((button) => button.textContent?.trim() === "Rescan");
    assert.equal(rescans.length, 1, "one Rescan, in the state");
    await act(async () => { rescans[0]!.click(); });
    assert.equal(calls, 2);
  } finally {
    await view.unmount();
    api.listExternalSessions = priorList;
  }
});

test("a failed scan is a danger notice with Try Again and the raw error behind Show Details (#2994)", async () => {
  const priorList = api.listExternalSessions;
  let calls = 0;
  api.listExternalSessions = async () => {
    calls += 1;
    throw new Error("ENOENT: sessions index");
  };
  const view = await renderDialog(<AgentSessionDiscoveryDialog runner={claudeOnly} onClose={() => {}} />);
  try {
    await act(async () => { view.button("Find Sessions")!.click(); });
    const notice = view.container.querySelector(".notice.t-danger");
    assert.ok(notice);
    assert.match(notice!.textContent ?? "", /Couldn't Load Sessions/);
    assert.doesNotMatch(notice!.textContent ?? "", /ENOENT/, "the raw error stays behind Show Details");
    await act(async () => { view.button("Show Details")!.click(); });
    assert.match(notice!.textContent ?? "", /ENOENT: sessions index/);
    await act(async () => { view.button("Try Again")!.click(); });
    assert.equal(calls, 2);
  } finally {
    await view.unmount();
    api.listExternalSessions = priorList;
  }
});

const RESULTS_STEP = "Agent Session Discovery Results";
const focusedLabel = () => (domWindow.document.activeElement as unknown as HTMLElement).getAttribute("aria-label");

for (const outcome of ["empty", "error"] as const) {
  test(`a header Rescan that ends ${outcome === "empty" ? "with no sessions" : "in an error"} keeps focus in the dialog (CR-1.1)`, async () => {
    const priorList = api.listExternalSessions;
    let calls = 0;
    api.listExternalSessions = async () => {
      calls += 1;
      if (calls === 1) return { sessions: [matchingSession] };
      if (outcome === "error") throw new Error("scan failed");
      return { sessions: [] };
    };
    const view = await renderDialog(<AgentSessionDiscoveryDialog runner={claudeOnly} onClose={() => {}} />);
    try {
      await act(async () => { view.button("Find Sessions")!.click(); });
      const rescan = view.button("Rescan")!;
      rescan.focus();
      await act(async () => {
        rescan.click();
        await new Promise((resolve) => domWindow.setTimeout(resolve, 0));
      });
      assert.equal(calls, 2);
      assert.equal(rescan.isConnected, false, "the header Rescan is gone once nothing is listed");
      assert.equal(focusedLabel(), RESULTS_STEP);
    } finally {
      await view.unmount();
      api.listExternalSessions = priorList;
    }
  });
}

for (const outcome of ["empty", "error", "adopt"] as const) {
  test(`focus the user moved while ${outcome === "adopt" ? "an import" : "a rescan"} ran stays where they put it (CR-2.1, ${outcome})`, async () => {
    const priorList = api.listExternalSessions;
    const priorAdopt = api.adoptSession;
    let calls = 0;
    let settle!: () => void;
    const pending = new Promise<void>((resolve) => { settle = resolve; });
    api.listExternalSessions = async () => {
      calls += 1;
      if (calls === 1) return { sessions: [matchingSession] };
      await pending;
      if (outcome === "error") throw new Error("scan failed");
      return { sessions: [] };
    };
    api.adoptSession = (async () => { await pending; return {}; }) as unknown as typeof api.adoptSession;
    const view = await renderDialog(<AgentSessionDiscoveryDialog runner={claudeOnly} onClose={() => {}} />);
    try {
      await act(async () => { view.button("Find Sessions")!.click(); });
      const origin = view.button(outcome === "adopt" ? "Continue Here" : "Rescan")!;
      origin.focus();
      await act(async () => { origin.click(); });
      const done = view.button("Done")!;
      done.focus();
      await act(async () => {
        settle();
        await new Promise((resolve) => domWindow.setTimeout(resolve, 0));
      });
      assert.equal(origin.isConnected, false);
      // assert.ok, not assert.equal: a failing equal on two happy-dom nodes exhausts memory diffing them.
      assert.ok((domWindow.document.activeElement as unknown) === done, `the control the user moved to keeps focus (now ${focusedLabel() ?? (domWindow.document.activeElement as unknown as HTMLElement)?.tagName})`);
    } finally {
      await view.unmount();
      api.listExternalSessions = priorList;
      api.adoptSession = priorAdopt;
    }
  });
}

test("continuing the last listed session keeps focus in the dialog (CR-1.1)", async () => {
  const priorList = api.listExternalSessions;
  const priorAdopt = api.adoptSession;
  api.listExternalSessions = async () => ({ sessions: [matchingSession] });
  api.adoptSession = (async () => ({})) as unknown as typeof api.adoptSession;
  const view = await renderDialog(<AgentSessionDiscoveryDialog runner={claudeOnly} onClose={() => {}} />);
  try {
    await act(async () => { view.button("Find Sessions")!.click(); });
    const continueHere = view.button("Continue Here")!;
    continueHere.focus();
    await act(async () => {
      continueHere.click();
      await new Promise((resolve) => domWindow.setTimeout(resolve, 0));
    });
    assert.match(view.container.textContent ?? "", /No Sessions Found/);
    assert.equal(focusedLabel(), RESULTS_STEP);
  } finally {
    await view.unmount();
    api.listExternalSessions = priorList;
    api.adoptSession = priorAdopt;
  }
});
