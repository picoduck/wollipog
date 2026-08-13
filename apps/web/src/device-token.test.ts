import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deviceToken,
  pairingLinks,
  parsePairingFragment,
  parsePairingInput,
  storeDeviceToken,
} from "./device-token.js";

// What the control plane actually mints: 32 bytes base64url = 43 chars (auth.ts newDeviceToken).
const TOKEN = "k".repeat(20) + "-DEF_" + "x".repeat(18);

test("device tokens copy forward new-first and rotations write only the current name", () => {
  const values = new Map<string, string>([["mam.deviceToken", TOKEN]]);
  const original = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    },
  });
  try {
    assert.equal(deviceToken(), TOKEN);
    assert.equal(values.get("wollipog.deviceToken"), TOKEN);
    values.set("mam.deviceToken", "l".repeat(43));
    assert.equal(deviceToken(), TOKEN, "the current token wins a conflicting legacy value");

    const rotated = "r".repeat(43);
    storeDeviceToken(rotated);
    assert.equal(values.get("wollipog.deviceToken"), rotated);
    assert.equal(values.get("mam.deviceToken"), "l".repeat(43), "legacy compatibility input is read-only");
  } finally {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: original });
  }
});

test("parsePairingFragment accepts only a clean, token-length base64url pair fragment", () => {
  assert.equal(parsePairingFragment(`#pair=${TOKEN}`), TOKEN);
  assert.equal(parsePairingFragment(""), null);
  assert.equal(parsePairingFragment("#other=x"), null);
  assert.equal(parsePairingFragment("#pair="), null);
  // No smuggling extra fragment content past the token.
  assert.equal(parsePairingFragment(`#pair=${TOKEN}&x=1`), null);
  assert.equal(parsePairingFragment(`#pair=${TOKEN}#extra`), null);
  // Length-bounded: too short to be a real token, and absurdly long (an overlong token would
  // persist, blow the WS upgrade URL past header limits, and wedge as a 1006 loop).
  assert.equal(parsePairingFragment("#pair=short"), null);
  assert.equal(parsePairingFragment(`#pair=${"a".repeat(300)}`), null);
});

test("parsePairingInput accepts a bare token, a fragment, or a whole pairing link", () => {
  assert.equal(parsePairingInput(TOKEN), TOKEN);
  assert.equal(parsePairingInput(`  ${TOKEN}  `), TOKEN);
  assert.equal(parsePairingInput(`#pair=${TOKEN}`), TOKEN);
  assert.equal(parsePairingInput(`http://192.168.1.9:4317/#pair=${TOKEN}`), TOKEN);
  assert.equal(parsePairingInput(""), null);
  assert.equal(parsePairingInput("http://192.168.1.9:4317/"), null);
  // Trailing junk after the token is not a token.
  assert.equal(parsePairingInput(`#pair=${TOKEN}&x=1`), null);
  // Length bounds (same rationale as the fragment).
  assert.equal(parsePairingInput("short"), null);
  assert.equal(parsePairingInput("a".repeat(300)), null);
  assert.equal(parsePairingInput(`http://x/#pair=${"a".repeat(300)}`), null);
  assert.equal(parsePairingInput("z".repeat(5000)), null);
});

test("pairingLinks: one link per reachable host when the CP can actually serve + be reached", () => {
  const { links, blocked } = pairingLinks("TOK", {
    hosts: ["192.168.1.9", "100.64.0.2"],
    port: 4317,
    webServed: true,
    boundBeyondLoopback: true,
  });
  assert.equal(blocked, null);
  assert.deepEqual(links, ["http://192.168.1.9:4317/#pair=TOK", "http://100.64.0.2:4317/#pair=TOK"]);
});

test("pairingLinks: brackets an IPv6 host so the URL stays valid", () => {
  const { links } = pairingLinks("TOK", {
    hosts: ["fd00::1", "[fd00::2]"],
    port: 4317,
    webServed: true,
    boundBeyondLoopback: true,
  });
  assert.deepEqual(links, ["http://[fd00::1]:4317/#pair=TOK", "http://[fd00::2]:4317/#pair=TOK"]);
});

test("pairingLinks: never offers a dead link — each blocker names its fix", () => {
  const base = { hosts: ["10.0.0.1"], port: 4317, webServed: true, boundBeyondLoopback: true };
  // No bundle → the link would 404.
  const noWeb = pairingLinks("T", { ...base, webServed: false });
  assert.deepEqual(noWeb.links, []);
  assert.match(noWeb.blocked!, /web build/);
  // Loopback bind → the phone can't reach it.
  const loopback = pairingLinks("T", { ...base, boundBeyondLoopback: false });
  assert.deepEqual(loopback.links, []);
  assert.match(loopback.blocked!, /CONTROL_PLANE_HOST/);
  // Nothing routable to advertise.
  const noHosts = pairingLinks("T", { ...base, hosts: [] });
  assert.deepEqual(noHosts.links, []);
  assert.match(noHosts.blocked!, /network address/);
});
