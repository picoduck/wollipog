import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { TranscriptTailControl, type TranscriptTailView } from "./TranscriptTailControl.js";

const domWindow = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  Element: domWindow.Element,
  Node: domWindow.Node,
  Event: domWindow.Event,
  FocusEvent: domWindow.FocusEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

function mount() {
  const reader = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  const elsewhere = domWindow.document.createElement("button") as unknown as HTMLButtonElement;
  domWindow.document.body.append(reader as never, container as never, elsewhere as never);
  // What the reader would be asked to scroll, and what input its own listeners saw.
  const scrolled: number[] = [];
  const readerEvents: string[] = [];
  reader.scrollBy = ((options: ScrollToOptions) => { scrolled.push(options.top ?? 0); }) as typeof reader.scrollBy;
  for (const type of ["wheel", "pointerdown", "pointermove", "pointerup", "pointercancel"]) {
    reader.addEventListener(type, (event) => {
      const detail = type === "wheel"
        ? `${(event as WheelEvent).deltaY}`
        : `${(event as PointerEvent).pointerType}@${(event as PointerEvent).clientY}`;
      readerEvents.push(`${type}:${detail}`);
    });
  }
  const readerRef = { current: reader };
  const root = createRoot(container);
  let lost = 0;
  let jumps = 0;
  const render = (view: TranscriptTailView) => act(async () => root.render(
    <TranscriptTailControl
      view={view}
      shortcut="End"
      readerRef={readerRef}
      onJump={() => { jumps += 1; }}
      onShowNotSent={() => {}}
      onFocusLost={() => { lost += 1; }}
    />,
  ));
  return {
    reader,
    container,
    elsewhere,
    render,
    scrolled,
    readerEvents,
    lost: () => lost,
    jumps: () => jumps,
    async unmount() {
      await act(async () => root.unmount());
      reader.remove();
      container.remove();
      elsewhere.remove();
    },
  };
}

function touch(target: Element, type: string, clientY: number, buttons = 1): boolean {
  return target.dispatchEvent(new domWindow.PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 7,
    pointerType: "touch",
    isPrimary: true,
    clientY,
    buttons,
  }) as unknown as Event);
}

test("a wheel over the control reaches the reader and scrolls it by the wheel's distance (#2425)", async () => {
  const fixture = mount();
  try {
    for (const view of [{ kind: "jump", newRows: 0 }, { kind: "recovering" }, { kind: "not-sent", count: 1 }] as const) {
      await fixture.render(view);
      fixture.scrolled.length = 0;
      fixture.readerEvents.length = 0;
      const control = fixture.container.querySelector(".transcript-tail-control")!;
      const wheel = new domWindow.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -120 });
      control.dispatchEvent(wheel as unknown as Event);
      assert.equal(wheel.defaultPrevented, true, `${view.kind}: nothing behind the control scrolls as well`);
      assert.deepEqual(fixture.readerEvents, ["wheel:-120"], `${view.kind}: the reader's own wheel listeners run`);
      assert.deepEqual(fixture.scrolled, [-120], view.kind);
    }

    fixture.scrolled.length = 0;
    const control = fixture.container.querySelector(".transcript-tail-control")!;
    control.dispatchEvent(new domWindow.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 3, deltaMode: 1 }) as unknown as Event);
    assert.deepEqual(fixture.scrolled, [120], "a wheel counted in lines scrolls by lines");

    fixture.scrolled.length = 0;
    fixture.readerEvents.length = 0;
    const zoom = new domWindow.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -120 });
    // happy-dom's WheelEvent drops the modifier keys from its init.
    Object.defineProperty(zoom, "ctrlKey", { value: true });
    control.dispatchEvent(zoom as unknown as Event);
    assert.equal(zoom.defaultPrevented, false, "Ctrl+wheel stays the browser's zoom");
    assert.deepEqual(fixture.scrolled, []);
    assert.deepEqual(fixture.readerEvents, []);
  } finally {
    await fixture.unmount();
  }
});

