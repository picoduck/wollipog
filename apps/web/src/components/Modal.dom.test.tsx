import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { FeedbackProvider, useFeedback, type ConfirmationOptions } from "./FeedbackProvider.js";
import { Modal } from "./Modal.js";
import { assertNoDomNode } from "../dom-test-assertions.js";

const domWindow = new Window({ url: "http://localhost/" });
/** The query results the stub answers `true` for. Everything else, including `(pointer: fine)`, is false. */
let matchingMedia = new Set<string>();
Object.defineProperty(domWindow, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches: matchingMedia.has(query),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }),
});
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  KeyboardEvent: domWindow.KeyboardEvent,
  MouseEvent: domWindow.MouseEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

const document = domWindow.document as unknown as Document;
const PHONE = "(max-width: 760px)";
const tick = () => new Promise<void>((resolve) => domWindow.setTimeout(resolve, 0));

const mounted = new Set<() => Promise<void>>();

async function mount(node: React.ReactNode): Promise<{ container: HTMLDivElement; root: Root; unmount: () => Promise<void> }> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(node); });
  const unmount = async () => {
    if (!mounted.delete(unmount)) return;
    await act(async () => { root.unmount(); await tick(); });
    container.remove();
  };
  mounted.add(unmount);
  return { container, root, unmount };
}

// A failed assertion must not leave a dialog registered for the next test to stack on.
afterEach(async () => {
  for (const unmount of [...mounted]) await unmount();
  matchingMedia = new Set();
});

function click(element: Element | null) {
  assert.ok(element, "expected an element to click");
  (element as HTMLElement).click();
}

test("a dialog is portalled to <body> with the shared anatomy, out of a transformed ancestor", async () => {
  matchingMedia = new Set();
  const view = await mount(
    <div className="inbox-project-menu" style={{ transform: "translateY(-50%)" }}>
      <Modal title="Rename Project" onClose={() => undefined} footer={<button className="btn">Cancel</button>}>
        <input aria-label="Project Name" />
      </Modal>
    </div>,
  );
  const backdrop = document.querySelector(".modal-backdrop");
  assert.equal(backdrop?.parentElement, document.body, "the backdrop is a direct child of <body>");
  assertNoDomNode(view.container.querySelector(".modal-backdrop"), "nothing renders under the opener's ancestors");
  const dialog = document.querySelector('[role="dialog"]')!;
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  assert.equal(dialog.querySelector("h2.modal-title")?.textContent, "Rename Project");
  assert.equal(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent, "Rename Project");
  const close = dialog.querySelector<HTMLButtonElement>(".modal-head .icon-btn.modal-close");
  assert.equal(close?.getAttribute("aria-label"), "Close");
  assert.equal(document.querySelector(".modal")?.className, "modal", "a form dialog is the default 560px size");
  assert.ok(document.querySelector(".modal > .sheet-grabber[aria-hidden='true']"), "the grabber is decorative");
  await view.unmount();
  assertNoDomNode(document.querySelector(".modal-backdrop"));
});

test("sizes are classes on the surface, and the panel carries the caller's class", async () => {
  matchingMedia = new Set();
  for (const [size, expected] of [["sm", "modal sm"], ["lg", "modal lg"], ["full", "modal full"]] as const) {
    const view = await mount(<Modal title="Sized" size={size} className="custom-dialog" onClose={() => undefined}>Body</Modal>);
    assert.equal(document.querySelector(".modal")?.className, expected);
    assert.equal(document.querySelector('[role="dialog"]')?.className, "modal-panel custom-dialog");
    await view.unmount();
  }
});

