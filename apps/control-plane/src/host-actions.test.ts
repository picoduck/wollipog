import assert from "node:assert/strict";
import { test } from "node:test";
import { editorAdvertisesLocation, parseSessionHostAction } from "./host-actions.js";

test("session host actions preserve the legacy root kinds and isolate location requests", () => {
  assert.deepEqual(parseSessionHostAction({ kind: "reveal" }), {
    action: { kind: "reveal" }, capability: "hostActions",
  });
  assert.deepEqual(parseSessionHostAction({ kind: "open_editor", editorId: "code" }), {
    action: { kind: "open_editor", editorId: "code" }, capability: "hostActions",
  });
  assert.deepEqual(parseSessionHostAction({
    kind: "open_editor_location",
    editorId: "code",
    location: { path: "src\\App.tsx", line: 42, column: 3 },
  }), {
    action: {
      kind: "open_editor_location",
      editorId: "code",
      location: { path: "src/App.tsx", line: 42, column: 3 },
    },
    capability: "editorLocations",
  });
});

test("session host action parsing rejects unknown fields, traversal, symbols, and malformed ids", () => {
  for (const value of [
    null,
    { kind: "reveal", editorId: "code" },
    { kind: "open_editor", editorId: "code", location: { path: "a" } },
    { kind: "open_editor_location", editorId: "code", location: { path: "../secret" } },
    { kind: "open_editor_location", editorId: "code", location: { path: "a", symbol: "run" } },
    { kind: "open_editor_location", editorId: "bad id", location: { path: "a" } },
    { kind: "open_editor_location", editorId: "code", location: { path: "a" }, extra: true },
    Object.create({ kind: "open_editor", editorId: "code" }),
  ]) assert.equal(parseSessionHostAction(value), null);
});

test("advertised editor precision gates file, line, and column requests", () => {
  const editor = { id: "code", name: "VS Code", locations: { native: "line" as const } };
  assert.equal(editorAdvertisesLocation(editor, {
    kind: "open_editor_location", editorId: "code", location: { path: "a.ts" },
  }), true);
  assert.equal(editorAdvertisesLocation(editor, {
    kind: "open_editor_location", editorId: "code", location: { path: "a.ts", line: 2 },
  }), true);
  assert.equal(editorAdvertisesLocation(editor, {
    kind: "open_editor_location", editorId: "code", location: { path: "a.ts", line: 2, column: 3 },
  }), false);
  assert.equal(editorAdvertisesLocation({ id: "windsurf", name: "Windsurf" }, {
    kind: "open_editor_location", editorId: "windsurf", location: { path: "a.ts" },
  }), false);
});
