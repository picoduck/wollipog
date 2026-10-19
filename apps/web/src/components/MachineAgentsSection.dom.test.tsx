import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { PROTOCOL_VERSION, type AgentDefinition, type RunnerView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { MachineAgentsSection } from "./MachineAgentsSection.js";

/**
 * The machine's Agents section (#2990): one row and one badge per agent that opens Agent Details,
 * the agents not installed folded away, and Agent Details leading with what is wrong.
 */

const domWindow = new Window({ url: "http://localhost/", width: 1440, height: 900 });
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

const claudeCode = (status: NonNullable<AgentDefinition["claudeCode"]>["status"]): AgentDefinition["claudeCode"] => ({
  status, effortLevels: [], permissionModes: [], streamJsonInput: true, streamJsonImages: true, controlProtocol: true,
  forkSession: true, replayUserMessages: true,
  auth: status === "ready" ? { status: "authenticated", billingSource: "subscription" } : { status: "unknown", billingSource: "unknown" },
  ...(status === "unavailable" ? { failure: { code: "claude_unavailable" as const, message: "Claude Code was not found in this runner context." } } : {}),
});
const base = { args: [] as string[], env: {}, source: "discovered" as const };

const readyClaude: AgentDefinition = {
  ...base, id: "claude", name: "Claude Code", command: "/usr/local/bin/claude", driver: "claude-code", version: "2.1.4",
  available: true, authStatus: "authenticated", claudeCode: claudeCode("ready"),
  installation: { id: "claude-path", path: "/usr/local/bin/claude", via: "path" },
};
const appServer = (id: string, version: string, overrides: Partial<AgentDefinition> = {}): AgentDefinition => ({
  ...base, id, name: "Codex Interactive", command: "codex", driver: "codex-app-server", version, available: true,
  authStatus: "authenticated", codexAppServer: { status: "supported", appServerAvailable: true }, ...overrides,
});
const missing = (id: string, name: string, context?: AgentDefinition["context"]): AgentDefinition => ({
  ...base, id, name, command: "claude", driver: "claude-code", available: false, claudeCode: claudeCode("unavailable"),
  ...(context ? { context } : {}),
});
const gemini = (installStatus: "approval-required" | "approved"): AgentDefinition => ({
  ...base, id: "gemini", name: "Gemini CLI", command: "npx", source: "registry", driver: "acp", available: installStatus === "approved",
  registry: {
    id: "gemini", schemaVersion: "1", adapterVersion: "1.2.0", description: "Google's coding agent", transport: "stdio",
    distribution: "npx", installPreview: "npx @google/gemini-cli@1.2.0 --experimental-acp", installStatus,
    authentication: "required-live-verification",
  } as NonNullable<AgentDefinition["registry"]>,
});

function runner(agents: AgentDefinition[], overrides: Partial<RunnerView> = {}): RunnerView {
  return {
    runnerId: "studio", displayName: "Studio Mac", hostname: "studio.local", os: "macos", version: "1", status: "online",
    agents, workspaces: [], connectedAt: 1, lastSeen: 1, protocolVersion: PROTOCOL_VERSION, agentsRefreshed: true, ...overrides,
  };
}

async function mount(view: RunnerView, client: Partial<ApiClient> = {}, onChooseInstallation?: () => void) {
  const mountPoint = domWindow.document.createElement("div");
  domWindow.document.body.appendChild(mountPoint);
  const root = createRoot(mountPoint as unknown as HTMLElement);
  await act(async () => {
    root.render(
      <ApiProvider client={{ ...api, ...client } as ApiClient}>
        <FeedbackProvider>
          <MachineAgentsSection runner={view} online={view.status === "online"} machineName="Studio Mac" canFindSessions
            {...(onChooseInstallation ? { onChooseInstallation } : {})} />
        </FeedbackProvider>
      </ApiProvider>,
    );
  });
  const body = domWindow.document.body as unknown as HTMLElement;
  return { body, unmount: async () => { await act(async () => root.unmount()); mountPoint.remove(); } };
}

const rowNamed = (scope: Element, name: string) => [...scope.querySelectorAll<HTMLButtonElement>("button.row")]
  .find((row) => row.querySelector(".row-title")?.textContent === name) ?? null;
const dialog = (body: HTMLElement) => body.querySelector<HTMLElement>('[role="dialog"]');
const buttonNamed = (scope: Element, name: string) =>
  [...scope.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === name) ?? null;

test("every agent row has one badge and only its name and meta: no chips, dots, commands or sentences", async () => {
  const view = await mount(runner([readyClaude, appServer("codex", "0.155.1", { authStatus: "unauthenticated" }), gemini("approval-required")]));
  try {
    const rows = [...view.body.querySelectorAll<HTMLButtonElement>("button.row")];
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.equal(row.querySelectorAll(".status").length, 1, row.textContent ?? "");
      for (const selector of [".atag", ".auth-dot", "pre", "p", "code"]) assertNoDomNode(row.querySelector(selector), selector);
    }
    assert.deepEqual(rows.map((row) => row.querySelector(".status")!.textContent), ["Ready", "Sign-In Required", "Approval Required"]);
    // Ready is the quiet inline badge; the ones that ask something are pills.
    assert.ok(rows[0]!.querySelector(".status")!.classList.contains("inline"));
    assert.ok(!rows[1]!.querySelector(".status")!.classList.contains("inline"));
    assert.deepEqual([...rows[0]!.querySelectorAll(".row-sub > span")].map((span) => span.textContent),
      ["Claude Code Native", "Native", "v2.1.4"]);
    assert.equal(view.body.querySelector(".section-title")?.textContent, "Agents 3");
  } finally {
    await view.unmount();
  }
});

