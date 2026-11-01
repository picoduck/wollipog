import assert from "node:assert/strict";
import { test } from "node:test";
import type { PairingBlocker } from "../device-token.js";
import * as copy from "./pair-device-copy.js";

const REASONS: readonly PairingBlocker[] = ["loopback", "not-web-served", "remote-access", "no-address"];

/** Outside Show Details every string Pair Device shows is the person's words: it starts with a
 * capital and never names the mechanism (#2999). */
function assertPlain(text: string, where: string) {
  assert.match(text, /^[A-Z0-9]/u, `${where} starts with a capital: ${text}`);
  assert.doesNotMatch(text, /control plane/iu, `${where} names no mechanism: ${text}`);
  assert.doesNotMatch(text, /CONTROL_PLANE_|pnpm|loopback/u, `${where} keeps operator detail behind Show Details: ${text}`);
}

test("each reason no other device can reach this computer is a titled notice in plain words", () => {
  for (const reason of REASONS) {
    const notice = copy.pairingBlockedCopy(reason, "secure remote access needs attention");
    assertPlain(notice.title, `${reason} title`);
    assertPlain(notice.sentence, `${reason} sentence`);
    assert.match(notice.sentence, /\.$/u, `${reason} sentence ends as a sentence`);
  }
  assert.deepEqual(
    Object.fromEntries(REASONS.map((reason) => [reason, copy.pairingBlockedCopy(reason).title])),
    {
      loopback: "Other Devices Can't Reach This Computer Yet",
      "not-web-served": "This Computer Isn't Serving Wollipog's Pages",
      "remote-access": "Remote Access Needs Attention",
      "no-address": "No Network Address Found",
    },
  );
  assert.equal(copy.pairingBlockedCopy("loopback").networkSettings, true);
  assert.equal(copy.pairingBlockedCopy("no-address").details, undefined);
});

test("the operator detail lives only behind Show Details", () => {
  assert.match(copy.pairingBlockedCopy("loopback").details?.sentence ?? "", /CONTROL_PLANE_PUBLIC_ORIGIN.*CONTROL_PLANE_HOST/u);
  assert.equal(copy.pairingBlockedCopy("not-web-served").details?.command, "pnpm --filter @wollipog/web build");
  assert.equal(copy.pairingBlockedCopy("remote-access", "tailscale serve is not running").details?.sentence, "tailscale serve is not running");
  assert.equal(copy.pairingBlockedCopy("remote-access").details, undefined);
});

test("every fixed sentence in the dialog is in plain words", () => {
  for (const [name, value] of Object.entries(copy)) {
    if (typeof value === "string") assertPlain(value, name);
  }
});
