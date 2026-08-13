import assert from "node:assert/strict";
import test from "node:test";
import { instancePublicOrigin } from "./instances-context.js";

test("public links use the browser dashboard origin for This Machine", () => {
  const manager = {
    activeProfile: {
      id: "local",
      serverInstanceId: "local",
      kind: "local" as const,
      label: "This Machine",
      origin: "http://127.0.0.1:4317",
      createdAt: "",
    },
  };
  assert.equal(instancePublicOrigin(manager, "https://wollipog.tail.example"), "https://wollipog.tail.example");
  assert.equal(instancePublicOrigin(manager, null), null);
});

test("public links use the saved remote origin independently of the current page", () => {
  const manager = {
    activeProfile: {
      id: "remote-a",
      serverInstanceId: "server-a",
      kind: "remote" as const,
      label: "Remote A",
      origin: "https://remote-a.tail.example",
      createdAt: "2026-07-21T00:00:00Z",
    },
  };
  assert.equal(instancePublicOrigin(manager, "https://local.tail.example"), "https://remote-a.tail.example");
});
