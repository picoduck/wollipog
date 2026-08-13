import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./apps/web/e2e",
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:4174",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "pnpm --dir apps/web exec vite --host 127.0.0.1 --port 4174 --strictPort",
    url: "http://127.0.0.1:4174/remote-instances-e2e.html",
    // Never reused, including locally. This repo is worked in several git worktrees at once, and a
    // Vite server left running by any of them answers on this port — so a local run, or a
    // screenshot-baseline regeneration, could certify a different checkout's source and report
    // every assertion green. --strictPort turns that collision into an error instead.
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
