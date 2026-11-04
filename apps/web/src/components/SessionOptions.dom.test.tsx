import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { ExecutionTargetBoundaries } from "@wollipog/protocol";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { SessionOptions, describeBoundaries, type SessionOptionsAttention } from "./SessionOptions.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const SUMMARY = [
  { key: "role", icon: <svg />, label: "Normal" },
  { key: "harness", icon: <svg />, label: "Direct" },
  { key: "working-copy", icon: <svg />, label: "In Place" },
  { key: "permissions", icon: <svg />, label: "Harness Default" },
];

let setAttention: (attention: SessionOptionsAttention[]) => void = () => undefined;

function Harness({ initial }: { initial: SessionOptionsAttention[] }) {
  const [open, setOpen] = useState(false);
  const [attention, set] = useState(initial);
  setAttention = set;
  return (
    <SessionOptions open={open} onOpenChange={setOpen} summary={SUMMARY} attention={attention}>
      <p>Rows</p>
    </SessionOptions>
  );
}

async function mount(initial: SessionOptionsAttention[] = []) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => { root.render(<Harness initial={initial} />); });
  const head = container.querySelector<HTMLButtonElement>("button.disclosure-trigger")!;
  const body = container.querySelector<HTMLElement>(".disclosure-body")!;
  return {
    head,
    body,
    expanded: () => head.getAttribute("aria-expanded"),
    cleanup: async () => { await act(async () => { root.unmount(); }); container.remove(); },
  };
}

test("closed, the head is Options and lists the current values as meta (#2954)", async () => {
  const view = await mount();
  try {
    assert.equal(view.expanded(), "false");
    assert.equal(view.body.hidden, true, "the body stays mounted, hidden, so its state survives");
    assert.equal(view.head.getAttribute("aria-controls"), view.body.id);
    const name = domWindow.document.getElementById(view.head.getAttribute("aria-labelledby")!)?.textContent;
    assert.equal(name, "Options", "the button is named Options alone");
    const meta = [...view.head.querySelectorAll(".session-options-meta-item")].map((item) => item.textContent);
    assert.deepEqual(meta, ["Normal", "Direct", "In Place", "Harness Default"]);
    assert.equal(domWindow.document.getElementById(view.head.getAttribute("aria-describedby")!)?.textContent,
      "NormalDirectIn PlaceHarness Default", "and described by the values it lists");
    for (const icon of view.head.querySelectorAll(".session-options-meta-icon")) {
      assert.equal(icon.getAttribute("aria-hidden"), "true");
    }
    await act(async () => { view.head.click(); });
    assert.equal(view.expanded(), "true");
    assert.equal(view.body.hidden, false);
    assertNoDomNode(view.head.querySelector(".session-options-meta"), "open, the rows say the values");
  } finally {
    await view.cleanup();
  }
});

test("a new attention opens Options; closing over it keeps it closed, and the head names it (#2954)", async () => {
  const view = await mount();
  try {
    await act(async () => { setAttention([{ key: "skills", label: "Skills Unavailable" }]); });
    assert.equal(view.expanded(), "true", "it opens by itself");
    await act(async () => { view.head.click(); });
    assert.equal(view.expanded(), "false");
    const warning = view.head.querySelector(".status.inline.t-warning");
    assert.equal(warning?.textContent, "Skills Unavailable", "named first, in the warning tone");
    await act(async () => { setAttention([{ key: "skills", label: "Skills Unavailable" }]); });
    assert.equal(view.expanded(), "false", "the same attention never reopens it");
    await act(async () => { setAttention([{ key: "skills", label: "Skills Unavailable" }, { key: "defaults", label: "Permissions Not Loaded" }]); });
    assert.equal(view.expanded(), "true", "another one does");
    await act(async () => { view.head.click(); setAttention([]); });
    await act(async () => { setAttention([{ key: "skills", label: "Skills Unavailable" }]); });
    assert.equal(view.expanded(), "true", "one that cleared and came back is new again");
  } finally {
    await view.cleanup();
  }
});

test("Options opens at once when it mounts with something that needs attention (#2954)", async () => {
  const view = await mount([{ key: "orchestrator-unavailable", label: "Orchestrator Unavailable" }]);
  try {
    assert.equal(view.expanded(), "true");
  } finally {
    await view.cleanup();
  }
});

const BOUNDARY_VALUES = {
  filesystem: ["host", "worktree", "container", "snapshot"],
  network: ["inherit", "deny", "policy"],
  secrets: ["runner_local", "references", "none"],
  billing: ["agent_account", "target_metered", "none", "unknown"],
} as const satisfies { [K in keyof ExecutionTargetBoundaries]: readonly ExecutionTargetBoundaries[K][] };

/** Every combination of boundary values, so no single value can leak through as an enum. */
function everyBoundaries(): ExecutionTargetBoundaries[] {
  const all: ExecutionTargetBoundaries[] = [];
  for (const filesystem of BOUNDARY_VALUES.filesystem)
    for (const network of BOUNDARY_VALUES.network)
      for (const secrets of BOUNDARY_VALUES.secrets)
        for (const billing of BOUNDARY_VALUES.billing) all.push({ filesystem, network, secrets, billing });
  return all;
}

test("a target's boundaries are described in words, never as their enum values (#2954)", () => {
  assert.equal(describeBoundaries({ filesystem: "container", network: "deny", secrets: "none", billing: "none" }),
    "No network, secrets or billing. Only the workspace is mounted.");
  assert.equal(describeBoundaries({ filesystem: "host", network: "inherit", secrets: "runner_local", billing: "agent_account" }),
    "Uses this machine's network and secrets. Billed to your agent account. Works in your checkout.");
  assert.equal(describeBoundaries({ filesystem: "snapshot", network: "policy", secrets: "references", billing: "target_metered" }),
    "Uses the network its policy allows and only the secrets it references. Billed by this target as it runs. Works on a copy of the workspace.");
  const enumWords = /runner_local|agent_account|target_metered|\binherit\b|\bdeny\b|\bnone\b|\bunknown\b|Network (?:inherit|deny|policy)|Secrets (?:none|references)|Billing (?:none|unknown)/u;
  for (const boundaries of everyBoundaries()) {
    const sentence = describeBoundaries(boundaries);
    assert.doesNotMatch(sentence, enumWords, `${JSON.stringify(boundaries)} reads as words: ${sentence}`);
    assert.match(sentence, /^[A-Z].*\.$/u, "complete sentences");
  }
  const distinct = new Set(everyBoundaries().map(describeBoundaries));
  assert.equal(distinct.size, everyBoundaries().length, "two different targets never read the same");
});
