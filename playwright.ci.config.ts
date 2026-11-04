import { defineConfig } from "@playwright/test";
import base from "./playwright.config.ts";
import { browserShards } from "./playwright.shards.ts";

export default defineConfig({
  ...base,
  // Match the unnamed project's existing baseline paths. Shard names are scheduling metadata.
  snapshotPathTemplate: "{snapshotDir}/{testFileDir}/{testFileName}-snapshots/{arg}{-snapshotSuffix}{ext}",
  projects: browserShards().map((shard, index) => ({
    name: `shard-${index + 1}`,
    // The opt-in synthetic probe deliberately fails on each job. Normal traffic runs the full,
    // disjoint inventory. Exact regexes prevent glob metacharacters in names from dropping work.
    testMatch: process.env.SYNTHETIC_ARTIFACT_FAILURE === "true" ? /ci-failure-artifacts\.spec\.ts$/
      : shard.files.map((file) => new RegExp(`(?:^|/)${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`)),
  })),
});