test("a touch drag on the control scrolls the reader, and only a tap jumps (#2425)", async () => {
  const fixture = mount();
  try {
    await fixture.render({ kind: "jump", newRows: 0 });
    const jump = fixture.container.querySelector("button")!;

    // A tap: the reader hears the touch, nothing scrolls, and the control jumps.
    touch(jump, "pointerdown", 500);
    touch(jump, "pointermove", 503);
    touch(jump, "pointerup", 503, 0);
    await act(async () => { jump.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }) as unknown as Event); });
    assert.deepEqual(fixture.scrolled, [], "movement inside the tap slop is not a drag");
    assert.deepEqual(fixture.readerEvents, ["pointerdown:touch@500", "pointermove:touch@503", "pointerup:touch@503"]);
    assert.equal(fixture.jumps(), 1);

    // A drag: the finger moving down reads back, so the reader scrolls up by the same distance.
    fixture.readerEvents.length = 0;
    touch(jump, "pointerdown", 500);
    touch(jump, "pointermove", 520);
    touch(jump, "pointermove", 600);
    touch(jump, "pointerup", 600, 0);
    assert.deepEqual(fixture.scrolled, [-20, -80]);
    assert.equal(fixture.readerEvents.length, 4, "the reader hears every step of the drag");
    await act(async () => { jump.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }) as unknown as Event); });
    assert.equal(fixture.jumps(), 1, "a click the browser sends after a drag is not a tap");

    // The keyboard still activates the control straight after a drag.
    await act(async () => { jump.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 }) as unknown as Event); });
    assert.equal(fixture.jumps(), 2);

    // A mouse press is the control's own: the reader never hears it.
    fixture.readerEvents.length = 0;
    jump.dispatchEvent(new domWindow.PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", isPrimary: true, buttons: 1 }) as unknown as Event);
    jump.dispatchEvent(new domWindow.PointerEvent("pointermove", { bubbles: true, pointerType: "mouse", isPrimary: true, buttons: 1, clientY: 40 }) as unknown as Event);
    assert.deepEqual(fixture.readerEvents, []);
  } finally {
    await fixture.unmount();
  }
});

test("focus on the control is handed back when recovery replaces it or the tail takes it away", async () => {
  const fixture = mount();
  try {
    await fixture.render({ kind: "jump", newRows: 0 });
    const jump = fixture.container.querySelector("button")!;
    await act(async () => jump.focus());

    await fixture.render({ kind: "jump", newRows: 3 });
    assert.equal(fixture.lost(), 0, "a relabelled control keeps its focus");
    assert.equal(domWindow.document.activeElement, jump);

    await fixture.render({ kind: "recovering" });
    assert.equal(fixture.lost(), 1, "recovery replacing the focused control hands focus to the reader");

    await fixture.render({ kind: "jump", newRows: 0 });
    await act(async () => fixture.container.querySelector("button")!.focus());
    await fixture.render(null);
    assert.equal(fixture.lost(), 2, "jumping to the tail removes the focused control");
  } finally {
    await fixture.unmount();
  }
});

test("focus the person moved elsewhere is never taken back", async () => {
  const fixture = mount();
  try {
    await fixture.render({ kind: "jump", newRows: 0 });
    await act(async () => fixture.container.querySelector("button")!.focus());
    await act(async () => fixture.elsewhere.focus());
    await fixture.render(null);
    assert.equal(fixture.lost(), 0);
    assert.equal(domWindow.document.activeElement, fixture.elsewhere);

    await fixture.render({ kind: "jump", newRows: 0 });
    await act(async () => fixture.container.querySelector("button")!.focus());
    await act(async () => (domWindow.document.activeElement as unknown as HTMLElement).blur());
    await fixture.render({ kind: "recovering" });
    assert.equal(fixture.lost(), 0, "a click on the page leaves focus on the page");
  } finally {
    await fixture.unmount();
  }
});
