import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Runs only in a child process with a new fixture database. Never import the hosting instance.
const root = mkdtempSync(join(tmpdir(), "owner-parity-"));
const listener = createServer();
await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
const port = (listener.address() as {port: number}).port;
await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
for (const key of Object.keys(process.env)) if (key.startsWith("CONTROL_PLANE_")) delete process.env[key];
Object.assign(process.env, {CONTROL_PLANE_HOST: "127.0.0.1", CONTROL_PLANE_PORT: String(port),
  CONTROL_PLANE_DB: join(root, "fixture.db"), CONTROL_PLANE_ARTIFACT_DIR: join(root, "artifacts"),
  CONTROL_PLANE_TOKEN: "owner-parity-fixture-token", CONTROL_PLANE_USAGE_PRICING_URL: "off"});
const {app, ownerManagementInventory, assistantOperations} = await import("../src/index.js");
await app.ready();
const connection = {id: "inventory-fixture", name: "Fixture", ownerUserId: "fixture", organizationId: "fixture",
  revision: 1, revoked: false, grant: {operations: "all" as const, projects: "all" as const}};
const tools = assistantOperations.list(connection).map(op => op.name).sort();
console.log("OWNER_PARITY_SNAPSHOT " + JSON.stringify({routes: ownerManagementInventory.list(), tools}));
if (process.argv.includes("--require-complete")) {
  const manifest = JSON.parse(readFileSync(new URL("../../../docs/assistant-owner-capabilities.json", import.meta.url), "utf8"));
  const coverage = Object.fromEntries(Object.entries(manifest).filter(([, entry]) => {
    const value = entry as Record<string, unknown>;
    return "tools" in value || "exclusion" in value;
  }));
  try {
    ownerManagementInventory.assertComplete(coverage as Parameters<typeof ownerManagementInventory.assertComplete>[0], new Set(tools));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Owner parity verification failed.");
    process.exitCode = 1;
  }
}
await app.close();
rmSync(root, {recursive: true, force: true});
process.exit(process.exitCode ?? 0);
