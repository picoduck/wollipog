/**
 * Stand-in for the packaged CLI in verify-cli-binary.test.mjs. A POSIX wrapper copied into the
 * smoke's temporary directory runs it as `node <this file> <wrapper path> ...args`.
 * FAKE_CLI_VERSION overrides the `--version` output; FAKE_CLI_LOCK_ROOT=1 leaves a read-only
 * directory in the smoke's temporary directory so that removing it fails.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [self, ...args] = process.argv.slice(2);
if (process.env.FAKE_CLI_LOCK_ROOT === "1") {
  const locked = join(dirname(self), "locked");
  mkdirSync(locked, { recursive: true });
  writeFileSync(join(locked, "held"), "");
  chmodSync(locked, 0o500);
}

const option = (name) => args[args.indexOf(name) + 1];
async function get(path) {
  const token = readFileSync(option("--token-file"), "utf8").trim();
  const headers = { authorization: `Bearer ${token}` };
  await fetch(`${option("--url")}/api/compatibility`, { headers });
  return (await fetch(`${option("--url")}${path}`, { headers })).json();
}

if (args[0] === "--version") {
  console.log(process.env.FAKE_CLI_VERSION ?? "wollipog 0.0.0 (protocol v1000)");
} else if (args[0] === "help" && args[1] === "admin") {
  console.log("Usage: wollipog admin <command>");
} else if (args[0] === "admin" && args[1] === "status") {
  console.log(JSON.stringify(await get("/api/admin/status")));
} else if (args[0] === "admin" && args[1] === "pairing-url") {
  const token = readFileSync(option("--token-file"), "utf8").trim();
  console.log(JSON.stringify({ pairingUrl: `${option("--url")}/#pair=${token}` }));
} else if (args[0] === "pair" && args[1] === "list") {
  console.log(JSON.stringify(await get("/api/devices")));
} else if (args[0] === "doctor") {
  const ok = (await get("/api/admin/doctor")).checks.every((check) => check.status === "pass");
  console.log(JSON.stringify({ ok }));
  process.exitCode = ok ? 0 : 1;
} else {
  process.stderr.write("Wollipog CLI\nUsage: wollipog <command>\n");
  process.exitCode = 2;
}
