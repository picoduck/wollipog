import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EXIT_RISK_REQUEST_DOMAIN,
  EXIT_RISK_RESPONSE_DOMAIN,
  MANAGED_DESKTOP_LAUNCH_ID_ENV,
  MANAGED_DESKTOP_SECRET_ENV,
  decodeCanonicalBase64url,
  managedDesktopMac,
  takeManagedDesktopIdentity,
  verifyManagedDesktopRequest,
} from "./managed-desktop-auth.js";

const SECRET = ["AAECAwQFBgcICQoLDA0OD", "xAREhMUFRYXGBkaGxwdHh8"].join("");
const CHALLENGE = "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8";
const RUNNER = "this-machine-2f5a7c9d";
const BODY = '{"sessions":[{"runnerId":"this-machine-2f5a7c9d","status":"running","pendingApproval":null}]}';

test("the Rust/TypeScript mutual-HMAC vector stays byte-for-byte pinned", () => {
  const identity = {
    launchId: "0123456789abcdef0123456789abcdef",
    secret: Buffer.from(SECRET, "base64url"),
  };
  const challenge = Buffer.from(CHALLENGE, "base64url");
  assert.equal(
    managedDesktopMac(identity, EXIT_RISK_REQUEST_DOMAIN, challenge, RUNNER),
    "eZH-Q-EUQPBAADeiSSBcN_iwVW4oFN2or6WI71dljJc",
  );
  assert.equal(
    managedDesktopMac(identity, EXIT_RISK_RESPONSE_DOMAIN, challenge, BODY),
    "9l9hl855e9kP7gkTUr6mXS2p8IkGloqLOQftwXQQjlw",
  );
});

test("launch environment is deleted before validation or descendant startup", () => {
  const valid: NodeJS.ProcessEnv = {
    [MANAGED_DESKTOP_LAUNCH_ID_ENV]: "0123456789abcdef0123456789abcdef",
    [MANAGED_DESKTOP_SECRET_ENV]: SECRET,
  };
  assert.ok(takeManagedDesktopIdentity(valid));
  assert.equal(valid[MANAGED_DESKTOP_LAUNCH_ID_ENV], undefined);
  assert.equal(valid[MANAGED_DESKTOP_SECRET_ENV], undefined);

  const invalid: NodeJS.ProcessEnv = {
    [MANAGED_DESKTOP_LAUNCH_ID_ENV]: "bad",
    [MANAGED_DESKTOP_SECRET_ENV]: "also-bad",
  };
  assert.equal(takeManagedDesktopIdentity(invalid), null);
  assert.deepEqual(invalid, {});
});

test("proofs reject missing, wrong, noncanonical, changed, and previous-launch values", () => {
  const identity = {
    launchId: "0123456789abcdef0123456789abcdef",
    secret: Buffer.from(SECRET, "base64url"),
  };
  const mac = managedDesktopMac(identity, EXIT_RISK_REQUEST_DOMAIN, Buffer.from(CHALLENGE, "base64url"), RUNNER);
  const base = { identity, domain: EXIT_RISK_REQUEST_DOMAIN, launchId: identity.launchId, challenge: CHALLENGE, mac, runnerId: RUNNER };
  assert.ok(verifyManagedDesktopRequest(base));
  assert.equal(verifyManagedDesktopRequest({ ...base, mac: undefined }), null);
  assert.equal(verifyManagedDesktopRequest({ ...base, mac: `${mac.slice(0, -1)}A` }), null);
  assert.equal(verifyManagedDesktopRequest({ ...base, challenge: `${CHALLENGE}=` }), null);
  assert.equal(verifyManagedDesktopRequest({ ...base, runnerId: `${RUNNER}-changed` }), null);
  assert.equal(verifyManagedDesktopRequest({ ...base, launchId: "f".repeat(32) }), null);
  assert.equal(verifyManagedDesktopRequest({
    ...base,
    identity: { ...identity, secret: Buffer.alloc(32, 9) },
  }), null);
  assert.equal(decodeCanonicalBase64url("AA==", 1), null);
});
