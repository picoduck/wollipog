import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findRemoteInstanceIdentityDuplicate,
  findRemoteInstanceOriginDuplicate,
  normalizeRemoteInstanceOrigin,
  parseRemoteInstanceAdvanced,
  parseRemoteInstancePairingLink,
  type InstancePairingErrorCode,
  type InstancePairingResult,
  type RemoteInstanceReference,
} from "./instance-pairing.js";

const TOKEN = "k".repeat(20) + "-DEF_" + "x".repeat(18);

function expectError<T>(result: InstancePairingResult<T>, code: InstancePairingErrorCode): void {
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, code);
}

test("full pairing links return a canonical token-free endpoint and separate credential", () => {
  assert.deepEqual(parseRemoteInstancePairingLink(`https://EXAMPLE.com:443/#pair=${TOKEN}`), {
    ok: true,
    value: {
      endpoint: { httpOrigin: "https://example.com", wsOrigin: "wss://example.com", transportSecurity: "tls" },
      token: TOKEN,
    },
  });
  const parsed = parseRemoteInstancePairingLink(`https://example.com/#pair=${TOKEN}`);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(JSON.stringify(parsed.value.endpoint).includes(TOKEN), false);
  assert.deepEqual(parseRemoteInstancePairingLink(`https://example.com:8443/index.html#pair=${TOKEN}`), {
    ok: true,
    value: {
      endpoint: { httpOrigin: "https://example.com:8443", wsOrigin: "wss://example.com:8443", transportSecurity: "tls" },
      token: TOKEN,
    },
  });
  assert.deepEqual(parseRemoteInstancePairingLink(`http://100.100.101.102:4317/#pair=${TOKEN}`), {
    ok: true,
    value: {
      endpoint: {
        httpOrigin: "http://100.100.101.102:4317",
        wsOrigin: "ws://100.100.101.102:4317",
        transportSecurity: "tailscale-route-required",
      },
      token: TOKEN,
    },
  });
});

test("advanced origin and token input follows the same canonicalization", () => {
  assert.deepEqual(parseRemoteInstanceAdvanced("https://WOLLIPOG.EXAMPLE.:443/index.html", TOKEN), {
    ok: true,
    value: {
      endpoint: { httpOrigin: "https://wollipog.example", wsOrigin: "wss://wollipog.example", transportSecurity: "tls" },
      token: TOKEN,
    },
  });
  assert.deepEqual(normalizeRemoteInstanceOrigin("http://localhost:4317/"), {
    ok: true,
    value: { httpOrigin: "http://localhost:4317", wsOrigin: "ws://localhost:4317", transportSecurity: "loopback" },
  });
});

test("HTTP permits loopback and only the literal 100.64.0.0/10 range", () => {
  for (const host of ["localhost", "dashboard.localhost", "127.0.0.1", "127.255.255.254", "[::1]", "100.64.0.0", "100.127.255.255"]) {
    assert.equal(parseRemoteInstancePairingLink(`http://${host}:4317/#pair=${TOKEN}`).ok, true, host);
  }
  for (const host of ["100.63.255.255", "100.128.0.0", "100.64.0.0.example.com", "wollipog.tailnet.ts.net", "192.168.1.9", "10.0.0.1", "0.0.0.0", "[fd7a:115c:a1e0::1]"]) {
    expectError(parseRemoteInstancePairingLink(`http://${host}:4317/#pair=${TOKEN}`), "CLEARTEXT_NOT_ALLOWED");
  }
  // The cleartext restriction does not reject authenticated HTTPS endpoints, including IPv6.
  assert.equal(parseRemoteInstancePairingLink(`https://[fd7a:115c:a1e0::1]:4317/#pair=${TOKEN}`).ok, true);
  const tailnet = parseRemoteInstancePairingLink(`http://100.64.0.1:4317/#pair=${TOKEN}`);
  assert.equal(tailnet.ok && tailnet.value.endpoint.transportSecurity, "tailscale-route-required");
  const loopbackDot = parseRemoteInstancePairingLink(`http://localhost.:4317/#pair=${TOKEN}`);
  assert.equal(loopbackDot.ok && loopbackDot.value.endpoint.transportSecurity, "loopback");
});

