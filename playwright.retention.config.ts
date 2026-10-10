import { defineConfig } from "@playwright/test";

// The live retention test owns its synthetic CP and production build. Starting a second watched
// Vite server adds no coverage and can exhaust file watchers on concurrent developer worktrees.
export default defineConfig({
  testDir: "./apps/web/e2e",
  testMatch: "session-detail-retention-live.spec.ts",
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  use: { trace: "off", screenshot: "only-on-failure" },
});
