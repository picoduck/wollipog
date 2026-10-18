// Synthetic supervisor lifecycle fixture, also bundled into a real Node SEA by the regression test.
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { PassThrough } = require("node:stream");
const { ProviderLoginSupervisor } = require("../provider-login.ts");

async function main() {
  const root = process.argv[2];
  assert.ok(root, "an isolated synthetic root is required");
  const configPath = join(root, "runner.json");
  writeFileSync(configPath, JSON.stringify({ runnerId: "synthetic", untouched: true }));
  const accounts = [];
  let child;
  let releases = 0;
  const supervisor = new ProviderLoginSupervisor({
    dataDir: root, configPath, accounts, agents: () => [], resolveEnv: () => ({}),
    acquireLease: () => true,
    releaseLease: (home) => {
      releases++;
      writeFileSync(join(home, "successor"), "synthetic successor");
      return true;
    },
    onUpdate: () => {}, onAccountAdded: () => {},
    identify: async () => "synthetic identity", probe: async () => true,
    spawn: () => {
      child = new EventEmitter();
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      return child;
    },
    kill: async () => true,
  });
  accounts.push({ id: "existing", label: "Existing", provider: "claude", directory: join(root, "existing") });
  const duplicate = join(root, "provider-accounts", "duplicate");
  mkdirSync(duplicate, { recursive: true });
  writeFileSync(join(duplicate, ".credentials.json"), "synthetic credentials");
  writeFileSync(join(duplicate, "ownership-evidence"), "synthetic journal");
  const operation = await supervisor.startResolved({ accountId: "duplicate", label: "Duplicate", provider: "claude",
    directory: duplicate, command: "synthetic-provider", args: [], context: { kind: "native" }, env: {}, persistAccount: true });
  child.emit("close", 0);
  assert.equal(await operation.completion, "failed");
  assert.equal(releases, 1);
  assert.equal(readFileSync(join(duplicate, "successor"), "utf8"), "synthetic successor");
  assert.equal(readFileSync(join(duplicate, ".credentials.json"), "utf8"), "synthetic credentials");
  assert.equal(readFileSync(join(duplicate, "ownership-evidence"), "utf8"), "synthetic journal");

  const removed = join(root, "provider-accounts", "removed");
  mkdirSync(removed);
  writeFileSync(join(removed, "auth.json"), "synthetic configured credentials");
  accounts.push({ id: "removed", label: "Removed", provider: "codex", directory: removed });
  assert.deepEqual(await supervisor.removeAccount("removed"), { credentialsRetained: true });
  assert.equal(readFileSync(join(removed, "auth.json"), "utf8"), "synthetic configured credentials");
  assert.equal(accounts.some((account) => account.id === "removed"), false);
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).untouched, true);
  console.log("synthetic retention verified");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