test("two Codex App Server installations are told apart by version, in text and accessible names", async () => {
  const view = await mount(runner([appServer("codex-a", "0.155.1"), appServer("codex-b", "0.140.0")]));
  try {
    assert.ok(rowNamed(view.body, "Codex App Server (v0.155.1)"));
    const older = rowNamed(view.body, "Codex App Server (v0.140.0)")!;
    assert.ok(older);
    await act(async () => older.click());
    assert.equal(dialog(view.body)?.querySelector("h2, .modal-title")?.textContent?.trim(), "Codex App Server (v0.140.0)");
    assert.ok(dialog(view.body)!.querySelector('button[aria-label="Copy Codex App Server (v0.140.0) Launch Command"]'));
  } finally {
    await view.unmount();
  }
});

test("three agents not installed sit under a closed disclosure at the end", async () => {
  const view = await mount(runner([
    readyClaude,
    missing("claude-wsl", "Claude Code", { kind: "wsl", distro: "Ubuntu" }),
    missing("claude-debian", "Claude Code", { kind: "wsl", distro: "Debian" }),
    { ...base, id: "codex", name: "Codex", command: "codex", driver: "codex-app-server", available: false,
      codexAppServer: { status: "unavailable", appServerAvailable: false } },
  ]));
  try {
    const disclosure = view.body.querySelector<HTMLDetailsElement>("details.disclosure")!;
    assert.ok(disclosure);
    assert.equal(disclosure.open, false);
    assert.equal(disclosure.querySelector("summary")?.textContent?.trim(), "3 Agents Not Installed");
    assert.equal(disclosure.querySelectorAll("button.row").length, 3);
    assert.ok(disclosure.parentElement?.lastElementChild === disclosure, "the disclosure ends the section");
    assert.deepEqual([...disclosure.querySelectorAll(".row .status")].map((badge) => badge.textContent),
      ["Not Installed", "Not Installed", "Not Installed"]);
  } finally {
    await view.unmount();
  }
});

