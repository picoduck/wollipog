/**
 * Runner entry dispatcher. ONE executable, two modes — the box deployment is a single
 * Node-SEA binary, so the conductor's MCP server must live inside it, not beside it:
 *  - `--conductor-mcp`: the manager MCP server the claude CLI spawns for a conductor
 *    session (see conductor.ts / conductor-mcp.ts). Skips the daemon entirely.
 *  - default: the runner daemon (index.ts, unchanged as a module).
 * Dynamic imports, NOT top-level await: build-binary.mjs bundles this entry to CJS,
 * where TLA is a build error.
 */

if (process.argv.includes("--policy-hook")) {
  void import("./policy-hook.js").then((m) => m.runPolicyHookCli(process.argv, process.env));
} else if (process.argv.includes("--conductor-mcp")) {
  void import("./conductor-mcp.js").then((m) => m.runConductorMcp(process.argv, process.env));
} else {
  void import("./index.js");
}
