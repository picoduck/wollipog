import assert from "node:assert/strict";
import test from "node:test";
import { activeInstanceConnection, instanceMonogram, instancePublicOrigin } from "./instances-context.js";

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

test("the monogram is the first letter of each of the label's first two words", () => {
  assert.equal(instanceMonogram("This Machine"), "TM");
  assert.equal(instanceMonogram("Studio"), "S");
  assert.equal(instanceMonogram("  home   studio mac "), "HS");
  assert.equal(instanceMonogram("Build Box 2"), "BB");
  assert.equal(instanceMonogram("(prod) east"), "PE", "punctuation is not an initial");
  assert.equal(instanceMonogram("· Laptop"), "L", "a word with no letter or digit is skipped");
  assert.equal(instanceMonogram("Élan vital"), "ÉV");
  assert.equal(instanceMonogram("··"), "·", "a label with no initials still draws something");
});

test("the tile's connection state follows the banner and is never live while one shows", () => {
  const state = (conn: "connecting" | "online" | "offline" | "unauthorized", authRequired = false, connectionLost = false) =>
    activeInstanceConnection({ conn, authRequired, connectionLost });
  assert.equal(state("online"), null);
  assert.equal(state("online", true, true), null, "back online clears both banners");
  assert.equal(state("connecting"), null, "a first connection is not a lost one");
  assert.equal(state("offline"), "reconnecting", "hollow from the first offline, before the banner's 2s hold");
  assert.equal(state("connecting", false, true), "reconnecting", "a retry after a loss is still reconnecting");
  assert.equal(state("unauthorized", true), "sign-in-required");
  assert.equal(state("offline", true, true), "sign-in-required", "the pairing banner outranks the offline one");
});
