import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { assertNoDomNode } from "../dom-test-assertions.js";
import {
  buildComposerCommandRegistry,
  composerCommandsInPickerOrder,
  rankComposerCommands,
  type ComposerCommand,
} from "../composer-commands.js";
import { SlashCommandMenu, slashCommandOptionId } from "./SlashCommandMenu.js";

const domWindow = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  MouseEvent: domWindow.MouseEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

/** A session with app, harness and skill commands whose names share prefixes across groups. */
const registry = buildComposerCommandRegistry({
  context: { planSupported: true, canStopTurn: false, canRespond: false, agentLabel: "Claude Code" },
  providerCommands: [
    { name: "review", providerSource: "builtin", description: "Review the current changes.", argumentHint: "[focus]" },
    { name: "resume", providerSource: "builtin", description: "Resume a conversation." },
    { name: "release-notes", providerSource: "skill", description: "Write release notes." },
    { name: "refactor", providerSource: "skill", description: "Refactor a module." },
    { name: "plan-review", providerSource: "user", description: "Review the plan." },
    {
      name: "deploy",
      providerSource: "plugin",
      available: false,
      disabledReason: "Deploys are paused for this workspace.",
    },
  ],
});

function command(id: string): ComposerCommand {
  const found = registry.find((candidate) => candidate.id === id);
  assert.ok(found, `missing ${id}`);
  return found;
}

/** What the composer offers for a typed query: ranked, then grouped into picker order. */
function offered(query: string): ComposerCommand[] {
  const ranked = rankComposerCommands(registry, query).map((match) => match.command);
  return composerCommandsInPickerOrder(query ? ranked : ranked.filter((candidate) => candidate.available));
}

