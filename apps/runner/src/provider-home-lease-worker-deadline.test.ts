import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

for (const canonical of [false, true]) test(`actual source worker deadline enforcement (${canonical ? "canonical native I/O" : "control frames"})`, () => {
  const filename = fileURLToPath(new URL("./provider-home-lease-worker.ts", import.meta.url));
  // Match the release bundling options; no registry/helper stub or alternate worker is supplied.
  const built = buildSync({ entryPoints: [filename], bundle: true, platform: "node", format: "cjs",
    target: "node24", define: { "import.meta.url": "undefined" }, write: false });
  const { verifyWorkerDeadlines } = createRequire(import.meta.url)("../scripts/provider-home-worker-deadline-fixture.cjs") as {
    verifyWorkerDeadlines(code: string, filename: string, options: { canonical: boolean }): { cases: number; exactWorkerSha256: string };
  };
  const report = verifyWorkerDeadlines(built.outputFiles[0]!.text, filename, { canonical });
  assert.ok(report.cases >= (canonical ? 25 : 22)); assert.match(report.exactWorkerSha256, /^[a-f0-9]{64}$/u);
});
