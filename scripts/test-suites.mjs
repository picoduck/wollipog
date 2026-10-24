import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CRITICAL_BROWSER_FILES, FAST_API_FILES, nodeGroup, GROUPS } from "./ci-suite-policy.mjs";
import { gitSelection } from "./ci-suite-selection.mjs";

export function suiteCommands(suite, { groups, ci = false } = {}) {
  if (!["fast", "full", "selected"].includes(suite)) throw new Error("Unknown suite");
  if (suite === "selected" && (!Array.isArray(groups) || !groups.length || groups.some((group) => !Object.hasOwn(GROUPS, group))))
    throw new Error("Selected suite requires an explicit validated selection");
  const selected = new Set(suite === "full" ? Object.keys(GROUPS) : groups ?? ["node-fast", "browser-critical"]);
  const fullNode = ["node-fast", "node-web", "node-control-plane", "node-runner", "node-other"].every((group) => selected.has(group));
  return [
    ["pnpm", "typecheck"],
    ["node", "scripts/test-suites.mjs", "--node-only", "--groups", [...selected].sort().join(","), ...(ci ? ["--ci"] : [])],
    ["pnpm", "--filter", "@wollipog/web", "build"],
    ["pnpm", "--filter", "@wollipog/runner", "exec", "node", "scripts/build-binary.mjs", "--bundle-only"],
    ["pnpm", "--filter", "@wollipog/desktop", "exec", "node", "scripts/build-sidecar.mjs", "--bundle-only"],
    ["pnpm", "test:e2e", ...(suite === "full" || selected.has("browser-remaining") ? [] : CRITICAL_BROWSER_FILES)],
    ["pnpm", "test:e2e:production"],
    ["pnpm", "test:e2e:webkit"],
  ].map((command) => ({ command, ...(command[1] === "scripts/test-suites.mjs" ? { nodeCoverage: fullNode ? "full" : "selected" } : {}) }));
}

async function execute(command, ci) {
  await new Promise((accept, reject) => {
    // pnpm's npm_execpath is its JS entry point, including on Windows where pnpm.cmd cannot
    // be spawned without a shell. Keep argv boundaries and avoid shell interpolation.
    const argv = command[0] === "pnpm" && /(?:^|[/\\])pnpm(?:\.c?js)?$/.test(process.env.npm_execpath ?? "") ? [process.execPath, process.env.npm_execpath, ...command.slice(1)]
      : command[0] === "node" ? [process.execPath, ...command.slice(1)] : command;
    const child = spawn(argv[0], argv.slice(1), { stdio: "inherit", shell: false,
      env: { ...process.env, SYNTHETIC_ARTIFACT_FAILURE: "false", ...(ci ? { CI: "true" } : {}) } });
    const signals = ["SIGINT", "SIGTERM"].map((signal) => [signal, () => child.kill(signal)]);
    for (const [signal, handler] of signals) process.once(signal, handler);
    const cleanup = () => { for (const [signal, handler] of signals) process.removeListener(signal, handler); };
    child.once("error", (error) => { cleanup(); reject(error); });
    child.once("exit", (code, signal) => { cleanup(); code === 0 ? accept() : reject(new Error(`Suite command failed (${signal ?? code})`)); });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: {
    suite: { type: "string", default: "full" }, ci: { type: "boolean", default: false },
    list: { type: "boolean", default: false }, base: { type: "string" }, head: { type: "string" },
    "node-only": { type: "boolean", default: false }, groups: { type: "string" },
  } });
  if (values["node-only"]) {
    const { discoverNodeTests, planNodeTests, profile } = await import("./node-test-plan.mjs");
    const { runNodeTests } = await import("./test-node.mjs");
    const groups = values.groups?.split(",") ?? [];
    if (!groups.length || groups.some((group) => !Object.hasOwn(GROUPS, group))) throw new Error("Invalid suite groups");
    const discovered = await discoverNodeTests();
    const full = ["node-fast", "node-web", "node-control-plane", "node-runner", "node-other"].every((group) => groups.includes(group));
    if (!full && ([...profile.fastFiles, ...FAST_API_FILES].some((file) => !discovered.includes(file)) ||
        CRITICAL_BROWSER_FILES.some((file) => !existsSync(`apps/web/e2e/${file}`))))
      throw new Error("Mandatory fast inventory missing; full coverage required");
    const files = planNodeTests(discovered).filter((file) => groups.includes(nodeGroup(file, profile.fastFiles)));
    if (values.list) console.log(JSON.stringify(files, null, 2));
    else await runNodeTests(files, { ci: values.ci });
  } else {
    let groups;
    if (values.suite === "selected") {
      if (!values.base || !values.head) throw new Error("Selected suite requires immutable --base and --head SHAs");
      const { selection } = gitSelection({ base: values.base, head: values.head });
      groups = selection.groups;
      console.log(JSON.stringify({ mode: selection.mode, reasons: selection.reasons, suiteId: selection.suiteId }));
    }
    const commands = suiteCommands(values.suite, { groups, ci: values.ci });
    if (values.list) console.log(JSON.stringify(commands, null, 2));
    else {
      const started = performance.now();
      let outcome = "failed";
      try {
        for (const { command } of commands) await execute(command, values.ci);
        outcome = "passed";
      } finally {
        console.log(JSON.stringify({ suite: values.suite, outcome, actualWallMs: Math.round(performance.now() - started),
          platform: process.platform, privilegedAndWindowsChecks: "CI-only-see-docs/ci-suites.md" }));
      }
    }
  }
}
