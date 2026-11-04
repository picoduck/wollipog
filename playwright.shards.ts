import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const BROWSER_SHARD_COUNT = 5;
export const browserTestDir = fileURLToPath(new URL("./apps/web/e2e/", import.meta.url));
export const browserProfile = JSON.parse(readFileSync(new URL("./scripts/fixtures/browser-shard-profile.json", import.meta.url), "utf8")) as {
  fallbackDurationMs: number;
  productionDurationMs: number;
  files: Record<string, number>;
};

// Match Playwright's default suffixes. New files receive a shard before timing evidence exists.
// The inventory contract compares this discovery with Playwright's own discovery.
export function browserFiles(): string[] {
  return readdirSync(browserTestDir, { recursive: true, encoding: "utf8" })
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => /\.(spec|test)\.[cm]?[jt]sx?$/.test(file) && file !== "inbox-lazy.spec.ts")
    .sort();
}

// Longest-processing-time first, preloading shard 1's production build/smoke. Files remain
// indivisible: serial groups and beforeAll/afterAll fixtures retain their native semantics.
export function browserShards(files = browserFiles(), profile = browserProfile) {
  const shards = Array.from({ length: BROWSER_SHARD_COUNT }, (_, index) => ({
    files: [] as string[], durationMs: index === 0 ? profile.productionDurationMs : 0,
  }));
  const weight = (file: string) => profile.files[file] ?? profile.fallbackDurationMs;
  for (const file of [...files].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b, "en"))) {
    const shard = shards.reduce((best, candidate) => candidate.durationMs < best.durationMs ? candidate : best);
    shard.files.push(file);
    shard.durationMs += weight(file);
  }
  return shards;
}
