import { glob } from "node:fs/promises";
import { readFileSync } from "node:fs";

// Keep the original root command as the independent discovery oracle.
export const NODE_TEST_GLOBS = [
  "apps/**/src/**/*.test.ts", "apps/**/src/**/*.test.tsx",
  "apps/**/scripts/**/*.test.mjs", "packages/**/src/**/*.test.ts",
  "packages/**/src/**/*.test.tsx", "scripts/**/*.test.mjs",
];
export const profile = JSON.parse(readFileSync(new URL("../docs/ci-node-profile-2026-10-23.json", import.meta.url), "utf8"));

export async function discoverNodeTests(cwd = process.cwd()) {
  const files = new Set();
  // Node 22.13 supports the single-pattern async glob API (arrays arrived later).
  for (const pattern of NODE_TEST_GLOBS) {
    // Match the native test CLI: dependency trees are never part of discovery.
    for await (const file of glob(pattern, { cwd, exclude: (name) => name === "node_modules" })) files.add(file.replaceAll("\\", "/"));
  }
  return [...files].sort();
}

export function planNodeTests(files, suite = "full") {
  if (!["full", "fast", "remaining"].includes(suite)) throw new Error(`Unknown Node suite: ${suite}`);
  const fast = new Set(profile.fastFiles);
  const costs = new Map(profile.slowestFiles.map(({ file, durationMs }) => [file, durationMs]));
  return [...new Set(files)].filter((file) => suite === "full" || (suite === "fast" ? fast.has(file) : !fast.has(file)))
    .sort((a, b) => (costs.get(b) ?? 0) - (costs.get(a) ?? 0) || a.localeCompare(b, "en"));
}

export function nodeTestInventory(files) {
  const fast = new Set(profile.fastFiles);
  return [...new Set(files)].sort().map((file) => ({ file, full: true, partition: fast.has(file) ? "fast" : "remaining" }));
}
