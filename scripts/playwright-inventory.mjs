import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";

export function playwrightInventory(config, env = {}) {
  // Concurrent --list processes can delete each other's transform-cache source maps.
  // Keep source locations in our inventory identities, but give each reader its own cache.
  const cache = mkdtempSync(join(tmpdir(), "wollipog-playwright-inventory-"));
  try {
    return JSON.parse(execFileSync(process.execPath,
      ["node_modules/@playwright/test/cli.js", "test", "--config", config, "--list", "--reporter=json"], {
        cwd: new URL("../", import.meta.url), encoding: "utf8", timeout: 30_000, maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, ...env, CI: "", SYNTHETIC_ARTIFACT_FAILURE: "false", FORCE_COLOR: "0", PWTEST_CACHE_DIR: cache },
        stdio: ["ignore", "pipe", "pipe"],
      }));
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
}
