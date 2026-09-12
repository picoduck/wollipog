import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentModel } from "@wollipog/protocol";
import { resolveContextWindowCapacity } from "./context-window-capacity.js";

const models: AgentModel[] = [
  { id: "default", default: true, contextWindow: 100_000 },
  { id: "selected", contextWindow: 200_000 },
];

test("served context-window capacity takes precedence over the selected catalog model", () => {
  assert.deepEqual(resolveContextWindowCapacity({ model: "selected", contextWindow: 150_000 }, models), {
    known: true,
    capacity: 150_000,
    source: "served",
    served: 150_000,
    advertised: 200_000,
  });
});

test("the selected catalog model supplies capacity before a served value arrives", () => {
  assert.deepEqual(resolveContextWindowCapacity({ model: "selected", contextWindow: undefined }, models), {
    known: true,
    capacity: 200_000,
    source: "catalog",
    served: null,
    advertised: 200_000,
  });
});

test("the default catalog model remains the fallback when the selection is unavailable", () => {
  assert.deepEqual(resolveContextWindowCapacity({ model: "missing", contextWindow: undefined }, models), {
    known: true,
    capacity: 100_000,
    source: "catalog",
    served: null,
    advertised: null,
  });
});

test("capacity stays unknown without a positive served or catalog value", () => {
  assert.deepEqual(resolveContextWindowCapacity({ model: "unknown", contextWindow: 0 }, [
    { id: "unknown" },
  ]), {
    known: false,
    capacity: null,
    source: null,
    served: null,
    advertised: null,
  });
});
