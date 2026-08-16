import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "./session-manager.js";
import { SessionStore } from "./session-store.js";

test("provider-home ownership is released only after shutdown process trees are reaped", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-shutdown-provider-home-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manager = new SessionManager(
    () => {},
    () => {},
    new SessionStore(join(root, "sessions")),
    "runner",
    undefined,
    undefined,
    root,
  );
  let releases = 0;
  (manager as unknown as { providerHomeLeases: { releaseAll(): void } }).providerHomeLeases = {
    releaseAll: () => { releases++; },
  };

  assert.throws(() => manager.releaseProviderHomeLeasesAfterShutdown(), /only be released after shutdown begins/);
  manager.shutdownAll();
  assert.equal(releases, 0, "shutdown initiation must retain ownership while process kills drain");
  manager.releaseProviderHomeLeasesAfterShutdown();
  assert.equal(releases, 1);
});
