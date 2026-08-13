import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSshConfig } from "./ssh-config.js";

const CONFIG = `
# global defaults
Host *
  ServerAliveInterval 60

Host devbox
  HostName 192.168.1.50
  User misko
  Port 2222

Host prod jump
  HostName prod.example.com
  User deploy

Host eq-style
  HostName=10.0.0.9
  User=root

Host *.internal
  User admin

Match host something
  User bar

# a duplicate block for an existing alias
Host devbox
  User ignored
`;

test("parseSshConfig surfaces concrete hosts with HostName/User/Port", () => {
  const hosts = parseSshConfig(CONFIG);
  const byAlias = Object.fromEntries(hosts.map((h) => [h.host, h]));

  assert.deepEqual(byAlias["devbox"], {
    host: "devbox",
    hostName: "192.168.1.50",
    user: "misko",
    port: 2222,
  });
  // Multiple aliases on one Host line each become an entry, sharing the block's settings.
  assert.equal(byAlias["prod"]?.hostName, "prod.example.com");
  assert.equal(byAlias["prod"]?.user, "deploy");
  assert.equal(byAlias["prod"]?.port, undefined);
  assert.equal(byAlias["jump"]?.hostName, "prod.example.com");
  // `Keyword=value` form is parsed too.
  assert.equal(byAlias["eq-style"]?.hostName, "10.0.0.9");
  assert.equal(byAlias["eq-style"]?.user, "root");
});

test("parseSshConfig excludes wildcard patterns and Match blocks", () => {
  const aliases = parseSshConfig(CONFIG).map((h) => h.host);
  assert.ok(!aliases.includes("*"), "wildcard Host * excluded");
  assert.ok(!aliases.includes("*.internal"), "wildcard pattern excluded");
  // 'something' came from a Match block, not a Host — not importable.
  assert.ok(!aliases.includes("something"));
});

test("parseSshConfig dedups a repeated alias (first wins)", () => {
  const devboxes = parseSshConfig(CONFIG).filter((h) => h.host === "devbox");
  assert.equal(devboxes.length, 1);
  assert.equal(devboxes[0]!.user, "misko"); // first block's value, not the later 'ignored'
});

test("parseSshConfig returns [] for empty/garbage input", () => {
  assert.deepEqual(parseSshConfig(""), []);
  assert.deepEqual(parseSshConfig("not a config\n???"), []);
});
