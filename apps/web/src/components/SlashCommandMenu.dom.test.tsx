import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { ComposerCommand } from "../composer-commands.js";
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

const commands: ComposerCommand[] = [
  {
    id: "app:plan",
    name: "plan",
    label: "/plan",
    invocationAlias: "plan",
    description: "Toggle plan mode without editing files.",
    source: "app",
    sourceLabel: "App",
    argumentHint: "[on|off]",
    executionMode: "app",
    available: true,
    attachmentPolicy: "preserve",
    groupId: "app",
    groupLabel: "App Commands",
  },
  {
    id: "harness:builtin:review",
    name: "review",
    label: "/review",
    invocationAlias: "review",
    description: "Review the current changes.",
    source: "provider",
    sourceLabel: "Built-In",
    providerSource: "builtin",
    executionMode: "passthrough",
    available: true,
    attachmentPolicy: "send",
    groupId: "provider",
    groupLabel: "Harness Commands",
  },
  {
    id: "harness:user:stop/unsafe value",
    name: "stop",
    label: "/harness:stop",
    invocationAlias: "harness:stop",
    source: "provider",
    sourceLabel: "User",
    providerSource: "user",
    executionMode: "passthrough",
    available: false,
    disabledReason: "There is no active turn to stop.",
    attachmentPolicy: "forbid",
    groupId: "provider",
    groupLabel: "Harness Commands",
  },
];

function mountMenu(overrides: Partial<React.ComponentProps<typeof SlashCommandMenu>> = {}) {
  const host = domWindow.document.createElement("div");
  domWindow.document.body.append(host);
  const container = host as unknown as HTMLDivElement;
  const root = createRoot(container);
  const props: React.ComponentProps<typeof SlashCommandMenu> = {
    listboxId: "session-slash-test",
    commands,
    activeCommandId: "harness:builtin:review",
    onActiveCommandChange: () => {},
    onSelectCommand: () => {},
    ...overrides,
  };
  return { container, root, props };
}

