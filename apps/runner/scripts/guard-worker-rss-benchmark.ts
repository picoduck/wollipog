/** Run in its own throwaway process. Measures actual verdict listeners, including loaded judge. */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedWorktreeGuardSockets } from "../src/managed-worktree-guard-socket.js";
import { requestManagedWorktreeGuardVerdict } from "../src/managed-worktree-guard.js";

const root = mkdtempSync(join(tmpdir(), "wg-rss-"));
const host = new ManagedWorktreeGuardSockets(root, () => []);
const sample = async (sessions: number, baseline?: number) => {
  await new Promise(resolve => setTimeout(resolve, 200));
  globalThis.gc?.();
  const rss = process.memoryUsage().rss;
  console.log(JSON.stringify({ sessions, rssBytes: rss, deltaBytes: baseline === undefined ? 0 : rss - baseline,
    threads: process.platform === "linux" ? readdirSync("/proc/self/task").length : null }));
  return rss;
};
async function main() {
  try {
    const baseline = await sample(0);
    for (let n = 1; n <= 30; n++) {
      const address = await host.ensure(`s_rss_${n}`, "abstract");
      const verdict = await requestManagedWorktreeGuardVerdict(address,
        JSON.stringify({ tool_name: "Bash", cwd: "/work", tool_input: { command: "git status" } }), 5000, {});
      if (verdict.exitCode !== 0 || verdict.stdout || verdict.stderr) throw new Error("unexpected benchmark verdict");
      if ([1, 10, 30].includes(n)) await sample(n, baseline);
    }
  } finally { await host.closeAll(); rmSync(root, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
