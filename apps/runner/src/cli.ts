/**
 * Runner entry dispatcher. ONE executable, two modes — the box deployment is a single
 * Node-SEA binary, so the conductor's MCP server must live inside it, not beside it:
 *  - `--conductor-mcp`: the manager MCP server the claude CLI spawns for a conductor
 *    session (see conductor.ts / conductor-mcp.ts). Skips the daemon entirely.
 *  - default: the runner daemon (index.ts, unchanged as a module).
 * Dynamic imports, NOT top-level await: build-binary.mjs bundles this entry to CJS,
 * where TLA is a build error.
 */

import { detectRunnerSea } from "./runner-reentry.js";
import { resolveRunnerEntry } from "./runner-entry.js";

const entry = resolveRunnerEntry(process.argv, detectRunnerSea());

if (entry.mode === "--state-doctor") {
  void import("./state-doctor.js").then((m) => m.runStateDoctor(process.argv)).catch((error) => {
    console.error(`[state-doctor] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
} else if (entry.mode === "--policy-hook") {
  void import("./policy-hook.js").then((m) => m.runPolicyHookCli(process.argv, process.env));
} else if (entry.mode === "--conductor-mcp") {
  console.error("The Conductor MCP server is retired. Use the session-scoped Wollipog MCP server.");
  process.exitCode = 1;
} else if (entry.mode === "--agent-control-mcp") {
  void import("./wollipog-cli.js").then((m) => m.runAgentControlMcp(process.env));
} else if (entry.mode === "--wollipog-cli") {
  void import("./wollipog-cli.js").then(async (m) => {
    process.exitCode = await m.runWollipogCli(process.argv, process.env);
  });
} else {
  void import("./index.js");
}