test("menu groups commands with stable listbox semantics and an active detail card", async () => {
  const { container, root, props } = mountMenu();
  try {
    await act(async () => root.render(<SlashCommandMenu {...props} />));
    const listbox = container.querySelector('[role="listbox"]')!;
    assert.equal(listbox.id, "session-slash-test");
    assert.equal(listbox.getAttribute("aria-label"), "Slash Commands");
    assert.deepEqual(
      [...container.querySelectorAll(".slash-section-label")].map((label) => label.textContent),
      ["App Commands", "Harness Commands"],
    );

    const options = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    assert.equal(options.length, 3);
    assert.equal(options.every((option) => option.tabIndex === -1), true);
    assert.match(options[1]!.textContent ?? "", /\/review.*Built-In/);
    assert.match(options[2]!.textContent ?? "", /\/harness:stop.*User/);
    assert.equal(options[0]!.id, slashCommandOptionId(props.listboxId, "app:plan"));
    assert.match(options[2]!.id, /^[A-Za-z][A-Za-z0-9_-]*$/);
    assert.equal(new Set(options.map((option) => option.id)).size, options.length);

    const active = options[1]!;
    assert.equal(active.getAttribute("aria-selected"), "true");
    assert.equal(active.getAttribute("aria-describedby"), "session-slash-test-detail");
    assert.match(container.querySelector(".slash-detail")?.textContent ?? "", /Review the current changes\./);
    assert.equal(options[2]!.disabled, false);
    assert.equal(options[2]!.getAttribute("aria-disabled"), "true");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("interleaved ranked results keep their visual and DOM order", async () => {
  const rankedCommands = [commands[1]!, commands[0]!, commands[2]!];
  const { container, root, props } = mountMenu({ commands: rankedCommands });
  try {
    await act(async () => root.render(<SlashCommandMenu {...props} />));
    assert.deepEqual(
      [...container.querySelectorAll('[role="option"]')].map((option) =>
        option.querySelector(".slash-name")?.textContent),
      ["/review", "/plan", "/harness:stop"],
    );
    assert.deepEqual(
      [...container.querySelectorAll(".slash-section-label")].map((label) => label.textContent),
      ["Harness Commands", "App Commands", "Harness Commands"],
    );
    const sectionLabelIds = [...container.querySelectorAll(".slash-section-label")]
      .map((label) => label.id);
    assert.equal(new Set(sectionLabelIds).size, sectionLabelIds.length);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("command-owned group metadata renders even before the menu knows a new registry group", async () => {
  const future = {
    ...commands[1]!,
    id: "future:review",
    groupId: "future",
    groupLabel: "Future Commands",
  } as unknown as ComposerCommand;
  const { container, root, props } = mountMenu({ commands: [future], activeCommandId: future.id });
  try {
    await act(async () => root.render(<SlashCommandMenu {...props} />));
    assert.equal(container.querySelectorAll('[role="option"]').length, 1);
    assert.equal(container.querySelector(".slash-section-label")?.textContent, "Future Commands");
    assert.equal(container.querySelector('[role="option"]')?.textContent?.includes("/review"), true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("active argument and disabled details explain the highlighted command", async () => {
  const { container, root, props } = mountMenu({ activeCommandId: "app:plan" });
  try {
    await act(async () => root.render(<SlashCommandMenu {...props} activeCommandId="app:plan" />));
    assert.match(container.querySelector(".slash-detail")?.textContent ?? "", /Arguments\[on\|off\]/);

    await act(async () => root.render(
      <SlashCommandMenu {...props} activeCommandId="harness:user:stop/unsafe value" />,
    ));
    assert.match(
      container.querySelector(".slash-detail-disabled")?.textContent ?? "",
      /There is no active turn to stop\./,
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("authorized commands warn that attached images remain for the next prompt", async () => {
  const durableReview: ComposerCommand = {
    ...commands[1]!,
    providerCommandId: "provider-command-review",
    catalogRevision: "catalog-7",
    attachmentPolicy: "preserve",
  };
  const { container, root, props } = mountMenu({
    commands: [durableReview],
    activeCommandId: durableReview.id,
    hasAttachments: true,
  });
  try {
    await act(async () => root.render(<SlashCommandMenu {...props} />));
    assert.match(
      container.querySelector(".slash-detail-attachments")?.textContent ?? "",
      /Attached images will not be sent.*remain for your next prompt\./,
    );
    assert.equal(
      container.querySelector('[role="option"]')?.getAttribute("aria-describedby"),
      "session-slash-test-detail",
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("mouse-down selection preserves composer focus and forwards unavailable options for an explanation", async () => {
  const selected: string[] = [];
  const hovered: string[] = [];
  const composer = domWindow.document.createElement("textarea");
  domWindow.document.body.append(composer);
  composer.focus();
  const { container, root, props } = mountMenu({
    onActiveCommandChange: (commandId) => hovered.push(commandId),
    onSelectCommand: (command) => selected.push(command.id),
  });
  try {
    await act(async () => root.render(<SlashCommandMenu {...props} />));
    const review = container.querySelector<HTMLButtonElement>(
      `#${slashCommandOptionId(props.listboxId, "harness:builtin:review")}`,
    )!;
    const enter = new domWindow.MouseEvent("mouseover", { bubbles: true });
    review.dispatchEvent(enter as unknown as Event);
    const down = new domWindow.MouseEvent("mousedown", { bubbles: true, cancelable: true });
    review.dispatchEvent(down as unknown as Event);
    assert.equal(down.defaultPrevented, true);
    assert.equal(domWindow.document.activeElement, composer);
    assert.deepEqual(hovered, ["harness:builtin:review"]);
    assert.deepEqual(selected, ["harness:builtin:review"]);

    const unavailable = container.querySelectorAll<HTMLButtonElement>('[role="option"]')[2]!;
    unavailable.dispatchEvent(
      new domWindow.MouseEvent("mousedown", { bubbles: true, cancelable: true }) as unknown as Event,
    );
    assert.deepEqual(selected, ["harness:builtin:review", "harness:user:stop/unsafe value"]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    composer.remove();
  }
});

test("active option changes scroll the keyboard target into the nearest view", async () => {
  const scrolled: Array<{ id: string; options: ScrollIntoViewOptions | undefined }> = [];
  Object.defineProperty(domWindow.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value(this: HTMLElement, options?: ScrollIntoViewOptions) {
      scrolled.push({ id: this.id, options });
    },
  });
  const { container, root, props } = mountMenu({ activeCommandId: "app:plan" });
  try {
    await act(async () => root.render(<SlashCommandMenu {...props} activeCommandId="app:plan" />));
    scrolled.length = 0;
    await act(async () => root.render(
      <SlashCommandMenu {...props} activeCommandId="harness:builtin:review" />,
    ));
    assert.deepEqual(scrolled, [{
      id: slashCommandOptionId(props.listboxId, "harness:builtin:review"),
      options: { block: "nearest" },
    }]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
