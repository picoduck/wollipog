import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { EventPayloadReference } from "@wollipog/protocol";
import { api } from "../api.js";
import type { TimelineItem } from "../timeline.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { EventTimeline } from "./EventTimeline.js";
import { ToolStep } from "./ToolStep.js";

const domWindow = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const { cleanup } = installDomTestCleanup(domWindow);

async function mount(): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  cleanup(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
  });
  return { container, root };
}

async function openWork(container: HTMLElement) {
  for (const disclosure of container.querySelectorAll<HTMLButtonElement>(".tl-work > .disclosure-trigger")) {
    if (disclosure.getAttribute("aria-expanded") !== "true") await act(async () => disclosure.click());
  }
}

const t0 = Date.UTC(2026, 9, 2, 12, 0, 0);
const run = (id: number, title: string, status: string, startedAt: number, seconds: number, text = ""): TimelineItem => ({
  kind: "tool_call", id, toolCallId: `call-${id}`, title, toolKind: "execute", status, text,
  startedAt, lastActivityAt: startedAt + seconds * 1_000, completedAt: startedAt + seconds * 1_000,
});

/** A settled turn: four commands, one of them failed, and one edit, over 26 seconds. */
const settledTurn: TimelineItem[] = [
  { kind: "user_message", id: 1, text: "Fix the header", createdAt: t0 },
  run(2, "Bash: npm ci", "completed", t0 + 1_000, 4),
  { ...run(3, "Read: /repo/src/components/Header.tsx", "completed", t0 + 5_000, 1), toolKind: "read" } as TimelineItem,
  { kind: "file_edit", id: 4, path: "/repo/src/components/Header.tsx", diff: "--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n-old\n+new\n+more" },
  run(5, "Bash: npm test", "failed", t0 + 7_000, 6, "Exit code 1\n> vitest run\nPASS src/a.test.ts\nFAIL src/header.test.ts\nError: expected 2 to be 3"),
  run(6, "Bash: npm run lint", "completed", t0 + 14_000, 13),
  { kind: "agent_message", id: 7, text: "The header is fixed; one test still fails.", createdAt: t0 + 28_000 },
];

test("a settled run of work is one ledger line with its failures counted in the danger colour", async () => {
  const { container, root } = await mount();
  await act(async () => root.render(<EventTimeline items={settledTurn} workspaceRoot="/repo" />));

  const trigger = container.querySelector<HTMLButtonElement>(".tl-work > .disclosure-trigger");
  assert.ok(trigger);
  assert.equal(trigger.getAttribute("aria-expanded"), "false", "the work starts collapsed");
  assert.equal(trigger.querySelector(".tl-work-title")?.textContent, "Worked for 26s");
  const meta = [...trigger.querySelectorAll(".tl-work-meta > span")];
  assert.deepEqual(meta.map((item) => item.textContent), ["4 Commands", "1 Edit", "1 Failed"]);
  assert.ok(meta[2]!.classList.contains("tl-work-failed"), "the failure count takes the danger colour");
  assert.ok(meta[2]!.querySelector("svg.lucide-circle-alert"), "with the alert icon");

  await act(async () => root.render(<EventTimeline
    items={settledTurn.map((item) => item.kind === "tool_call" ? { ...item, status: "completed" } : item)}
    workspaceRoot="/repo"
  />));
  assert.deepEqual([...container.querySelectorAll(".tl-work-meta > span")].map((item) => item.textContent),
    ["4 Commands", "1 Edit"], "no failure item and no zero counts");
  assert.doesNotMatch(container.querySelector(".tl-work")?.textContent ?? "", /\b0 /);
});

