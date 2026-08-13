import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildRunnerWsUrl,
  isAllowedOrigin,
  isLoopback,
  isLoopbackBindHost,
  isTailnetIpv4,
  isTailnetOrLoopbackConnection,
  pairingHosts,
  tailnetIpv4,
} from "./net.js";

test("isLoopback recognises loopback addresses", () => {
  assert.equal(isLoopback("127.0.0.1"), true);
  assert.equal(isLoopback("127.1.2.3"), true);
  assert.equal(isLoopback("::1"), true);
  assert.equal(isLoopback("::ffff:127.0.0.1"), true);
});

test("isLoopback rejects remote/empty addresses", () => {
  assert.equal(isLoopback("192.168.1.20"), false);
  assert.equal(isLoopback("10.0.0.5"), false);
  assert.equal(isLoopback("::ffff:192.168.1.20"), false);
  assert.equal(isLoopback(undefined), false);
  assert.equal(isLoopback(""), false);
});

test("isTailnetIpv4 accepts only canonical Tailscale CGNAT addresses", () => {
  assert.equal(isTailnetIpv4("100.64.0.1"), true);
  assert.equal(isTailnetIpv4("100.127.255.254"), true);
  assert.equal(isTailnetIpv4("::ffff:100.66.169.98"), true);
  assert.equal(isTailnetIpv4("100.63.255.255"), false);
  assert.equal(isTailnetIpv4("100.128.0.1"), false);
  assert.equal(isTailnetIpv4("192.168.1.20"), false);
  assert.equal(isTailnetIpv4("100.064.0.1"), false);
  assert.equal(isTailnetIpv4("100.64.0"), false);
});

test("tailnet-only connections require both socket endpoints to use the same trusted surface", () => {
  assert.equal(isTailnetOrLoopbackConnection("127.0.0.1", "127.0.0.1"), true);
  assert.equal(isTailnetOrLoopbackConnection("::ffff:127.0.0.1", "::ffff:127.0.0.1"), true);
  assert.equal(isTailnetOrLoopbackConnection("100.70.1.2", "100.80.1.3"), true);
  assert.equal(isTailnetOrLoopbackConnection("100.70.1.2", "192.168.1.3"), false);
  assert.equal(isTailnetOrLoopbackConnection("192.168.1.2", "100.80.1.3"), false);
  assert.equal(isTailnetOrLoopbackConnection("127.0.0.1", "100.80.1.3"), false);
});

test("tailnetIpv4 removes LAN and malformed addresses from advertised browser links", () => {
  assert.deepEqual(tailnetIpv4(["192.168.1.9", "100.66.169.98", "10.0.0.4", "100.100.20.30"]), [
    "100.66.169.98",
    "100.100.20.30",
  ]);
});

test("buildRunnerWsUrl maps any-address binds to loopback for display", () => {
  assert.equal(buildRunnerWsUrl("0.0.0.0", 4317), "ws://127.0.0.1:4317/runner");
  assert.equal(buildRunnerWsUrl("::", 4317), "ws://127.0.0.1:4317/runner");
});

test("buildRunnerWsUrl keeps plain hosts and brackets IPv6 literals", () => {
  assert.equal(buildRunnerWsUrl("127.0.0.1", 4317), "ws://127.0.0.1:4317/runner");
  assert.equal(buildRunnerWsUrl("192.168.1.20", 8080), "ws://192.168.1.20:8080/runner");
  // IPv6 literals must be bracketed to form a valid URL
  assert.equal(buildRunnerWsUrl("::1", 4317), "ws://[::1]:4317/runner");
  assert.equal(buildRunnerWsUrl("fe80::1", 4317), "ws://[fe80::1]:4317/runner");
});

test("isAllowedOrigin allows loopback, .localhost (incl. Tauri), and no-Origin", () => {
  assert.equal(isAllowedOrigin("http://localhost:5173"), true);
  assert.equal(isAllowedOrigin("http://127.0.0.1:4317"), true);
  assert.equal(isAllowedOrigin("http://tauri.localhost"), true); // Tauri shell on Windows
  assert.equal(isAllowedOrigin("https://something.localhost"), true);
  assert.equal(isAllowedOrigin(undefined), true); // curl / native client, not a browser snoop vector
  assert.equal(isAllowedOrigin(""), true);
});

test("isAllowedOrigin blocks foreign + malformed origins (the /ui WS snoop vector)", () => {
  assert.equal(isAllowedOrigin("http://evil.example.com"), false);
  assert.equal(isAllowedOrigin("https://localhost.evil.com"), false); // not the .localhost TLD
  assert.equal(isAllowedOrigin("http://192.168.1.20:5173"), false);
  assert.equal(isAllowedOrigin("not a url"), false);
});

test("isLoopbackBindHost: names as well as IP literals (CONTROL_PLANE_HOST may be a name)", () => {
  assert.equal(isLoopbackBindHost("127.0.0.1"), true);
  assert.equal(isLoopbackBindHost("::1"), true);
  assert.equal(isLoopbackBindHost("[::1]"), true);
  assert.equal(isLoopbackBindHost("localhost"), true);
  assert.equal(isLoopbackBindHost("LocalHost"), true);
  assert.equal(isLoopbackBindHost("app.localhost"), true);
  assert.equal(isLoopbackBindHost("localhost."), true); // FQDN trailing dot still resolves loopback
  assert.equal(isLoopbackBindHost("0.0.0.0"), false);
  assert.equal(isLoopbackBindHost("192.168.1.9"), false);
});

test("pairingHosts: loopback advertises nothing; wildcard advertises the LAN; a specific bind only itself", () => {
  const lan = ["192.168.1.9", "100.64.0.2"];
  // Nothing else can reach a loopback bind — advertising a LAN link would be a dead link.
  assert.deepEqual(pairingHosts("127.0.0.1", lan), []);
  assert.deepEqual(pairingHosts("localhost", lan), []);
  // Wildcard listens everywhere.
  assert.deepEqual(pairingHosts("0.0.0.0", lan), lan);
  assert.deepEqual(pairingHosts("::", lan), lan);
  // A specific bind listens on exactly one address — don't advertise the others.
  assert.deepEqual(pairingHosts("100.64.0.2", lan), ["100.64.0.2"]);
});
