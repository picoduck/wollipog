import { appendFileSync } from "node:fs";
import { CRITICAL_BROWSER_FILES } from "./ci-pr-browser-policy.mjs";

if (process.env.GITHUB_EVENT_NAME !== "workflow_dispatch")
  throw new Error("Browser benchmark requires the isolated manual workflow");
// The execution config independently proves these files are present and retains whole files.
const files = CRITICAL_BROWSER_FILES.map((file) => `apps/web/e2e/${file}`);
appendFileSync(process.env.GITHUB_ENV, `BENCHMARK_BROWSER_FILES=${JSON.stringify(files)}\n`);
