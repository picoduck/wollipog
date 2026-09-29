import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { WorktreeSetupNotice } from "./WorktreeSetupNotice.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow, document: domWindow.document, navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement, Node: domWindow.Node, React, IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

test("setup notice uses Title Case actions, an external help link, and no nested controls", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<WorktreeSetupNotice onGenerate={() => {}} onDismiss={() => {}} />));
    assert.equal(container.querySelector("aside")?.getAttribute("aria-label"), "Set Up This Project");
    assert.deepEqual([...container.querySelectorAll("button")].map((button) => button.textContent || button.getAttribute("aria-label")),
      // The dismiss button sits in the title row (§13.2), ahead of the body and its actions.
      ["Dismiss Setup Notice", "Generate"]);
    assert.equal(container.querySelector("a")?.textContent, "Learn More");
    assertNoDomNode(container.querySelector("button button, button a, a button"));
    assert.match(container.textContent ?? "", /Nothing runs, stages, or commits/u);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

const VIEWER = "Your Viewer role is read-only.";

function describedBy(control: Element): string[] {
  const ids = control.getAttribute("aria-describedby")?.split(/\s+/u).filter(Boolean) ?? [];
  return ids.map((id) => domWindow.document.getElementById(id)?.textContent ?? `<missing ${id}>`);
}

async function renderNotice(props: Partial<React.ComponentProps<typeof WorktreeSetupNotice>> = {}) {
  const calls: string[] = [];
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(
    <WorktreeSetupNotice onGenerate={() => calls.push("generate")} onDismiss={() => calls.push("dismiss")} {...props} />,
  ));
  const button = (label: string) => {
    const match = [...container.querySelectorAll("button")]
      .find((candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent) === label);
    assert.ok(match, `missing ${label}`);
    return match as HTMLButtonElement;
  };
  return {
    calls, container, button,
    unmount: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}

test("a refused Generate is disabled, states the reason, and sends nothing, while Dismiss still works (#1864)", async () => {
  const notice = await renderNotice({ generateRefusal: VIEWER });
  try {
    const generate = notice.button("Generate");
    assert.equal(generate.disabled, true);
    assert.equal(generate.getAttribute("title"), VIEWER);
    assert.deepEqual(describedBy(generate), [VIEWER]);
    const reason = domWindow.document.getElementById(generate.getAttribute("aria-describedby")!);
    assert.ok(reason && notice.container.contains(reason as never), "the reason is rendered inside the notice");
    await act(async () => generate.click());
    assert.deepEqual(notice.calls, []);

    const dismiss = notice.button("Dismiss Setup Notice");
    assert.equal(dismiss.disabled, false, "dismissing hides the notice for this person only, so it stays available");
    await act(async () => dismiss.click());
    assert.deepEqual(notice.calls, ["dismiss"]);
  } finally {
    await notice.unmount();
  }
});

test("without a refusal Generate is enabled with no description, as before (#1864)", async () => {
  for (const props of [{}, { generateRefusal: null }]) {
    const notice = await renderNotice(props);
    try {
      const generate = notice.button("Generate");
      assert.equal(generate.disabled, false);
      assert.equal(generate.getAttribute("title"), null);
      assert.equal(generate.getAttribute("aria-describedby"), null);
      assert.doesNotMatch(notice.container.textContent ?? "", /Viewer role/u);
      await act(async () => generate.click());
      assert.deepEqual(notice.calls, ["generate"]);
    } finally {
      await notice.unmount();
    }
  }
});
