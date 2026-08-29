import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./apps/web/e2e",
  testMatch: ["timeline-reflow.spec.ts", "settings-rows.spec.ts"],
  grep: /continuous panel resizing|mounting and unmounting a preceding notice|the reduced topology production can render|every affordance is painted/,
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  failOnFlakyTests: Boolean(process.env.CI),
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:4175",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "pnpm --filter @wollipog/web build:e2e && pnpm --filter @wollipog/web exec vite preview --host 127.0.0.1 --port 4175 --strictPort --outDir dist-e2e",
    url: "http://127.0.0.1:4175/timeline-reflow-e2e.html",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
