import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { captureLiveProcess, terminateOriginalProcess, type PosixProcessIdentity } from "./posix-process.js";

export function codexProbeFixture(t: TestContext, silent = false) {
  const dir = mkdtempSync(join(tmpdir(), "wollipog-codex-probe-"));
  const script = join(dir, "codex.cjs");
  const pidFile = join(dir, "helper.pid");
  writeFileSync(script, `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  detached: true, stdio: "ignore"
});
helper.unref();
fs.writeFileSync(${JSON.stringify(pidFile)}, String(helper.pid));
const silent = ${silent};
const reply = (message) => setTimeout(() => { if (!silent) console.log(JSON.stringify(message)); }, 400);
if (process.argv.includes("mcp")) {
  setTimeout(() => { if (!silent) { console.log("[]"); process.exit(0); } }, 400);
} else if (process.argv.includes("app-server")) {
  require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    reply({ id: request.id, result: request.method === "thread/start"
      ? { activePermissionProfile: { id: ":workspace" }, sandbox: {
        type: "workspaceWrite", writableRoots: [], networkAccess: false,
        excludeTmpdirEnvVar: false, excludeSlashTmp: false
      }} : request.method === "hooks/list" ? { data: [] }
        : request.method === "initialize" ? { userAgent: "wollipog-runner/0.163.0 (fixture)" } : {} });
  });
} else setTimeout(() => {
  if (!silent) { console.log("probe output"); console.error("probe diagnostic"); process.exit(7); }
}, 400);
setInterval(() => {}, 1000);
`);
  let identity: PosixProcessIdentity | undefined;
  t.after(async () => {
    if (!identity) {
      try { identity = await captureLiveProcess(Number(readFileSync(pidFile, "utf8"))); } catch { /* not started */ }
    }
    await terminateOriginalProcess(identity);
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir, script,
    launch: { command: process.execPath, args: [script], cwd: dir, env: { ...process.env, HOME: dir, CODEX_HOME: dir } },
    helper: async () => {
      for (let attempt = 0; attempt < 300; attempt++) {
        try {
          identity = await captureLiveProcess(Number(readFileSync(pidFile, "utf8")));
          if (identity) return identity;
        } catch { /* fixture not started yet */ }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("fixture helper did not start");
    },
  };
}