async function render(props: Partial<React.ComponentProps<typeof SlashCommandMenu>>) {
  const host = domWindow.document.createElement("div");
  domWindow.document.body.append(host);
  const container = host as unknown as HTMLDivElement;
  const root = createRoot(container);
  const full: React.ComponentProps<typeof SlashCommandMenu> = {
    listboxId: "session-slash-test",
    commands: [],
    query: "/",
    activeCommandId: null,
    onActiveCommandChange: () => {},
    onSelectCommand: () => {},
    ...props,
  };
  await act(async () => root.render(<SlashCommandMenu {...full} />));
  return {
    container,
    rerender: (next: Partial<React.ComponentProps<typeof SlashCommandMenu>>) =>
      act(async () => root.render(<SlashCommandMenu {...full} {...next} />)),
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const groupLabels = (container: HTMLElement) =>
  [...container.querySelectorAll(".picker-group-label")].map((label) => label.textContent);

test("every prefix of every command name renders each group label at most once", async () => {
  const queries = new Set<string>([""]);
  for (const candidate of registry) {
    for (let length = 1; length <= candidate.invocationAlias.length; length += 1) {
      queries.add(candidate.invocationAlias.slice(0, length));
    }
  }
  const view = await render({});
  try {
    for (const query of queries) {
      const commands = offered(query);
      await view.rerender({ commands, query: `/${query}` });
      const labels = groupLabels(view.container);
      assert.equal(new Set(labels).size, labels.length, `/${query} repeated a group: ${labels.join(", ")}`);
      // Grouping keeps every offered command, in the order the arrow keys walk.
      assert.deepEqual(
        [...view.container.querySelectorAll('[role="option"]')].map((option) => option.id),
        commands.map((candidate) => slashCommandOptionId("session-slash-test", candidate.id)),
      );
    }
    // "/re" interleaves all three sources in rank order; each still appears once, best match first.
    await view.rerender({ commands: offered("re"), query: "/re" });
    assert.deepEqual(groupLabels(view.container), ["Wollipog", "Skills", "Claude Code"]);
  } finally {
    await view.unmount();
  }
});

test("the best match's group leads", async () => {
  const view = await render({ commands: offered("rel"), query: "/rel" });
  try {
    assert.equal(groupLabels(view.container)[0], "Skills");
  } finally {
    await view.unmount();
  }
});

test("rows show the typed token, its argument hint and description, and no source badge", async () => {
  const commands = [command("app:rename-session"), command("app:plan"), command("provider:builtin:review")];
  const view = await render({ commands, activeCommandId: "app:plan" });
  try {
    const options = [...view.container.querySelectorAll<HTMLElement>('[role="option"]')];
    assert.deepEqual(options.map((option) => option.querySelector(".picker-token")?.textContent), [
      "/rename-session",
      "/plan [on|off]",
      "/review [focus]",
    ]);
    assert.equal(options[1]!.querySelector(".picker-hint")?.textContent, " [on|off]");
    assert.equal(options[0]!.textContent?.includes("Rename Session"), false);
    for (const badge of ["App", "Built-In", "Harness"]) {
      assert.equal(options.some((option) => option.textContent?.includes(badge)), false, `badge ${badge}`);
    }
    // Named by the token, described by the description.
    const planId = slashCommandOptionId("session-slash-test", "app:plan");
    assert.equal(options[1]!.getAttribute("aria-labelledby"), `${planId}-token`);
    assert.equal(options[1]!.getAttribute("aria-describedby"), `${planId}-desc`);
    assertNoDomNode(view.container.querySelector(".slash-detail, .slash-src, .slash-palette"));
  } finally {
    await view.unmount();
  }
});

test("a disabled command shows its reason as a visible second line on every row", async () => {
  const stop = command("app:stop");
  const deploy = command("provider:plugin:deploy");
  const view = await render({
    commands: [command("provider:builtin:review"), stop, deploy],
    activeCommandId: "provider:builtin:review",
  });
  try {
    const reasons = [...view.container.querySelectorAll(".picker-reason")].map((reason) => reason.textContent);
    // Deploy joins review's group, which leads; stop's group follows.
    assert.deepEqual(reasons, ["Deploys are paused for this workspace.", "There's no turn to stop right now."]);
    const stopOption = view.container.querySelector<HTMLElement>(`#${slashCommandOptionId("session-slash-test", stop.id)}`)!;
    assert.equal(stopOption.getAttribute("aria-disabled"), "true");
    assert.equal(stopOption.getAttribute("aria-selected"), "false");
    assert.ok(stopOption.querySelector(".picker-reason svg"), "the reason leads with the ban icon");
    assert.match(stopOption.getAttribute("aria-describedby") ?? "", /-reason$/);
  } finally {
    await view.unmount();
  }
});

test("the active row notes that an authorized command keeps attached images", async () => {
  const durableReview: ComposerCommand = {
    ...command("provider:builtin:review"),
    providerCommandId: "provider-command-review",
    catalogRevision: "catalog-7",
    attachmentPolicy: "preserve",
  };
  const view = await render({ commands: [durableReview], activeCommandId: durableReview.id, hasAttachments: true });
  try {
    const note = view.container.querySelector(".picker-reason.is-note");
    assert.match(note?.textContent ?? "", /doesn't send images\. They stay here for your next message\./);
    await view.rerender({ activeCommandId: null });
    assertNoDomNode(view.container.querySelector(".picker-reason"), "only the active row carries the note");
  } finally {
    await view.unmount();
  }
});

test("a query that matches nothing keeps the picker open on a no-match row", async () => {
  const view = await render({ commands: [], query: "/zzzz" });
  try {
    assert.ok(view.container.querySelector('[role="listbox"][aria-label="Slash Commands"]'));
    assert.equal(view.container.querySelectorAll('[role="option"]').length, 0);
    const empty = view.container.querySelector(".picker-empty");
    assert.equal(empty?.textContent, "No commands match “/zzzz”.");
    assert.equal(empty?.getAttribute("role"), "status");
  } finally {
    await view.unmount();
  }
});

test("group labels and footer keys are Title Case; descriptions and reasons are sentences", async () => {
  const view = await render({ commands: offered("re"), query: "/re" });
  try {
    const footer = [...view.container.querySelectorAll(".picker-keys .shortcut-hint-label")].map((label) => label.textContent);
    assert.deepEqual(footer, ["Move", "Run or Insert", "Complete", "Close"]);
    for (const label of groupLabels(view.container)) assert.match(label ?? "", /^[A-Z]/);
    for (const description of view.container.querySelectorAll(".picker-desc")) {
      assert.match(description.textContent ?? "", /^[A-Z][^]*\.$/);
    }
  } finally {
    await view.unmount();
  }
});