test("a child stacks on its parent on desktop, and closing it returns focus inside the parent", async () => {
  matchingMedia = new Set();
  function Parent() {
    const [child, setChild] = useState(false);
    return (
      <>
        <Modal title="New Session" onClose={() => undefined}>
          <input aria-label="Title" />
          <button type="button" className="btn ghost" data-testid="open-child" onClick={() => setChild(true)}>Create Project…</button>
        </Modal>
        {child && (
          <Modal title="Create Project" onClose={() => setChild(false)}>
            <input aria-label="Project Name" />
          </Modal>
        )}
      </>
    );
  }
  const view = await mount(<Parent />);
  const title = document.querySelector<HTMLInputElement>('input[aria-label="Title"]')!;
  title.value = "Keep this draft";
  const opener = document.querySelector<HTMLButtonElement>('[data-testid="open-child"]')!;
  opener.focus();
  await act(async () => { opener.click(); });

  const backdrops = [...document.body.children].filter((element) => element.classList.contains("modal-backdrop"));
  assert.equal(backdrops.length, 2, "the child gets its own layer on desktop");
  // One shared dim (§7.1): only the child's backdrop is `.stacked`, which draws no second dim.
  assert.deepEqual(backdrops.map((backdrop) => backdrop.classList.contains("stacked")), [false, true]);
  const panels = document.querySelectorAll('[role="dialog"]');
  assert.deepEqual([...panels].map((panel) => panel.querySelector("h2")?.textContent), ["New Session", "Create Project"]);
  assert.equal(panels[0]!.hasAttribute("hidden"), false, "New Session stays visible under the child");

  await act(async () => {
    domWindow.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape" }));
    await tick();
  });
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 1, "Escape closes only the child");
  // Focus is restored on the task after the child unmounts.
  await act(async () => { await tick(); });
  assert.equal(document.activeElement, opener, "focus returns to Create Project… inside New Session");
  assert.equal(document.querySelector<HTMLInputElement>('input[aria-label="Title"]')?.value, "Keep this draft");
  await view.unmount();
});

test("an Escape that belongs to an IME composition leaves the dialog open", async () => {
  matchingMedia = new Set();
  let closes = 0;
  const view = await mount(
    <Modal title="New Session" onClose={() => { closes += 1; }}>
      <input aria-label="Search Project Options" />
    </Modal>,
  );
  const field = document.querySelector<HTMLInputElement>('input[aria-label="Search Project Options"]')!;
  // Dismissing a candidate list: the browser reports the key as composing, or as keyCode 229.
  for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
    await act(async () => {
      field.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true, ...init }) as never);
      await tick();
    });
  }
  assert.equal(closes, 0, "the input method keeps its Escape");
  await act(async () => {
    field.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as never);
    await tick();
  });
  assert.equal(closes, 1, "an ordinary Escape still closes the dialog");
  await view.unmount();
});

test("on a phone a confirmation takes over the open sheet, and Back returns to it with its values", async () => {
  matchingMedia = new Set([PHONE]);
  let answer: boolean | undefined;
  function ManageTeam() {
    const { confirm } = useFeedback();
    return (
      <Modal
        title="Manage Platform"
        onClose={() => undefined}
        tertiary={(
          <button type="button" className="btn ghost danger" onClick={() => {
            void confirm({ title: "Delete Team", message: "“Platform” is removed permanently.", confirmLabel: "Delete Team", tone: "danger" })
              .then((value) => { answer = value; });
          }}>Delete Team</button>
        )}
        footer={<><button className="btn">Cancel</button><button className="btn primary">Save Members</button></>}
      >
        <input aria-label="Members" />
      </Modal>
    );
  }
  const view = await mount(<FeedbackProvider><ManageTeam /></FeedbackProvider>);
  document.querySelector<HTMLInputElement>('input[aria-label="Members"]')!.value = "Ada, Grace";
  const tertiary = document.querySelector(".modal-body > .modal-tertiary > .btn.ghost.danger");
  assert.ok(tertiary, "a phone sheet moves the destructive tertiary to the body's end");
  assertNoDomNode(document.querySelector(".modal-foot .modal-tertiary"));
  await act(async () => { click(tertiary); await tick(); });

  assert.equal(document.querySelectorAll(".modal").length, 1, "only one sheet exists in the DOM");
  assert.equal(document.querySelectorAll(".modal-backdrop").length, 1, "under one dim");
  const [parent, confirmation] = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')];
  assert.equal(confirmation?.closest(".modal"), parent?.closest(".modal"), "the confirmation is shown in the parent's sheet");
  assert.equal(parent?.hasAttribute("hidden"), true);
  assert.equal(parent?.hasAttribute("inert"), true);
  assert.equal(confirmation?.classList.contains("pushed"), true, "it slides in from the right");
  assert.equal(confirmation?.querySelector("h2")?.textContent, "Delete Team");
  const back = confirmation?.querySelector<HTMLButtonElement>(".modal-back");
  assert.equal(back?.getAttribute("aria-label"), "Back to Manage Platform");
  assertNoDomNode(confirmation?.querySelector(".modal-tone-icon"), "Back takes the tone icon's place");
  assertNoDomNode(confirmation?.querySelector(".modal-close"));

  await act(async () => { click(back!); await tick(); });
  assert.equal(answer, false, "Back resolves the confirmation as cancelled");
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 1);
  assert.equal(parent?.hasAttribute("hidden"), false);
  assert.equal(parent?.hasAttribute("inert"), false);
  assert.equal(document.querySelector<HTMLInputElement>('input[aria-label="Members"]')?.value, "Ada, Grace");
  await view.unmount();
  matchingMedia = new Set();
});