test("pairing links reject unsafe or ambiguous URL shapes", () => {
  const cases: Array<[string, InstancePairingErrorCode]> = [
    ["", "EMPTY_INPUT"],
    [` ${`https://example.com/#pair=${TOKEN}`}`, "INVALID_URL"],
    [`https://example.com/\n#pair=${TOKEN}`, "CONTROL_CHARACTER"],
    [`ftp://example.com/#pair=${TOKEN}`, "UNSUPPORTED_SCHEME"],
    [`ws://example.com/#pair=${TOKEN}`, "UNSUPPORTED_SCHEME"],
    [`https:example.com/#pair=${TOKEN}`, "INVALID_URL"],
    [`https://example.com\\@evil.example/#pair=${TOKEN}`, "INVALID_URL"],
    [`https://user:${"password"}@example.com/#pair=${TOKEN}`, "CREDENTIALS_NOT_ALLOWED"],
    [`https://*.example.com/#pair=${TOKEN}`, "WILDCARD_HOST_NOT_ALLOWED"],
    [`https://example.com:0/#pair=${TOKEN}`, "INVALID_PORT"],
    [`https://example.com/dashboard#pair=${TOKEN}`, "PATH_NOT_ALLOWED"],
    [`https://example.com/index.html/#pair=${TOKEN}`, "PATH_NOT_ALLOWED"],
    [`https://example.com/admin/../#pair=${TOKEN}`, "PATH_NOT_ALLOWED"],
    [`https://example.com/admin/%2e%2e/#pair=${TOKEN}`, "PATH_NOT_ALLOWED"],
    [`https://example.com/?mode=remote#pair=${TOKEN}`, "QUERY_NOT_ALLOWED"],
    [`https://example.com/?#pair=${TOKEN}`, "QUERY_NOT_ALLOWED"],
    ["https://example.com/", "PAIRING_FRAGMENT_REQUIRED"],
    [`https://example.com/#other=${TOKEN}`, "PAIRING_FRAGMENT_REQUIRED"],
    [`https://example.com/#pair=${TOKEN}&admin=true`, "PAIRING_FRAGMENT_REQUIRED"],
    [`https://example.com/#pair=${TOKEN}#extra`, "PAIRING_FRAGMENT_REQUIRED"],
    [`https://example.com/#pair=short`, "PAIRING_FRAGMENT_REQUIRED"],
    [`https://example.com/#pair=${"a".repeat(257)}`, "PAIRING_FRAGMENT_REQUIRED"],
    ["z".repeat(2049), "INPUT_TOO_LONG"],
  ];
  for (const [input, code] of cases) expectError(parseRemoteInstancePairingLink(input), code);
});

test("advanced input rejects fragments, malformed tokens, controls, and oversized values", () => {
  expectError(normalizeRemoteInstanceOrigin(`https://example.com/#pair=${TOKEN}`), "FRAGMENT_NOT_ALLOWED");
  expectError(normalizeRemoteInstanceOrigin("https://example.com/#"), "FRAGMENT_NOT_ALLOWED");
  expectError(normalizeRemoteInstanceOrigin("https://example.com/?mode=remote"), "QUERY_NOT_ALLOWED");
  expectError(parseRemoteInstanceAdvanced("https://example.com/", ""), "EMPTY_INPUT");
  expectError(parseRemoteInstanceAdvanced("https://example.com/", "short"), "TOKEN_INVALID");
  expectError(parseRemoteInstanceAdvanced("https://example.com/", `${TOKEN}\n`), "CONTROL_CHARACTER");
  expectError(parseRemoteInstanceAdvanced("https://example.com/", "a".repeat(257)), "INPUT_TOO_LONG");
  expectError(parseRemoteInstanceAdvanced("https://example.com/", ` ${TOKEN}`), "TOKEN_INVALID");
  expectError(normalizeRemoteInstanceOrigin(`https://${"a".repeat(2040)}.com/`), "INPUT_TOO_LONG");
});

test("IPv4, IPv6, HTTPS, and default ports canonicalize consistently", () => {
  assert.deepEqual(normalizeRemoteInstanceOrigin("http://127.0.0.1:80/index.html"), {
    ok: true,
    value: { httpOrigin: "http://127.0.0.1", wsOrigin: "ws://127.0.0.1", transportSecurity: "loopback" },
  });
  assert.deepEqual(normalizeRemoteInstanceOrigin("http://[0:0:0:0:0:0:0:1]:4317/"), {
    ok: true,
    value: { httpOrigin: "http://[::1]:4317", wsOrigin: "ws://[::1]:4317", transportSecurity: "loopback" },
  });
  assert.deepEqual(normalizeRemoteInstanceOrigin("https://[2001:db8::1]:443/"), {
    ok: true,
    value: { httpOrigin: "https://[2001:db8::1]", wsOrigin: "wss://[2001:db8::1]", transportSecurity: "tls" },
  });
});

test("duplicate helpers compare canonical origins and discovered control-plane identity", () => {
  const instances: RemoteInstanceReference[] = [
    { id: "local", httpOrigin: "http://localhost:4317", controlPlaneId: "cp-local" },
    { id: "alpha", httpOrigin: "https://alpha.example", controlPlaneId: "cp-alpha" },
  ];

  assert.equal(findRemoteInstanceOriginDuplicate("https://ALPHA.example:443/index.html", instances)?.id, "alpha");
  assert.equal(findRemoteInstanceOriginDuplicate("https://alpha.example", instances, "alpha"), null);
  assert.equal(findRemoteInstanceOriginDuplicate("https://new.example", instances), null);
  assert.equal(findRemoteInstanceOriginDuplicate("not a URL", instances), null);

  assert.equal(findRemoteInstanceIdentityDuplicate("cp-alpha", instances)?.id, "alpha");
  assert.equal(findRemoteInstanceIdentityDuplicate("cp-alpha", instances, "alpha"), null);
  assert.equal(findRemoteInstanceIdentityDuplicate("cp-new", instances), null);
  assert.equal(findRemoteInstanceIdentityDuplicate("", instances), null);
});
