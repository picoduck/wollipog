import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { PROTOCOL_VERSION, type ExternalSessionDescriptor, type RunnerView } from "@wollipog/protocol";
import { api } from "../api.js";
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
    {
      id: "conductor",
      name: "Conductor",
      command: "internal",
      args: [],
      env: {},
      driver: "acp",
      available: true,
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

test("session discovery excludes exact Conductor identities without matching arbitrary names", () => {
  const appServer = runner.agents.find((agent) => agent.id === "codex-app")!;
  assert.equal(agentSupportsSessionDiscovery({ ...appServer, id: "legacy", name: "Conductor (Agent Manager)" }), false);
  assert.equal(agentSupportsSessionDiscovery({ ...appServer, id: "current", name: "Conductor (Wollipog)" }), false);
  assert.equal(agentSupportsSessionDiscovery({ ...appServer, id: "custom", name: "My Conductor" }), true);
});

test("an old runner explains why Codex App Server discovery requires an update", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<AgentSessionDiscoveryDialog runner={{ ...runner, protocolVersion: 62 }} onClose={() => {}} />);
    });

    const appServerRadio = container.querySelector('input[value="codex-app"]') as HTMLInputElement;
    assert.equal(appServerRadio.disabled, true);
    const copy = container.textContent ?? "";
    assert.match(copy, /Runner Update Required/);
    assert.match(copy, /Codex App Server session discovery/);
    assert.doesNotMatch(copy, /Codex(?: —)? Interactive session discovery/);
    assert.match(copy, /Runner protocol is v62.*requires protocol v63.*Update and restart the runner/);
    assert.equal((container.querySelector('input[value="codex-exec"]') as HTMLInputElement).disabled, false);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("agent selection keeps ACP session sources when the same provider has a native driver", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
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

    assert.ok(container.querySelector('input[value="claude"]'), "native Claude discovery remains available");
    assert.ok(container.querySelector('input[value="claude-acp"]'), "ACP Claude sessions remain discoverable");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
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
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<AgentSessionDiscoveryDialog runner={runner} onClose={() => {}} />);
    });

    assert.equal(calls.length, 0, "opening the dialog must not scan before the user selects an agent");
    assert.match(container.textContent ?? "", /Select an Agent/);
    assert.doesNotMatch(container.textContent ?? "", /Conductor/);
    assert.match(container.textContent ?? "", /Codex App Server/);
    assert.match(container.textContent ?? "", /Codex — Non-Interactive \(codex exec\)/);
    assert.match(container.textContent ?? "", /Uses codex exec to run each turn non-interactively/);

    const findButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Find Sessions")) as HTMLButtonElement;
    assert.equal(findButton.disabled, true);

    const claudeRadio = container.querySelector('input[value="claude"]') as HTMLInputElement;
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
    assert.match(container.textContent ?? "", /Choose Another Agent/);

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
      .find((button) => button.textContent?.includes("Choose Another Agent")) as HTMLButtonElement;
    await act(async () => { chooseAnother.click(); });
    assert.equal(
      (domWindow.document.activeElement as unknown as HTMLElement).getAttribute("aria-label"),
      "Agent Selection",
      "returning to agent selection must retain keyboard focus inside the dialog",
    );
  } finally {
    await act(async () => { root.unmount(); });
    api.listExternalSessions = priorList;
    container.remove();
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
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<AgentSessionDiscoveryDialog runner={runner} onClose={() => {}} />);
    });

    const findButton = () => Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Find Sessions")) as HTMLButtonElement;

    await act(async () => {
      (container.querySelector('input[value="claude"]') as HTMLInputElement).click();
    });
    await act(async () => { findButton().click(); });

    const chooseAnother = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Choose Another Agent")) as HTMLButtonElement;
    await act(async () => { chooseAnother.click(); });
    await act(async () => {
      (container.querySelector('input[value="gemini"]') as HTMLInputElement).click();
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
    assert.match(container.textContent ?? "", /Selected AgentGemini/);
  } finally {
    await act(async () => { root.unmount(); });
    api.listExternalSessions = priorList;
    container.remove();
  }
});
