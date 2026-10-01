import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { SessionView } from "@wollipog/protocol";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { browserInstanceManager, InstancesContextProvider, type InstanceManager } from "../instances-context.js";
import { absoluteViewUrl } from "../navigation.js";
import { FeedbackContext } from "./FeedbackProvider.js";
import { SessionHeader } from "./SessionHeader.js";
import { assertNoDomNode } from "../dom-test-assertions.js";

const domWindow = new Window({ url: "http://localhost/session/session-menus" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Element: domWindow.Element,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const tick = () => new Promise<void>((resolve) => domWindow.setTimeout(resolve, 0));
const copied: string[] = [];
Object.defineProperty(domWindow.navigator, "clipboard", {
  configurable: true,
  value: { writeText: async (text: string) => { copied.push(text); } },
});

/** A desktop app connected to a remote Wollipog: the one setup with a reachable session address. */
const remoteInstances: InstanceManager = {
  ...browserInstanceManager,
  activeProfile: {
    id: "remote",
    serverInstanceId: "remote",
    kind: "remote",
    label: "Team",
    origin: "https://wollipog.example.test",
    createdAt: "",
  },
};

const idle = {
  id: "session-menus",
  runnerId: "runner-1",
  title: "Menus",
  status: "idle",
  archived: false,
} as SessionView;

interface Toast { message: string; tone?: string }

async function renderHeader(options: {
  session?: SessionView;
  exportReady?: boolean;
  reachable?: boolean;
  developmentBuild?: boolean;
  client?: Partial<ApiClient>;
  extra?: Partial<React.ComponentProps<typeof SessionHeader>>;
} = {}) {
  const toasts: Toast[] = [];
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const header = (
    <ApiProvider client={{ ...api, ...options.client } as ApiClient}>
      <FeedbackContext.Provider value={{
        confirm: async () => true,
        showToast: (message: string, toastOptions?: { tone?: string }) => {
          toasts.push({ message, tone: toastOptions?.tone });
          return 1;
        },
        showUndo: () => 1,
        dismissToast: () => undefined,
      }}>
        <SessionHeader
          session={options.session ?? idle}
          onBack={() => undefined}
          runnerOnline
          machineName="build-box"
          runnerProtocolVersion={999}
          providerLogoutSupported
          stopBeforeArchiveSupported
          exportReady={options.exportReady ?? true}
          developmentBuild={options.developmentBuild ?? false}
          onSnooze={() => undefined}
          {...options.extra}
        />
      </FeedbackContext.Provider>
    </ApiProvider>
  );
  await act(async () => {
    root.render(options.reachable === false
      ? header
      : <InstancesContextProvider value={remoteInstances}>{header}</InstancesContextProvider>);
  });
  return {
    toasts,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
      domWindow.document.body.innerHTML = "";
    },
  };
}

function page(): HTMLElement {
  return domWindow.document.body as unknown as HTMLElement;
}

async function open(trigger: "Share" | "More Actions"): Promise<HTMLElement> {
  const button = page().querySelector<HTMLButtonElement>(`button[aria-label="${trigger}"]`);
  assert.ok(button, `missing ${trigger}`);
  await act(async () => { button.click(); await tick(); });
  const menu = page().querySelector<HTMLElement>(`[role="menu"][aria-label="${trigger}"]`);
  assert.ok(menu, `${trigger} is open`);
  return menu;
}

/** The menu's rows in order: an item's label, "—" for a separator, and "note" for a note. */
function rows(menu: HTMLElement): string[] {
  return [...menu.querySelectorAll<HTMLElement>('[role="menuitem"], [role="separator"], .menu-note')]
    .map((row) => row.classList.contains("menu-note")
      ? "note"
      : row.getAttribute("role") === "separator" ? "—" : row.querySelector(".menu-text")?.textContent ?? "");
}

function item(menu: HTMLElement, label: string): HTMLButtonElement {
  const match = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((candidate) => candidate.querySelector(".menu-text")?.textContent === label);
  assert.ok(match, `missing menu item: ${label}`);
  return match;
}

function secondLine(element: Element): string | null {
  const ids = (element.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
  return ids.length === 0 ? null : ids.map((id) => domWindow.document.getElementById(id)?.textContent ?? "").join(" ");
}

test("Share holds four items with icons and second lines, then one note, and no section labels", async () => {
  const header = await renderHeader();
  try {
    const menu = await open("Share");
    assert.deepEqual(rows(menu),
      ["Share Transcript…", "Copy Session Link", "—", "Export as Markdown", "Export as JSON", "note"]);
    assert.equal(menu.querySelectorAll(".menu-label").length, 0);
    assert.equal(menu.querySelector(".menu-note")?.textContent,
      "Shared and exported transcripts are redacted, but can still include secrets or source code.");
    for (const row of menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')) {
      assert.ok(row.querySelector(".menu-icon svg"), "each item has its leading 16px icon");
      assert.ok(secondLine(row), "each item has a second line referenced by aria-describedby");
      assert.equal(row.disabled, false);
      assert.equal(row.getAttribute("title"), null);
    }
    assert.equal(secondLine(item(menu, "Share Transcript…")), "Create a read-only link anyone can open.");
    assert.equal(secondLine(item(menu, "Copy Session Link")),
      "Opens this page for people who already use this Wollipog.");
  } finally {
    await header.unmount();
  }
});

test("while the transcript loads, every Share item is disabled with the same reason", async () => {
  const header = await renderHeader({ exportReady: false });
  try {
    const menu = await open("Share");
    const items = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    assert.equal(items.length, 4);
    for (const row of items) {
      assert.equal(row.disabled, true);
      assert.equal(secondLine(row), "Available when the transcript finishes loading.");
    }
  } finally {
    await header.unmount();
  }
});

test("with no reachable address Copy Session Link says to open Wollipog in a browser, naming a build variable only in development", async () => {
  for (const developmentBuild of [false, true]) {
    const header = await renderHeader({ reachable: false, developmentBuild });
    try {
      const menu = await open("Share");
      const copy = item(menu, "Copy Session Link");
      assert.equal(copy.disabled, true);
      assert.equal(secondLine(copy), developmentBuild
        ? "Open Wollipog in a browser to copy a link. Development builds can set VITE_DASHBOARD_ORIGIN."
        : "Open Wollipog in a browser to copy a link.");
      assert.equal(/VITE_/.test(menu.textContent ?? ""), developmentBuild,
        developmentBuild ? "a development build keeps the contributor hint" : "a production build names no build variable");
      assert.equal(item(menu, "Share Transcript…").disabled, false, "the other items stay available");
    } finally {
      await header.unmount();
    }
  }
});

test("Copy Session Link copies the session's address and confirms with a toast", async () => {
  copied.length = 0;
  const header = await renderHeader();
  try {
    const menu = await open("Share");
    await act(async () => { item(menu, "Copy Session Link").click(); await tick(); });
    assert.deepEqual(copied, [absoluteViewUrl("https://wollipog.example.test", { name: "session", id: "session-menus" })]);
    assert.deepEqual(header.toasts, [{ message: "Link copied.", tone: "success" }]);
    assertNoDomNode(page().querySelector('[role="menu"]'), "the menu closes");
  } finally {
    await header.unmount();
  }
});

test("exporting reports a toast, and a failure is an error toast with the server's sentence; the bar shows no note", async () => {
  const downloads: string[] = [];
  const createObjectURL = URL.createObjectURL;
  const revokeObjectURL = URL.revokeObjectURL;
  URL.createObjectURL = () => "blob:transcript";
  URL.revokeObjectURL = () => undefined;
  const ok = await renderHeader({
    client: {
      transcriptExport: async (_id: string, format: "json" | "markdown") => {
        downloads.push(format);
        return { blob: new Blob(["x"]), filename: `transcript.${format === "json" ? "json" : "md"}` };
      },
    } as Partial<ApiClient>,
  });
  try {
    const menu = await open("Share");
    await act(async () => { item(menu, "Export as Markdown").click(); await tick(); await tick(); });
    assert.deepEqual(downloads, ["markdown"]);
    assert.deepEqual(ok.toasts, [{ message: "Transcript exported.", tone: "success" }]);
    // The only live region the bar keeps announces background work (#784, #2182), never a result.
    assertNoDomNode(page().querySelector(
      ".session-header-note, .detail-note, header [role='status'][aria-live]:not([data-live='background-work'])",
    ), "the bar never shows a transient note");
  } finally {
    await ok.unmount();
  }
  const failed = await renderHeader({
    client: { transcriptExport: async () => { throw new ApiError("The transcript is too large to export.", 413); } },
  });
  try {
    const menu = await open("Share");
    await act(async () => { item(menu, "Export as JSON").click(); await tick(); await tick(); });
    assert.deepEqual(failed.toasts, [{ message: "The transcript is too large to export.", tone: "error" }]);
  } finally {
    await failed.unmount();
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
  }
});

test("More Actions has no section labels, separates its groups once each, and ends with the red destructive items", async () => {
  const header = await renderHeader({
    session: { ...idle, driver: "acp", adopted: true, providerAccountId: "work" } as SessionView,
    extra: {
      reminder: {
        state: "fired",
        scheduleKind: "datetime",
        scheduledFor: "2026-10-01T09:00:00.000Z",
        timeZone: "UTC",
        wakeReason: "scheduled",
      } as unknown as React.ComponentProps<typeof SessionHeader>["reminder"],
      onDismissReminder: () => undefined,
      forkAvailability: { available: true, forkTurn: 2 },
      onFork: () => undefined,
    },
  });
  try {
    const menu = await open("More Actions");
    assert.equal(menu.querySelectorAll(".menu-label").length, 0);
    assert.equal(menu.querySelectorAll(".menu-note").length, 0, "no shared caution note");
    const labels = rows(menu);
    assert.deepEqual(labels.filter((label) => label !== "Switch Account…"), [
      "Rename…", "Snooze Again…", "Dismiss Reminder", "Fork Conversation…",
      "—", "Reprocess Transcript", "Sign Out of Agent…",
      "—", "Archive and Stop…",
      "—", "Stop Session…",
    ]);
    assert.ok(item(menu, "Reprocess Transcript").querySelector(".menu-icon svg"), "Reprocess carries the refresh icon");
    assert.equal(item(menu, "Reprocess Transcript").textContent?.includes("↻"), false, "no glyph in the label");
    for (const row of menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')) {
      assert.equal(row.getAttribute("title"), null, `${row.textContent} has no tooltip`);
    }
    const stop = item(menu, "Stop Session…");
    assert.ok(stop.classList.contains("danger"));
    assert.equal(stop, [...menu.querySelectorAll('[role="menuitem"]')].at(-1));
  } finally {
    await header.unmount();
  }
});

test("an archived session offers no Snooze item and ends with Delete Session… in red", async () => {
  const header = await renderHeader({ session: { ...idle, status: "completed", archived: true } as SessionView });
  try {
    const menu = await open("More Actions");
    assert.deepEqual(rows(menu), ["Rename…", "—", "Unarchive", "Restart Session", "—", "Delete Session…"]);
    assert.ok(item(menu, "Delete Session…").classList.contains("danger"));
  } finally {
    await header.unmount();
  }
});

test("a stopped session reads Restart Session beside its archive item, and a fresh reminder reads Snooze…", async () => {
  const header = await renderHeader({ session: { ...idle, status: "stopped" } as SessionView });
  try {
    const menu = await open("More Actions");
    assert.deepEqual(rows(menu), ["Rename…", "Snooze…", "—", "Archive", "Restart Session"]);
  } finally {
    await header.unmount();
  }
});

test("a menu result is a toast: renaming says Session renamed.", async () => {
  const header = await renderHeader({
    client: { renameSession: async (_id: string, title: string) => ({ ...idle, title }) } as Partial<ApiClient>,
  });
  try {
    const menu = await open("More Actions");
    await act(async () => { item(menu, "Rename…").click(); await tick(); });
    const input = page().querySelector<HTMLInputElement>('[role="dialog"] input');
    assert.ok(input, "the rename dialog opens");
    const setValue = Object.getOwnPropertyDescriptor(domWindow.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      input.focus();
      setValue.call(input, "Renamed");
      input.dispatchEvent(new domWindow.InputEvent("input", { bubbles: true }) as never);
      await tick();
    });
    const form = page().querySelector<HTMLFormElement>("#rename-session-form");
    assert.ok(form, "the dialog has its form");
    await act(async () => {
      form.dispatchEvent(new domWindow.Event("submit", { bubbles: true, cancelable: true }) as never);
      await tick();
      await tick();
    });
    assert.deepEqual(header.toasts, [{ message: "Session renamed.", tone: "success" }]);
  } finally {
    await header.unmount();
  }
});

test("a confirmation opened by Fork Conversation… or Archive and Stop… records the trigger, not the vanishing item, as its return focus", async () => {
  const focusedAtHandOff: Array<string | null> = [];
  const label = () => (domWindow.document.activeElement as unknown as Element | null)?.getAttribute("aria-label") ?? null;
  const header = await renderHeader({
    session: { ...idle, status: "running" } as SessionView,
    extra: {
      forkAvailability: { available: true, forkTurn: 2 },
      // SessionDetail and the Sessions list open their confirmation synchronously here, and it
      // returns focus to whatever is focused at that moment.
      onFork: () => { focusedAtHandOff.push(label()); },
      onArchive: () => { focusedAtHandOff.push(label()); },
    },
  });
  try {
    let menu = await open("More Actions");
    await act(async () => { item(menu, "Fork Conversation…").click(); });
    menu = await open("More Actions");
    await act(async () => { item(menu, "Archive and Stop…").click(); });
    assert.deepEqual(focusedAtHandOff, ["More Actions", "More Actions"]);
  } finally {
    await header.unmount();
  }
});

test("a slow clipboard write never closes a Share menu opened again, nor takes its focus (#2161)", async () => {
  const pending: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  const original = Object.getOwnPropertyDescriptor(domWindow.navigator, "clipboard");
  Object.defineProperty(domWindow.navigator, "clipboard", {
    configurable: true,
    value: { writeText: () => new Promise<void>((resolve, reject) => { pending.push({ resolve, reject }); }) },
  });
  const header = await renderHeader();
  try {
    for (const outcome of ["resolve", "reject"] as const) {
      header.toasts.length = 0;
      let menu = await open("Share");
      await act(async () => { item(menu, "Copy Session Link").click(); await tick(); });
      assertNoDomNode(page().querySelector('[role="menu"]'), "the menu closes as the copy starts");

      menu = await open("Share");
      const focused = domWindow.document.activeElement;
      await act(async () => {
        if (outcome === "resolve") pending.at(-1)!.resolve();
        else pending.at(-1)!.reject(new Error("denied"));
        await tick();
        await tick();
      });
      assert.ok(page().querySelector('[role="menu"][aria-label="Share"]'), `${outcome}: the reopened menu stays open`);
      assert.equal(domWindow.document.activeElement, focused, `${outcome}: focus stays where it was`);
      assert.deepEqual(header.toasts, outcome === "resolve" ? [{ message: "Link copied.", tone: "success" }] : [],
        `${outcome}: a stale refusal is dropped rather than reported`);
      await act(async () => { domWindow.document.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape" }) as never); });
      const backdrop = page().querySelector<HTMLElement>(".menu-backdrop");
      if (backdrop) await act(async () => { backdrop.click(); await tick(); });
    }
  } finally {
    await header.unmount();
    if (original) Object.defineProperty(domWindow.navigator, "clipboard", original);
  }
});

test("a late clipboard refusal runs no fallback once More Actions, a dialog or another page took over (#2161)", async () => {
  const pending: Array<(error: Error) => void> = [];
  const original = Object.getOwnPropertyDescriptor(domWindow.navigator, "clipboard");
  Object.defineProperty(domWindow.navigator, "clipboard", {
    configurable: true,
    value: { writeText: () => new Promise<void>((_resolve, reject) => { pending.push(reject); }) },
  });
  const fallbacks: string[] = [];
  const doc = domWindow.document as unknown as { execCommand?: (command: string) => boolean };
  const originalExec = doc.execCommand;
  doc.execCommand = (command: string) => { fallbacks.push(command); return true; };
  const startCopy = async () => {
    const menu = await open("Share");
    await act(async () => { item(menu, "Copy Session Link").click(); await tick(); });
  };
  const refuse = async () => {
    await act(async () => { pending.at(-1)!(new Error("denied")); await tick(); await tick(); });
  };
  try {
    // More Actions opened while the write was pending.
    const more = await renderHeader();
    try {
      await startCopy();
      await open("More Actions");
      const focused = domWindow.document.activeElement;
      await refuse();
      assert.deepEqual(fallbacks, [], "More Actions: no fallback runs");
      assert.equal(domWindow.document.activeElement, focused, "More Actions: focus stays in the menu");
      assert.deepEqual(more.toasts, []);
    } finally {
      await more.unmount();
    }

    // The rename dialog opened while the write was pending.
    const dialog = await renderHeader();
    try {
      await startCopy();
      const menu = await open("More Actions");
      await act(async () => { item(menu, "Rename…").click(); await tick(); });
      const focused = domWindow.document.activeElement;
      assert.ok(page().querySelector('[role="dialog"]')?.contains(focused as never), "the dialog holds focus");
      await refuse();
      assert.deepEqual(fallbacks, [], "dialog: no fallback runs");
      assert.equal(domWindow.document.activeElement, focused, "dialog: focus stays in the dialog");
      assert.deepEqual(dialog.toasts, []);
    } finally {
      await dialog.unmount();
    }

    // The page was left while the write was pending.
    const left = await renderHeader();
    await startCopy();
    await left.unmount();
    await refuse();
    assert.deepEqual(fallbacks, [], "unmounted: no fallback runs");
    assert.deepEqual(left.toasts, [], "unmounted: nothing is reported");

    // Control: a refusal while nothing else took over still falls back and reports the copy.
    const control = await renderHeader();
    try {
      await startCopy();
      await act(async () => { await new Promise((resolve) => domWindow.setTimeout(resolve, 5)); });
      await refuse();
      assert.deepEqual(fallbacks, ["copy"], "control: the fallback copies");
      assert.deepEqual(control.toasts, [{ message: "Link copied.", tone: "success" }]);
      assert.equal((domWindow.document.activeElement as unknown as Element | null)?.getAttribute("aria-label"), "Share",
        "control: focus returns to the Share trigger");
    } finally {
      await control.unmount();
    }
  } finally {
    if (originalExec) doc.execCommand = originalExec; else delete doc.execCommand;
    if (original) Object.defineProperty(domWindow.navigator, "clipboard", original);
  }
});

test("without a Clipboard API (a plain-HTTP page) Copy Session Link falls back at once and reports the copy (#2161)", async () => {
  const original = Object.getOwnPropertyDescriptor(domWindow.navigator, "clipboard");
  Object.defineProperty(domWindow.navigator, "clipboard", { configurable: true, value: undefined });
  const fallbacks: string[] = [];
  const doc = domWindow.document as unknown as { execCommand?: (command: string) => boolean };
  const originalExec = doc.execCommand;
  doc.execCommand = (command: string) => { fallbacks.push(command); return true; };
  const header = await renderHeader();
  try {
    const menu = await open("Share");
    const copy = item(menu, "Copy Session Link");
    copy.focus();
    await act(async () => { copy.click(); await tick(); await tick(); });
    assert.deepEqual(fallbacks, ["copy"], "the synchronous refusal still falls back");
    assert.deepEqual(header.toasts, [{ message: "Link copied.", tone: "success" }]);
    assertNoDomNode(page().querySelector('[role="menu"]'), "the menu closes");
    assert.equal((domWindow.document.activeElement as unknown as Element | null)?.getAttribute("aria-label"), "Share",
      "focus returns to the Share trigger");
  } finally {
    await header.unmount();
    if (originalExec) doc.execCommand = originalExec; else delete doc.execCommand;
    if (original) Object.defineProperty(domWindow.navigator, "clipboard", original);
  }
});