test("the scrim of a phone sheet closes only the panel on top", async () => {
  matchingMedia = new Set([PHONE]);
  let answer: boolean | undefined;
  let parentClosed = false;
  function Parent() {
    const { confirm } = useFeedback();
    return (
      <Modal title="Manage Platform" onClose={() => { parentClosed = true; }}>
        <button type="button" data-testid="ask" onClick={() => {
          void confirm({ title: "Delete Team", message: "Gone.", confirmLabel: "Delete Team", tone: "danger" }).then((value) => { answer = value; });
        }}>Delete Team</button>
      </Modal>
    );
  }
  const view = await mount(<FeedbackProvider><Parent /></FeedbackProvider>);
  await act(async () => { click(document.querySelector('[data-testid="ask"]')); await tick(); });
  const backdrop = document.querySelector(".modal-backdrop")!;
  await act(async () => {
    backdrop.dispatchEvent(new domWindow.MouseEvent("mousedown", { bubbles: true }) as unknown as Event);
    await tick();
  });
  assert.equal(answer, false);
  assert.equal(parentClosed, false);
  await view.unmount();
  matchingMedia = new Set();
});

test("long forms open as a full-height phone sheet with a back arrow and no grabber", async () => {
  matchingMedia = new Set([PHONE]);
  let closed = false;
  const view = await mount(<Modal title="New Session" phoneSheet="full" onClose={() => { closed = true; }}>Form</Modal>);
  assert.equal(document.querySelector(".modal")?.classList.contains("sheet-full"), true);
  assertNoDomNode(document.querySelector(".sheet-grabber"));
  assertNoDomNode(document.querySelector(".modal-close"));
  const back = document.querySelector<HTMLButtonElement>(".modal-back");
  assert.equal(back?.getAttribute("aria-label"), "Back");
  await act(async () => { click(back); });
  assert.equal(closed, true);
  await view.unmount();
  matchingMedia = new Set();
});

test("a desktop footer keeps the destructive tertiary far left", async () => {
  matchingMedia = new Set();
  const view = await mount(
    <Modal title="Manage Platform" onClose={() => undefined} tertiary={<button className="btn ghost danger">Delete Team</button>}
      footer={<><button className="btn">Cancel</button><button className="btn primary">Save Members</button></>}>
      Body
    </Modal>,
  );
  const foot = document.querySelector(".modal-foot")!;
  assert.equal(foot.firstElementChild?.className, "modal-tertiary");
  assert.deepEqual([...foot.querySelectorAll("button")].map((button) => button.textContent), ["Delete Team", "Cancel", "Save Members"]);
  assertNoDomNode(document.querySelector(".modal-body .modal-tertiary"));
  await view.unmount();
});

