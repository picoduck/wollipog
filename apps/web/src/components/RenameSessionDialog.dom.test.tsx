import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { RenameSessionDialog } from "./RenameSessionDialog.js";
import { assertNoDomNode } from "../dom-test-assertions.js";

const domWindow = new Window({ url: "http://localhost/session/session-rename" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
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

/** Dialogs are portalled to <body>. */
function page(): HTMLElement {
  return domWindow.document.body as unknown as HTMLElement;
}

function field(): HTMLInputElement {
  const input = page().querySelector<HTMLInputElement>("#rename-session-title");
  assert.ok(input, "the Session Name field is rendered");
  return input;
}

function primary(): HTMLButtonElement {
  const button = page().querySelector<HTMLButtonElement>('.modal-foot button[type="submit"]');
  assert.ok(button, "the primary is rendered");
  return button;
}

/** The text of every element the field's aria-describedby names. */
function description(input: HTMLInputElement): string {
  return (input.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean)
    .map((id) => domWindow.document.getElementById(id)?.textContent ?? "").join(" ");
}

async function type(value: string) {
  await act(async () => {
    field().value = value;
    fireDomEvent.change(field());
  });
}

async function renderDialog(title: string, renameSession: ApiClient["renameSession"]) {
  const closes: number[] = [];
  const renamed: SessionView[] = [];
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  const root = createRoot(mountPoint);
  await act(async () => {
    root.render(
      <ApiProvider client={{ ...api, renameSession } as ApiClient}>
        <RenameSessionDialog
          session={{ id: "session-rename", title }}
          onClose={() => closes.push(1)}
          onRenamed={(updated) => renamed.push(updated)}
        />
      </ApiProvider>,
    );
    await tick();
  });
  return {
    closes,
    renamed,
    async unmount() {
      await act(async () => root.unmount());
      mountPoint.remove();
    },
  };
}

test("an empty name marks the field invalid with the shared field error in place of the helper", async () => {
  const requests: Array<[string, string]> = [];
  const dialog = await renderDialog("Fix the rounding bug", async (id, title) => {
    requests.push([id, title]);
    return { id, title } as SessionView;
  });
  const helper = "Shown in the session list and at the top of this page.";
  assert.equal(page().querySelector("label[for='rename-session-title']")?.textContent, "Session Name");
  assert.equal(field().getAttribute("aria-invalid"), null);
  assert.equal(description(field()), helper);
  assert.equal(page().querySelector<HTMLFormElement>("#rename-session-form")?.noValidate, true);
  assert.equal(primary().textContent, "Rename Session");

  await type("   ");
  await act(async () => { primary().click(); await tick(); });
  assert.deepEqual(requests, [], "an invalid name is not sent");
  assert.equal(field().getAttribute("aria-invalid"), "true");
  const error = page().querySelector(".field-error");
  assert.ok(error, "the error is the shared FieldError");
  assert.equal(error.textContent, "Enter a session name.");
  assert.equal(description(field()), "Enter a session name.", "the error is the field's accessible description");
  assert.doesNotMatch(page().textContent ?? "", new RegExp(helper.replace(/\./g, "\\.")), "the error replaces the helper");
  assertNoDomNode(page().querySelector(".form-error"), "no local form error");
  assert.equal(primary().disabled, false, "the primary stays enabled");
  assert.equal(domWindow.document.activeElement, field() as unknown, "focus moves to the invalid field");

  await type("  Fix   the half-cent bug ");
  assert.equal(field().getAttribute("aria-invalid"), null, "a valid value clears the error as it is typed");
  assert.equal(description(field()), helper);
  await act(async () => { primary().click(); await tick(); });
  assert.deepEqual(requests, [["session-rename", "Fix the half-cent bug"]], "whitespace still collapses");
  assert.deepEqual(dialog.closes, [1]);
  assert.equal(dialog.renamed.length, 1);
  await dialog.unmount();
});

test("a name over 120 characters is invalid on the field", async () => {
  const dialog = await renderDialog("x".repeat(130), async () => { throw new Error("must not be sent"); });
  await act(async () => { primary().click(); await tick(); });
  assert.equal(field().getAttribute("aria-invalid"), "true");
  assert.equal(page().querySelector(".field-error")?.textContent, "Session names must be 120 characters or fewer.");
  await dialog.unmount();
});

test("a multi-line title opens as its first line, focused with the caret at the start", async () => {
  const dialog = await renderDialog("header.Requirements:-\n\n- keep the totals\n- add tests", async () => {
    throw new Error("not submitted");
  });
  assert.equal(field().value, "header.Requirements:-");
  assert.equal(domWindow.document.activeElement, field() as unknown);
  assert.equal(field().selectionStart, 0);
  assert.equal(field().selectionEnd, 0);
  await dialog.unmount();
});

test("saving keeps the primary's label, and a failed request is a danger notice", async () => {
  let reject: (cause: Error) => void = () => undefined;
  const dialog = await renderDialog("Fix the rounding bug", () => new Promise((_resolve, fail) => { reject = fail; }));
  await act(async () => { primary().click(); await tick(); });
  assert.equal(primary().textContent?.trim(), "Rename Session", "the label stays while saving");
  assert.equal(primary().getAttribute("aria-busy"), "true");
  assert.match(page().textContent ?? "", /Renaming the session…/);
  assert.equal(field().readOnly, true);
  assert.equal(field().disabled, false, "the field keeps focus while saving");

  await act(async () => { reject(new Error("That name is already taken.")); await tick(); });
  const notice = page().querySelector('[role="alert"]');
  assert.ok(notice, "the failure is announced");
  assert.match(notice.textContent ?? "", /Couldn't Rename the Session/);
  assert.match(notice.textContent ?? "", /That name is already taken\./);
  assert.equal(field().getAttribute("aria-invalid"), null, "a request failure is not a field error");
  assertNoDomNode(page().querySelector(".form-error"));
  assert.deepEqual(dialog.closes, [], "the dialog stays open to try again");
  assert.equal(field().readOnly, false);
  await dialog.unmount();
});
