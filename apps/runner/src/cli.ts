/**
 * Runner entry dispatcher. One Node-SEA executable contains the private worker and internal
 * modes; POSIX lease I/O uses a separately installed immutable companion:
 *  - internal modes (`--state-doctor`, `--policy-hook`, `--agent-control-mcp`,
 *    `--wollipog-cli`, `--managed-worktree-guard`; see runner-entry.ts) skip the daemon entirely.
 *  - default: the runner daemon (index.ts, unchanged as a module).
 * Dynamic imports, NOT top-level await: build-binary.mjs bundles this entry to CJS,
 * where TLA is a build error.
 */

import { resolveRunnerEntry } from "./runner-entry.js";

const entry = resolveRunnerEntry(process.argv);

if (entry.mode === "--lease-helper-install") {
  void import("./lease-helper-install.js").then(async (m) => {
    process.exitCode = await m.runLeaseHelperInstall(process.argv);
  }).catch(() => { console.error("Lease helper installer unavailable; preserve all evidence."); process.exitCode = 2; });
} else if (entry.mode === "--state-doctor") {
  void import("./state-doctor.js").then((m) => m.runStateDoctor(process.argv)).catch((error) => {
    console.error(`[state-doctor] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
} else if (entry.mode === "--policy-hook") {
  void import("./policy-hook.js").then((m) => m.runPolicyHookCli(process.argv, process.env));
} else if (entry.mode === "--agent-control-mcp") {
  void import("./wollipog-cli.js").then((m) => m.runAgentControlMcp(process.env));
} else if (entry.mode === "--managed-worktree-guard") {
  // Runs before every Claude Bash call; it must never start the daemon or write anything to
  // stdout except its own PreToolUse decision.
  void import("./managed-worktree-guard.js")
    .then((m) => m.runManagedWorktreeGuardCli(process.argv))
    .catch((error) => {
      // Fail closed: a guard that cannot start must block the tool call, never wave it through.
      console.error(`[managed-worktree-guard] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 2;
    });
} else if (entry.mode === "--wollipog-cli") {
  void import("./wollipog-cli.js").then(async (m) => {
    process.exitCode = await m.runWollipogCli(process.argv, process.env);
  });
} else {
  void import("./index.js");
}