test("a destructive confirmation is small, has the warning icon and no close button, and focuses Cancel", async () => {
  matchingMedia = new Set();
  function Ask({ options }: { options: ConfirmationOptions }) {
    const { confirm } = useFeedback();
    return <button data-testid="ask" onClick={() => void confirm(options)}>Ask</button>;
  }
  const view = await mount(
    <FeedbackProvider>
      <Ask options={{ title: "Stop Session", message: "“Fix rounding” stops now.", confirmLabel: "Stop Session", tone: "danger" }} />
    </FeedbackProvider>,
  );
  await act(async () => { click(view.container.querySelector('[data-testid="ask"]')); await tick(); });
  assert.equal(document.querySelector(".modal")?.className, "modal sm");
  const dialog = document.querySelector('[role="dialog"]')!;
  assert.ok(dialog.querySelector(".modal-head > .modal-tone-icon svg"), "the red warning icon precedes the title");
  assertNoDomNode(dialog.querySelector(".modal-close"));
  assert.deepEqual([...dialog.querySelectorAll(".modal-foot button")].map((button) => [button.className, button.textContent]), [
    ["btn", "Cancel"],
    ["btn danger", "Stop Session"],
  ]);
  assert.equal(document.activeElement?.textContent, "Cancel");
  await view.unmount();
});

test("a non-destructive confirmation uses a primary button and no tone icon", async () => {
  matchingMedia = new Set();
  function Ask() {
    const { confirm } = useFeedback();
    return <button data-testid="ask" onClick={() => void confirm({ title: "Recover Session", message: "A new session starts.", confirmLabel: "Recover Session" })}>Ask</button>;
  }
  const view = await mount(<FeedbackProvider><Ask /></FeedbackProvider>);
  await act(async () => { click(view.container.querySelector('[data-testid="ask"]')); await tick(); });
  const dialog = document.querySelector('[role="dialog"]')!;
  assertNoDomNode(dialog.querySelector(".modal-tone-icon"));
  assert.equal(dialog.querySelector(".modal-foot .btn.primary")?.textContent, "Recover Session");
  await view.unmount();
});

test("a confirmation without a confirm label never opens and resolves as cancelled", async () => {
  matchingMedia = new Set();
  let answer: boolean | undefined;
  function Ask() {
    const { confirm } = useFeedback();
    const unlabeled = { title: "Stop Session", message: "Stops now." };
    return <button data-testid="ask" onClick={() => {
      // @ts-expect-error confirmLabel is required: every confirmation names its outcome.
      void confirm(unlabeled).then((value) => { answer = value; });
    }}>Ask</button>;
  }
  const view = await mount(<FeedbackProvider><Ask /></FeedbackProvider>);
  await act(async () => { click(view.container.querySelector('[data-testid="ask"]')); await tick(); });
  assert.equal(answer, false);
  assertNoDomNode(document.querySelector('[role="dialog"]'));
  await view.unmount();
});

test("crossing the phone breakpoint re-hosts open dialogs without losing their values", async () => {
  matchingMedia = new Set([PHONE]);
  function Parent() {
    const [child, setChild] = useState(false);
    return (
      <>
        <Modal title="Manage Platform" onClose={() => undefined}>
          <input aria-label="Members" />
          <button type="button" data-testid="open-child" onClick={() => setChild(true)}>Rename Team…</button>
        </Modal>
        {child && (
          <Modal title="Rename Team" onClose={() => setChild(false)}>
            <input aria-label="Team Name" />
          </Modal>
        )}
      </>
    );
  }
  const resize = async () => {
    await act(async () => {
      domWindow.dispatchEvent(new domWindow.Event("resize"));
      await tick();
    });
  };
  const view = await mount(<Parent />);
  document.querySelector<HTMLInputElement>('input[aria-label="Members"]')!.value = "Ada, Grace";
  await act(async () => { click(document.querySelector('[data-testid="open-child"]')); await tick(); });
  document.querySelector<HTMLInputElement>('input[aria-label="Team Name"]')!.value = "Platform Core";
  assert.equal(document.querySelectorAll(".modal").length, 1, "one sheet on a phone");

  matchingMedia = new Set();
  await resize();
  const [parent, child] = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')];
  assert.equal(document.querySelectorAll(".modal").length, 2, "desktop stacks the child on its parent");
  assert.notEqual(child?.closest(".modal"), parent?.closest(".modal"));
  assert.equal(parent?.hasAttribute("hidden"), false, "the parent is visible under the child");
  assertNoDomNode(child?.querySelector(".modal-back"), "a stacked desktop child has a close button, not Back");
  assert.equal(document.querySelector<HTMLInputElement>('input[aria-label="Team Name"]')?.value, "Platform Core");

  matchingMedia = new Set([PHONE]);
  await resize();
  assert.equal(document.querySelectorAll(".modal").length, 1, "back on a phone there is one sheet again");
  assert.equal(parent?.hasAttribute("hidden"), true);
  assert.equal(child?.querySelector(".modal-back")?.getAttribute("aria-label"), "Back to Manage Platform");
  assert.equal(document.querySelector<HTMLInputElement>('input[aria-label="Team Name"]')?.value, "Platform Core");
  assert.equal(document.querySelector<HTMLInputElement>('input[aria-label="Members"]')?.value, "Ada, Grace");
  await view.unmount();
});

