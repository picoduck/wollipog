import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveScopedVideoReviewMcp } from "./video-evidence-review-mcp.js";

/** MCP server name inside the reviewer; its tools surface as `mcp__media__<tool>`. */
export const MEDIA_MCP_SERVER_NAME = "media";

/** Runs inside the namespace as `/relay-node /relay/relay.cjs`. It only joins its stdio to the one
 * runner socket: no credential, path, URL or tool logic crosses into the reviewer namespace. */
export const MEDIA_REVIEW_RELAY_SOURCE = `"use strict";
const net = require("node:net");
const socket = net.connect("/relay/media.sock");
process.stdin.pipe(socket);
socket.pipe(process.stdout);
socket.on("error", () => process.exit(1));
socket.on("close", () => process.exit(0));
process.stdin.on("end", () => socket.end());
`;
export const MEDIA_REVIEW_MCP_CONFIG = JSON.stringify({ mcpServers: { [MEDIA_MCP_SERVER_NAME]: {
  type: "stdio", command: "/relay-node", args: ["/relay/relay.cjs"], env: {} } } });

export interface MediaReviewRelay {
  /** Private host directory mounted read-only at /relay. */
  directory: string;
  /** Connections the server accepted; at most one per relay. */
  accepted(): number;
  close(): Promise<void>;
}

/** Fresh private relay for one reviewer process. Unix socket paths are limited to 108 bytes, so
 * the directory lives in a short private temporary path, never inside a project or provider HOME.
 * Exactly one connection is served: a reconnecting or second client gets no media server. */
export async function openMediaReviewRelay(deps: Parameters<typeof serveScopedVideoReviewMcp>[2],
  root = tmpdir()): Promise<MediaReviewRelay> {
  const directory = mkdtempSync(join(root, "wollipog-media-"));
  chmodSync(directory, 0o700);
  writeFileSync(join(directory, "relay.cjs"), MEDIA_REVIEW_RELAY_SOURCE, { mode: 0o600, flag: "wx" });
  writeFileSync(join(directory, "mcp.json"), MEDIA_REVIEW_MCP_CONFIG, { mode: 0o600, flag: "wx" });
  let accepted = 0;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    if (accepted++ > 0) { socket.destroy(); return; }
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    try { serveScopedVideoReviewMcp(socket, socket, deps); } catch { socket.destroy(); }
  });
  server.maxConnections = 1;
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(join(directory, "media.sock"), () => { server.off("error", reject); resolveListen(); });
    });
    chmodSync(join(directory, "media.sock"), 0o600);
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    directory,
    accepted: () => accepted,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