test("the last run of work reads Working while the turn runs, and its time once something follows it", async () => {
  const { container, root } = await mount();
  const running = settledTurn.slice(0, 3);
  await act(async () => root.render(<EventTimeline items={running} sessionActive />));
  assert.equal(container.querySelector(".tl-work-title")?.textContent, "Working");
  await openWork(container);
  assert.equal(container.querySelector(".tl-work-title")?.textContent, "Working", "its own open steps do not settle it");
  await act(async () => root.render(<EventTimeline items={settledTurn} sessionActive />));
  assert.equal(container.querySelector(".tl-work-title")?.textContent, "Worked for 26s");
});

test("every step is one quiet row: an icon, a verb and its object, one trailing fact and a status", async () => {
  const { container, root } = await mount();
  const items: TimelineItem[] = [
    ...settledTurn.slice(0, 6),
    { kind: "agent_thought", id: 8, text: "Check the **header** test.", createdAt: t0 + 27_000, completedAt: t0 + 29_000 },
    { kind: "tool_call", id: 9, toolCallId: "web", title: "WebFetch: https://example.com", toolKind: "fetch", status: "completed", text: "", startedAt: t0, completedAt: t0 + 2_000 },
  ];
  await act(async () => root.render(<EventTimeline items={items} workspaceRoot="/repo" />));
  await openWork(container);

  const steps = [...container.querySelectorAll<HTMLElement>(".tl-step")];
  assert.equal(steps.length, 7);
  const pictographic = /\p{Extended_Pictographic}/u;
  for (const step of steps) {
    const head = step.querySelector(".tl-step-head")!;
    assert.doesNotMatch(head.textContent ?? "", pictographic, "no emoji in any step row");
    assert.equal(step.querySelectorAll(".tl-step-icon > svg").length, 1, "one 16px icon");
    assert.equal(step.querySelector(".tl-step-icon > svg")?.getAttribute("width"), "16");
    assert.equal(head.querySelectorAll(":scope > .tl-step-status, :scope > .tl-step-done").length, 1, "one status");
    assert.ok(head.querySelectorAll(":scope > .tl-step-trail").length <= 1, "at most one trailing fact");
    const visible = [...head.childNodes].filter((node) => !(node as Element).classList?.contains("tl-step-trail"))
      .map((node) => node.textContent).join(" ");
    assert.doesNotMatch(visible, /Started|Last Activity|Recorded/);
  }
  const titled = (verb: string) => steps.find((step) => step.querySelector(".tl-step-title")?.textContent?.startsWith(verb));
  const trail = (step: HTMLElement | undefined) => [...step!.querySelector(".tl-step-trail")!.childNodes]
    .filter((node) => node.nodeType === 3).map((node) => node.textContent).join("");
  assert.equal(titled("Run npm ci")?.querySelector(".tl-step-object")?.textContent, "npm ci");
  assert.equal(trail(titled("Run npm ci")), "4.0s");
  assert.equal(trail(titled("Edit")), "+2 −1", "an edit's fact is its line count");
  assert.equal(titled("Thought for 2.0s")?.tagName, "DETAILS", "a thought is a step titled by its duration");
  assert.equal(titled("Fetch")?.querySelector(".tl-step-object")?.textContent, "https://example.com");
  assert.ok(titled("Fetch")?.querySelector("svg.lucide-globe"));
  assert.ok(titled("Run npm ci")?.querySelector("svg.lucide-terminal"));
  assert.ok(titled("Read")?.querySelector("svg.lucide-book-open"));
  assert.ok(titled("Edit")?.querySelector("svg.lucide-file-pen"));
  assert.ok(titled("Thought")?.querySelector("svg.lucide-brain"));

  const thought = titled("Thought")!;
  await act(async () => thought.querySelector<HTMLElement>("summary")!.click());
  assert.equal(thought.querySelector(".tl-step-body .tl-step-prose strong")?.textContent, "header", "its text sits in the step body");
});