test("opening a row puts focus in Agent Details, and Done returns it to the row", async () => {
  const view = await mount(runner([readyClaude]));
  try {
    const row = rowNamed(view.body, "Claude Code")!;
    row.focus();
    await act(async () => row.click());
    const details = dialog(view.body)!;
    assert.ok(details);
    assert.ok(details.contains(domWindow.document.activeElement as unknown as Node), "focus moves into the dialog");
    assert.equal(details.querySelector(".modal-desc, p")?.textContent, "On Studio Mac");
    await act(async () => buttonNamed(details, "Done")!.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assertNoDomNode(dialog(view.body), "Done closes Agent Details");
    assert.ok(domWindow.document.activeElement === (rowNamed(view.body, "Claude Code") as unknown), "focus returns to the row");
  } finally {
    await view.unmount();
  }
});

test("Agent Details for a missing agent leads with its notice and install command, and has no launch command", async () => {
  const view = await mount(runner([readyClaude, missing("claude-wsl", "Claude Code", { kind: "wsl", distro: "Ubuntu" })]));
  try {
    await act(async () => rowNamed(view.body, "Claude Code (WSL: Ubuntu)")!.click());
    const details = dialog(view.body)!;
    const notice = details.querySelector<HTMLElement>(".notice")!;
    assert.ok(notice, "the notice leads");
    assert.ok(notice.compareDocumentPosition(details.querySelector("dl.facts")!) & domWindow.Node.DOCUMENT_POSITION_FOLLOWING,
      "the notice comes before the facts");
    assert.match(notice.textContent ?? "", /Not Installed/u);
    assert.equal(notice.querySelector(".code-well code")?.textContent, "curl -fsSL https://claude.ai/install.sh | bash");
    assert.ok(![...details.querySelectorAll("h3")].some((heading) => heading.textContent === "Launch Command"));
  } finally {
    await view.unmount();
  }
});

test("Agent Details for a ready agent has no notice and a Launch Command with copy", async () => {
  const view = await mount(runner([readyClaude]));
  try {
    await act(async () => rowNamed(view.body, "Claude Code")!.click());
    const details = dialog(view.body)!;
    assertNoDomNode(details.querySelector(".notice"), "no notice for a ready agent");
    assert.ok([...details.querySelectorAll("h3")].some((heading) => heading.textContent === "Launch Command"));
    assert.ok(details.querySelector('button[aria-label="Copy Claude Code Launch Command"]'));
    const facts = [...details.querySelectorAll("dl.facts dt")].map((term) => term.textContent);
    assert.deepEqual(facts, ["Integration", "Runs In", "Location", "Version", "Sign-In"]);
  } finally {
    await view.unmount();
  }
});

test("a reference-only Windows launch keeps Executable and Arguments, with nothing to copy", async () => {
  const batch = appServer("codex", "0.155.1", { command: "C:\\Tools\\codex.cmd", args: ["--profile", "%PATH%"] });
  const view = await mount(runner([batch], { os: "windows" }));
  try {
    await act(async () => rowNamed(view.body, "Codex App Server")!.click());
    const details = dialog(view.body)!;
    const terms = [...details.querySelectorAll("dt")].map((term) => term.textContent);
    assert.ok(terms.includes("Executable") && terms.includes("Arguments"));
    assertNoDomNode(details.querySelector('button[aria-label$="Launch Command"]'), "no copy for a reference-only launch");
  } finally {
    await view.unmount();
  }
});

test("Approve Launch… confirms with a primary button and the exact preview; Revoke Approval… is a danger confirmation", async () => {
  const calls: string[] = [];
  const setAcpRegistryApproval = async (_runnerId: string, _agentId: string, body: { action: string }) => {
    calls.push(body.action);
    return { ok: true };
  };
  const waiting = await mount(runner([gemini("approval-required")]), { setAcpRegistryApproval } as unknown as Partial<ApiClient>);
  try {
    await act(async () => rowNamed(waiting.body, "Gemini CLI")!.click());
    await act(async () => buttonNamed(dialog(waiting.body)!, "Approve Launch…")!.click());
    const confirmation = [...waiting.body.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')].at(-1)!;
    const approve = buttonNamed(confirmation, "Approve Launch")!;
    assert.ok(approve.classList.contains("primary"), "a primary button, not a danger one");
    assert.ok(!approve.classList.contains("danger"));
    assert.equal(confirmation.querySelector(".code-well pre")?.textContent, "npx @google/gemini-cli@1.2.0 --experimental-acp");
    assert.match(confirmation.textContent ?? "", /Gemini CLI v1\.2\.0 from the ACP Registry can run this command on Studio Mac\./u);
    await act(async () => approve.click());
    assert.deepEqual(calls, ["approve"]);
  } finally {
    await waiting.unmount();
  }
  const approved = await mount(runner([gemini("approved")]), { setAcpRegistryApproval } as unknown as Partial<ApiClient>);
  try {
    await act(async () => rowNamed(approved.body, "Gemini CLI")!.click());
    const revoke = buttonNamed(dialog(approved.body)!, "Revoke Approval…")!;
    assert.ok(revoke.classList.contains("ghost") && revoke.classList.contains("danger"));
    await act(async () => revoke.click());
    const confirmation = [...approved.body.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')].at(-1)!;
    assert.ok(buttonNamed(confirmation, "Revoke Approval")!.classList.contains("danger"));
    assert.match(confirmation.textContent ?? "", /Gemini CLI v1\.2\.0 can no longer launch from this Registry entry\./u);
  } finally {
    await approved.unmount();
  }
});

test("an unavailable selected installation offers Choose Another Installation…, and only to those who may open Settings", async () => {
  const broken = appServer("codex", "0.155.1", {
    available: false, codexAppServer: { status: "unsupported", appServerAvailable: false,
      failure: { code: "probe_failed", message: "Codex exited before it answered." } },
    installation: { id: "codex-path", path: "/usr/bin/codex", via: "path", selection: "selected" },
  });
  let chosen = 0;
  const manager = await mount(runner([readyClaude, broken]), {}, () => { chosen += 1; });
  try {
    await act(async () => rowNamed(manager.body, "Codex App Server")!.click());
    const details = dialog(manager.body)!;
    assert.match(details.querySelector(".notice")?.textContent ?? "", /Codex exited before it answered\. Rediscover to check it again\./u);
    await act(async () => buttonNamed(details, "Choose Another Installation…")!.click());
    assert.equal(chosen, 1);
    assert.ok(dialog(manager.body), "Agent Details stays under Machine Settings");
  } finally {
    await manager.unmount();
  }
  const viewer = await mount(runner([readyClaude, broken]));
  try {
    await act(async () => rowNamed(viewer.body, "Codex App Server")!.click());
    assertNoDomNode(buttonNamed(dialog(viewer.body)!, "Choose Another Installation…"), "no Settings access, no button");
  } finally {
    await viewer.unmount();
  }
});

test("Find Sessions… replaces Agent Details with Find Agent Sessions for that agent", async () => {
  const view = await mount(runner([readyClaude, appServer("codex", "0.155.1")]), {
    listExternalSessions: async () => ({ sessions: [] }),
  } as unknown as Partial<ApiClient>);
  try {
    await act(async () => rowNamed(view.body, "Codex App Server")!.click());
    await act(async () => buttonNamed(dialog(view.body)!, "Find Sessions…")!.click());
    const dialogs = [...view.body.querySelectorAll<HTMLElement>('[role="dialog"]')];
    assert.equal(dialogs.length, 1, "Agent Details closed");
    assert.match(dialogs[0]!.textContent ?? "", /Find Agent Sessions/u);
  } finally {
    await view.unmount();
  }
});

test("with no agent ready the section says how to install one; while it probes, skeleton rows", async () => {
  const none = await mount(runner([missing("claude", "Claude Code")]));
  try {
    const state = none.body.querySelector(".state")!;
    assert.equal(state.querySelector(".state-title")?.textContent, "No Agents Ready");
    assert.match(state.textContent ?? "", /Install Claude Code or Codex on this machine, then rediscover\./u);
    assert.ok(state.querySelector('.code-well button[aria-label="Copy Claude Code Install Command"]'));
  } finally {
    await none.unmount();
  }
  const probing = await mount(runner([], { agentsRefreshed: false }));
  try {
    assert.equal(probing.body.querySelectorAll(".skeleton .row").length, 3);
    assert.ok(!(probing.body.textContent ?? "").includes("Probing"));
  } finally {
    await probing.unmount();
  }
});
