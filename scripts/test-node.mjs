import { availableParallelism } from "node:os";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import { run } from "node:test";
import { spec } from "node:test/reporters";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import timingReporter from "./ci-node-timing-reporter.mjs";
import { discoverNodeTests, nodeTestInventory, planNodeTests } from "./node-test-plan.mjs";

export async function runNodeTests(files, { concurrency = Math.max(1, availableParallelism() - 1), timeout = 300_000, ci = false } = {}) {
  if (!files.length) throw new Error("Refusing to pass an empty Node test suite");
  for (const [name, value] of Object.entries({ concurrency, timeout })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}: ${value}`);
  }
  const controller = new AbortController();
  const interrupted = (signal) => {
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    controller.abort(new Error(`Node suite interrupted by ${signal}`));
  };
  const onInt = () => interrupted("SIGINT"), onTerm = () => interrupted("SIGTERM");
  process.once("SIGINT", onInt);
  process.once("SIGTERM", onTerm);
  try {
    // Node's CLI sorts paths again. run({files}) preserves measured scheduling order
    // while retaining the native runner's process isolation, timeout and child reaping.
    const events = run({ files, concurrency, timeout, isolation: "process",
      execArgv: ["--import", "tsx", `--test-timeout=${timeout}`], signal: controller.signal });
    // A failing TODO emits test:fail but does not fail the CLI. The native
    // summary also accounts for failures outside an individual test callback.
    events.on("test:summary", ({ success }) => { if (!success) process.exitCode ||= 1; });
    const timing = new PassThrough({ objectMode: true });
    const timed = ci ? (async () => {
      for await (const line of timingReporter(timing)) process.stdout.write(line);
    })() : Promise.resolve();
    if (ci) {
      events.on("data", (event) => timing.write(event));
      events.once("end", () => timing.end());
      events.once("error", (error) => timing.destroy(error));
    }
    await pipeline(events, new spec(), process.stdout, { end: false });
    await timed;
  } finally {
    process.removeListener("SIGINT", onInt);
    process.removeListener("SIGTERM", onTerm);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: {
    suite: { type: "string", default: "full" }, ci: { type: "boolean", default: false },
    inventory: { type: "boolean", default: false },
    "test-concurrency": { type: "string" }, "test-timeout": { type: "string", default: "300000" },
  } });
  const discovered = await discoverNodeTests();
  if (values.inventory) console.log(JSON.stringify(nodeTestInventory(discovered), null, 2));
  else await runNodeTests(planNodeTests(discovered, values.suite), {
    timeout: Number(values["test-timeout"]), ci: values.ci,
    ...(values["test-concurrency"] ? { concurrency: Number(values["test-concurrency"]) } : {}),
  });
}