test("an edit names its workspace-relative path once", async () => {
  const { container, root } = await mount();
  const opened: string[] = [];
  await act(async () => root.render(<EventTimeline
    items={settledTurn}
    workspaceRoot="/repo/"
    onOpenSourceLocation={(location) => opened.push(location.path)}
  />));
  await openWork(container);
  const edit = [...container.querySelectorAll<HTMLElement>(".tl-step")].find((step) => step.textContent?.startsWith("Edit"))!;
  assert.equal(edit.querySelector(".tl-step-object")?.textContent, "src/components/Header.tsx");
  assert.doesNotMatch(edit.querySelector(".tl-step-head")?.textContent ?? "", /\/repo\//);
  assert.equal(edit.querySelector("summary")?.getAttribute("aria-label"), "Edit src/components/Header.tsx · +2 −1 · Completed");
  await act(async () => edit.querySelector<HTMLElement>("summary")!.click());
  const openFile = [...edit.querySelectorAll<HTMLButtonElement>(".tl-diff-actions > button")].find((button) => button.textContent === "Open File")!;
  await act(async () => openFile.click());
  assert.deepEqual(opened, ["src/components/Header.tsx"], "a relative path can now open in the Files panel");
});

test("a tool call's path object keeps its file name whole, and any other object stays plain text", async () => {
  const { container, root } = await mount();
  const step = (id: number, title: string, toolKind: string, text = ""): TimelineItem => ({
    kind: "tool_call", id, toolCallId: `call-${id}`, title, toolKind, status: "completed", text,
  });
  await act(async () => root.render(<EventTimeline workspaceRoot="/repo" items={[
    { kind: "user_message", id: 1, text: "Tidy the header", createdAt: t0 },
    step(2, "Read: /repo/src/components/Header.tsx", "read", "export function Header() {}"),
    step(3, "Delete: /repo/src/legacy/Banner.tsx", "delete", "Deleted"),
    step(4, "Move: src/version.ts → src/release/version.ts", "move", "Moved"),
    step(5, "Read: README.md", "read"),
    step(6, "Bash: cat src/components/Header.tsx", "execute"),
    step(7, "Grep: src/components/", "read"),
    step(8, "WebFetch: https://example.com/docs/a.html", "fetch"),
    step(9, "Read: /hosts", "read"),
  ]} />));
  await openWork(container);
  const steps = [...container.querySelectorAll<HTMLElement>(".tl-step")];
  const parts = (index: number) => {
    const path = steps[index]!.querySelector(".tl-step-object > .tl-path");
    return path && {
      title: path.getAttribute("title"),
      dir: path.querySelector(".tl-path-dir")?.textContent ?? null,
      name: path.querySelector(".tl-path-name")?.textContent,
    };
  };
  assert.deepEqual(parts(0), { title: "src/components/Header.tsx", dir: "src/components/", name: "Header.tsx" });
  assert.deepEqual(parts(1), { title: "src/legacy/Banner.tsx", dir: "src/legacy/", name: "Banner.tsx" });
  assert.deepEqual(parts(2), {
    title: "src/version.ts → src/release/version.ts", dir: "src/version.ts → src/release/", name: "version.ts",
  }, "a move keeps its destination's file name whole");
  assert.deepEqual(parts(3), { title: "README.md", dir: null, name: "README.md" });
  for (const [index, object] of [[4, "cat src/components/Header.tsx"], [5, "src/components/"], [6, "https://example.com/docs/a.html"]] as const) {
    assert.equal(parts(index), null, `${object} is not a path label`);
    assert.equal(steps[index]!.querySelector(".tl-step-object")?.textContent, object, "it keeps its plain trailing-ellipsis object");
  }
  assert.deepEqual(steps.slice(0, 3).map((row) => row.querySelector(".tl-step-head")?.getAttribute("aria-label")), [
    "Read src/components/Header.tsx · Completed",
    "Delete src/legacy/Banner.tsx · Completed",
    "Move src/version.ts → src/release/version.ts · Completed",
  ], "the accessible name still reads the full verb and path");
  assert.equal(steps[3]!.querySelector(".tl-step-title")?.textContent, "Read README.md", "as does a row without a body");
  assert.deepEqual(parts(7), { title: "/hosts", dir: "/", name: "hosts" }, "a root-level path keeps its leading slash");
  assert.equal(steps[7]!.querySelector(".tl-step-title")?.textContent, "Read /hosts");
});

test("a failed step's body shows its exit code and error lines in the danger colour", async () => {
  const { container, root } = await mount();
  await act(async () => root.render(<EventTimeline items={settledTurn} />));
  await openWork(container);
  const failed = [...container.querySelectorAll<HTMLElement>("details.tl-step")].find((step) =>
    step.querySelector("summary")?.getAttribute("aria-label") === "Run npm test · Failed")!;
  assert.ok(failed);
  await act(async () => failed.querySelector<HTMLElement>("summary")!.click());
  const well = failed.querySelector(".tl-step-body > pre.tl-step-output");
  assert.ok(well, "the output sits in a neutral well");
  assert.deepEqual([...well.querySelectorAll(".tl-step-error")].map((line) => line.textContent?.trim()), [
    "Exit code 1",
    "FAIL src/header.test.ts",
    "Error: expected 2 to be 3",
  ]);
  assert.match(well.textContent ?? "", /PASS src\/a\.test\.ts/, "the rest of the output stays, in the neutral colour");
});

test("a failed step prefers its reported exit code, stated once in the danger colour (#2456)", async () => {
  const { container, root } = await mount();
  const items: TimelineItem[] = [
    // Codex: the output arrives as its own row, so the step's body is its exit code alone.
    { ...run(1, "$ make", "failed", t0, 2), exitCode: 2 } as TimelineItem,
    { kind: "command_output", id: 2, text: "make: *** No rule to make target 'all'.  Stop." },
    // Output without an error line: the code is the failure, not the whole output.
    { ...run(3, "$ ./check.sh", "failed", t0 + 3_000, 2, "checking 14 files\n3 files differ"), exitCode: 1 } as TimelineItem,
    // Output that already states the same code shows it once, as its own highlighted line.
    { ...run(4, "Bash: npm test", "failed", t0 + 6_000, 2, "Exit code 2\nError: expected 2 to be 3"), exitCode: 2 } as TimelineItem,
    // A successful command never shows its code.
    { ...run(5, "$ make all", "completed", t0 + 9_000, 2, "built"), exitCode: 0 } as TimelineItem,
    { ...run(6, "$ true", "completed", t0 + 12_000, 2), exitCode: 0 } as TimelineItem,
  ];
  await act(async () => root.render(<EventTimeline items={items} />));
  await openWork(container);
  const step = (label: string) => [...container.querySelectorAll<HTMLElement>(".tl-step")].find((row) =>
    (row.querySelector("summary")?.getAttribute("aria-label") ?? row.textContent)?.startsWith(label))!;
  const open = async (row: HTMLElement) => {
    await act(async () => row.querySelector<HTMLElement>("summary")!.click());
    return row.querySelector<HTMLElement>(".tl-step-body")!;
  };

  const make = step("Run make · ");
  assert.equal(make.tagName, "DETAILS", "a failed step with only a reported code still opens");
  const makeBody = await open(make);
  assert.deepEqual([...makeBody.querySelectorAll(".tl-step-exit")].map((line) => line.textContent), ["Exit Code 2"]);
  assertNoDomNode(makeBody.querySelector("pre"), "its output stays in its own row");

  const check = await open(step("Run ./check.sh"));
  assert.equal(check.querySelector(".tl-step-exit")?.textContent, "Exit Code 1");
  assert.deepEqual([...check.querySelectorAll(".tl-step-error")], [], "the output reads neutral; the code is the failure");

  const npm = await open(step("Run npm test"));
  assertNoDomNode(npm.querySelector(".tl-step-exit"), "no second statement of the same code");
  assert.equal(npm.textContent?.match(/exit code 2/gi)?.length, 1);
  assert.deepEqual([...npm.querySelectorAll(".tl-step-error")].map((line) => line.textContent?.trim()), [
    "Exit code 2",
    "Error: expected 2 to be 3",
  ]);

  const built = await open(step("Run make all"));
  assertNoDomNode(built.querySelector(".tl-step-exit"), "a successful step never shows its code");
  assert.equal(step("Run true").tagName, "DIV", "and gains no body for it");

  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(css, /\.tl-step-exit \{[^}]*color: var\(--danger-text\);/, "the code reads in the danger text colour");
});

test("full tool content that states the reported exit code replaces the step's own line (#2456)", async () => {
  const full = "Exit code 0\n".repeat(400) + "Exit code 2\nmake: *** [all] Error 2\n";
  const reference: EventPayloadReference = {
    artifactId: "full-output",
    mimeType: "text/plain",
    encoding: "utf8",
    sizeBytes: Buffer.byteLength(full),
    sha256: createHash("sha256").update(full).digest("hex"),
  };
  const priorExport = api.artifactExport;
  api.artifactExport = async () => new Blob([full], { type: "text/plain" });
  cleanup(() => { api.artifactExport = priorExport; });
  const { container, root } = await mount();
  const preview = "Exit code 0\n".repeat(3);
  const items: TimelineItem[] = [{
    ...run(1, "$ make", "failed", t0, 2, preview),
    referencedText: [{ preview, refs: [reference] }],
    exitCode: 2,
  } as TimelineItem];
  await act(async () => root.render(<EventTimeline items={items} />));
  await openWork(container);
  const step = container.querySelector<HTMLElement>("details.tl-step")!;
  await act(async () => step.querySelector<HTMLElement>("summary")!.click());
  const codes = () => step.querySelector(".tl-step-body")!.textContent!.match(/exit code 2/gi)?.length ?? 0;
  assert.equal(step.querySelector(".tl-step-exit")?.textContent, "Exit Code 2", "the preview does not state it");
  const load = [...step.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
    button.textContent?.startsWith("Load Full Tool Content"))!;
  await act(async () => load.click());
  for (let tries = 0; tries < 50 && !step.querySelector(".event-payload-full"); tries++) {
    await act(async () => { await new Promise((resolve) => domWindow.setTimeout(resolve, 0)); });
  }
  assert.ok(step.querySelector(".event-payload-full"), "the full content loaded");
  assertNoDomNode(step.querySelector(".tl-step-exit"), "the full content's own line states it instead");
  assert.equal(codes(), 1, "the code reads once");
  const hide = [...step.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
    button.textContent?.startsWith("Hide Full Tool Content"))!;
  await act(async () => hide.click());
  assert.equal(step.querySelector(".tl-step-exit")?.textContent, "Exit Code 2", "hiding it brings the line back");
  assert.equal(codes(), 1);
});

test("an older runner's failed step keeps its text-matched exit code and error lines (#2456)", async () => {
  const { container, root } = await mount();
  await act(async () => root.render(<EventTimeline items={settledTurn} />));
  await openWork(container);
  const failed = [...container.querySelectorAll<HTMLElement>("details.tl-step")].find((step) =>
    step.querySelector("summary")?.getAttribute("aria-label") === "Run npm test · Failed")!;
  await act(async () => failed.querySelector<HTMLElement>("summary")!.click());
  assertNoDomNode(failed.querySelector(".tl-step-exit"), "no reported code, no separate line");
  assert.equal(failed.querySelector(".tl-step-error")?.textContent?.trim(), "Exit code 1");
});

test("three failed attempts of one command fold into one row that lists each attempt", async () => {
  const { container, root } = await mount();
  const error = "Exit code 1\nError: compatibility marker mismatch";
  const items: TimelineItem[] = [
    run(1, "Bash: make validate", "failed", t0, 3, error),
    run(2, "Bash: make validate", "failed", t0 + 4_000, 3, error),
    run(3, "Bash: make validate", "failed", t0 + 8_000, 3, error),
  ];
  await act(async () => root.render(<EventTimeline items={items} />));
  assert.deepEqual([...container.querySelectorAll(".tl-work-meta > span")].map((item) => item.textContent), ["1 Command", "1 Failed"]);
  await openWork(container);
  const steps = container.querySelectorAll<HTMLElement>(".tl-step");
  assert.equal(steps.length, 1, "one row, not three identical failures");
  const step = steps[0]!;
  assert.equal([...step.querySelector(".tl-step-trail")!.childNodes].filter((node) => node.nodeType === 3)
    .map((node) => node.textContent).join(""), "3 Attempts");
  assert.equal(step.querySelector(".tl-step-head > .status")?.textContent, "Failed");
  assert.equal(step.querySelector("summary")?.getAttribute("aria-label"), "Run make validate · 3 Attempts · Failed");
  await act(async () => step.querySelector<HTMLElement>("summary")!.click());
  const attempts = [...step.querySelectorAll(".tl-step-attempt")];
  assert.deepEqual(attempts.map((attempt) => attempt.querySelector(".tl-step-attempt-head")?.textContent), [
    "Attempt 1Failed", "Attempt 2Failed", "Attempt 3Failed",
  ]);
  assert.ok(attempts.every((attempt) => attempt.querySelector(".tl-step-error")));
});

test("open work and nested agent steps sit on rules, never on inline margins", async () => {
  const { container, root } = await mount();
  const items: TimelineItem[] = [
    { kind: "tool_call", id: 1, toolCallId: "agent", title: "Task: audit", toolKind: "agent", status: "completed", text: "" },
    { kind: "tool_call", id: 2, toolCallId: "child", title: "Read: a.ts", toolKind: "read", status: "completed", text: "", parentToolUseId: "agent" },
  ];
  await act(async () => root.render(<EventTimeline items={items} />));
  await openWork(container);
  const depth = (element: Element | null) => {
    let count = 0;
    for (let node = element?.parentElement; node && node !== container; node = node.parentElement) {
      if (node.classList.contains("tl-work-rule")) count += 1;
    }
    return count;
  };
  const steps = [...container.querySelectorAll(".tl-step")];
  assert.deepEqual(steps.map(depth), [2], "a nested agent's step adds one rule; the agent's call has no step row");
  assert.equal(depth(container.querySelector(".tl-agent")), 1, "the agent's row sits on its group's rule");
  assert.equal(container.querySelectorAll("[style*='margin']").length, 0, "no inline margin anywhere");
  assert.ok(container.querySelector(".tl-agent svg.disclosure-chevron"), "the agent row uses the §5.5 chevron");
});

test("controls inside a step summary keep their own actions without changing its disclosure", async () => {
  const { container, root } = await mount();
  let actions = 0;
  let toggles = 0;
  function Fixture() {
    const [open, setOpen] = React.useState(false);
    return <ToolStep
      icon={null}
      verb={<>
        <span className="step-title">Inspect Step</span>
        <button type="button" onClick={() => { actions += 1; }}><span>Inspect</span></button>
        <a href="/details" onClick={(event) => { event.preventDefault(); actions += 1; }}>Open Details</a>
      </>}
      open={open}
      onToggle={() => { toggles += 1; setOpen((previous) => !previous); }}
    >Step content</ToolStep>;
  }
  await act(async () => root.render(<Fixture />));
  const details = container.querySelector<HTMLDetailsElement>("details")!;
  await act(async () => container.querySelector<HTMLElement>("button > span")!.click());
  await act(async () => container.querySelector<HTMLAnchorElement>("a")!.click());
  assert.equal(actions, 2);
  assert.equal(toggles, 0);
  assert.equal(details.open, false);
  await act(async () => container.querySelector<HTMLElement>(".step-title")!.click());
  assert.equal(details.open, true);
  await act(async () => container.querySelector<HTMLElement>(".step-title")!.click());
  assert.equal(details.open, false);
  assert.equal(toggles, 2);
});