test("when the dialog that owns a phone sheet closes, the one above it takes the sheet over", async () => {
  matchingMedia = new Set([PHONE]);
  let closeParent: (() => void) | undefined;
  function Pair() {
    const [parentOpen, setParentOpen] = useState(true);
    closeParent = () => setParentOpen(false);
    return (
      <>
        {parentOpen && <Modal title="Manage Platform" onClose={() => undefined}>Parent</Modal>}
        <Modal title="Rename Team" onClose={() => undefined}><input aria-label="Team Name" /></Modal>
      </>
    );
  }
  const view = await mount(<Pair />);
  document.querySelector<HTMLInputElement>('input[aria-label="Team Name"]')!.value = "Platform Core";
  await act(async () => { closeParent!(); await tick(); });
  assert.equal(document.querySelectorAll(".modal").length, 1);
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  assert.equal(dialog?.querySelector("h2")?.textContent, "Rename Team");
  assert.equal(dialog?.hasAttribute("hidden"), false);
  assert.equal(dialog?.closest(".modal")?.parentElement?.parentElement, document.body);
  assert.equal(document.querySelector<HTMLInputElement>('input[aria-label="Team Name"]')?.value, "Platform Core");
  await view.unmount();
});

test("a focused tertiary action keeps focus when the breakpoint moves it between footer and body", async () => {
  matchingMedia = new Set();
  const view = await mount(
    <Modal title="Edit Reminder" onClose={() => undefined} tertiary={<button type="button" className="btn ghost">Remove Reminder</button>}
      footer={<><button className="btn">Cancel</button><button className="btn primary">Update Reminder</button></>}>
      Body
    </Modal>,
  );
  const remove = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Remove Reminder")!;
  remove.focus();
  assert.ok(remove.closest(".modal-foot"));
  matchingMedia = new Set([PHONE]);
  await act(async () => { domWindow.dispatchEvent(new domWindow.Event("resize")); await tick(); });
  assert.ok(remove.isConnected, "the same button moved, not a new one");
  assert.ok(remove.closest(".modal-body"), "a phone sheet shows it at the end of the body");
  assert.equal(document.activeElement, remove);
  matchingMedia = new Set();
  await act(async () => { domWindow.dispatchEvent(new domWindow.Event("resize")); await tick(); });
  assert.ok(remove.closest(".modal-foot"));
  assert.equal(document.activeElement, remove);
  await view.unmount();
});

test("closing the dialog that owns a phone sheet keeps focus in the dialog that takes it over", async () => {
  matchingMedia = new Set([PHONE]);
  let closeParent: (() => void) | undefined;
  function Pair() {
    const [parentOpen, setParentOpen] = useState(true);
    closeParent = () => setParentOpen(false);
    return (
      <>
        {parentOpen && <Modal title="Manage Platform" onClose={() => undefined}>Parent</Modal>}
        <Modal title="Rename Team" onClose={() => undefined}><input aria-label="Team Name" /></Modal>
      </>
    );
  }
  const view = await mount(<Pair />);
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Team Name"]')!;
  input.focus();
  assert.equal(document.activeElement, input);
  await act(async () => { closeParent!(); await tick(); });
  await act(async () => { await tick(); });
  assert.equal(document.activeElement, input);
  await view.unmount();
});
