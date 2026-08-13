import assert from "node:assert/strict";
import test from "node:test";
import {
  CANONICAL_CONTAINER_LABELS,
  CONTAINER_LABEL_GENERATIONS,
  LEGACY_CONTAINER_LABELS,
  containerLabelArgs,
} from "./container-identity.js";

test("container label generations keep exact canonical and rollback identities", () => {
  assert.deepEqual(CANONICAL_CONTAINER_LABELS, {
    runner: "com.wollipog.runner",
    template: "com.wollipog.template",
  });
  assert.deepEqual(LEGACY_CONTAINER_LABELS, {
    runner: "com.misko-agent-manager.runner",
    template: "com.misko-agent-manager.template",
  });
  assert.deepEqual(CONTAINER_LABEL_GENERATIONS, [
    CANONICAL_CONTAINER_LABELS,
    LEGACY_CONTAINER_LABELS,
  ]);
});

test("container label argv emits canonical and rollback identities with identical values", () => {
  assert.deepEqual(containerLabelArgs("runnerkey", "offline-tools"), [
    "--label", "com.wollipog.runner=runnerkey",
    "--label", "com.wollipog.template=offline-tools",
    "--label", "com.misko-agent-manager.runner=runnerkey",
    "--label", "com.misko-agent-manager.template=offline-tools",
  ]);
});
