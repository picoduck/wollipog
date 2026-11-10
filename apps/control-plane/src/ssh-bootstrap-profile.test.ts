import assert from "node:assert/strict";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { buildContentAddressedStageCommand, buildTokenDeployCommand } from "./box-orchestrator.js";
import { createManagedProviderProfileHome, managedProviderProfileRoot } from "../../runner/src/provider-profile-home.js";

const digest = "a".repeat(64);
const credentialId = `rcred_${"b".repeat(32)}`;
const profileId = "6f1c2d3e-4a5b-4c6d-8e7f-001122334455";
const posixOnly = { skip: process.platform === "win32" };

function fixture(t: TestContext): string {
  const home = mkdtempSync(join(tmpdir(), "wollipog-ssh-bootstrap-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function bootstrap(home: string, umask: string): void {
  // Production SSH commands, in deployment order, against an empty synthetic home.
  // No SSH server, provider process, or real credentials are involved.
  execFileSync("sh", ["-c", `umask ${umask}; ${buildContentAddressedStageCommand(digest)}`], { cwd: home });
  execFileSync("sh", ["-c", buildTokenDeployCommand(credentialId)], { cwd: home, input: "synthetic-token" });
}

for (const umask of ["0002", "0022", "0077"]) {
  test(`SSH staging then managed profile creation succeeds under umask ${umask}`, posixOnly, (t) => {
    const home = fixture(t);
    bootstrap(home, umask);
    const profile = createManagedProviderProfileHome(managedProviderProfileRoot(home), profileId);
    for (const component of [".agent-manager", ".agent-manager/runners", `.agent-manager/runners/${digest}`, ".agent-manager/credentials"]) {
      assert.equal(statSync(join(home, component)).mode & 0o777, 0o700, component);
    }
    assert.equal(statSync(profile).mode & 0o777, 0o700);
    assert.equal(readFileSync(join(home, ".agent-manager/credentials", credentialId), "utf8"), "synthetic-token");
  });
}

test("SSH staging does not silently repair an existing writable manager root or change its contents", posixOnly, (t) => {
  const home = fixture(t);
  const manager = join(home, ".agent-manager");
  mkdirSync(manager);
  chmodSync(manager, 0o775);
  const sentinel = join(manager, "operator-data");
  writeFileSync(sentinel, "preserve");
  bootstrap(home, "0002");
  assert.throws(() => createManagedProviderProfileHome(managedProviderProfileRoot(home), profileId), /not a private directory/u);
  assert.equal(statSync(manager).mode & 0o777, 0o775);
  assert.equal(readFileSync(sentinel, "utf8"), "preserve");
});
