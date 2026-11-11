// Version-pinned no-model smoke adapter, not a public OpenClaw API or production connector.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { TESTED_OPENCLAW_VERSION } from "./openclaw-assistant.mjs";

let runtime;
try {
  const [installation, requestPath] = process.argv.slice(2);
  const metadata = JSON.parse(await readFile(path.join(installation, "package.json"), "utf8"));
  if (metadata.name !== "openclaw" || metadata.version !== TESTED_OPENCLAW_VERSION) throw new Error("unsupported runtime");
  const { createSessionMcpRuntime } = await import(pathToFileURL(path.join(installation, "dist/agents/agent-bundle-mcp-runtime.js")).href);
  const cfg = JSON.parse(await readFile(process.env.OPENCLAW_CONFIG_PATH, "utf8"));
  for (const server of Object.values(cfg.mcp.servers)) {
    const match = /^Bearer \$\{([A-Z][A-Z0-9_]*)\}$/.exec(server.headers.Authorization);
    if (!match || !process.env[match[1]]) throw new Error("credential reference missing");
    server.headers.Authorization = `Bearer ${process.env[match[1]]}`;
  }
  runtime = createSessionMcpRuntime({
    sessionId: "wollipog-isolated-smoke", workspaceDir: process.env.OPENCLAW_WORKSPACE_DIR,
    cfg,
    // Explicit native config input prevents discovering unrelated plugins or skill directories.
    // Catalog listing, transport, initialization and tool execution remain OpenClaw's actual code.
    loaded: { mcpServers: cfg.mcp.servers, diagnostics: [], prepareDataDirsByServer: {} },
  });
  const request = JSON.parse(await readFile(requestPath, "utf8"));
  const catalog = await runtime.getCatalog();
  if (catalog.diagnostics?.some(item => item.serverName === request.server) || !catalog.tools.some(tool => tool.serverName === request.server && tool.toolName === request.name)) throw new Error("tool unavailable");
  const result = await runtime.callTool(request.server, request.name, request.arguments);
  if (result.isError) throw new Error("operation refused");
  process.stdout.write(JSON.stringify(JSON.parse(result.content.find(item => item.type === "text").text)));
} catch {
  console.error("OpenClaw native MCP call failed. Verify tested runtime, selected connection, grant and command receipt; raw output withheld.");
  process.exitCode = 1;
} finally {
  await runtime?.dispose();
  await runtime?.joinCleanup?.();
}
