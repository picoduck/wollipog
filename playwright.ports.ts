// The port each Playwright config serves the web client on.
//
// A Wollipog-managed worktree owns a port block (docs/worktree-hooks-and-ports.md), so its suites
// take the block's first two ports and several worktrees can run them at once. Without a block —
// CI and plain checkouts — they keep the fixed 4174 and 4175. Either way the configs pass
// --strictPort and never reuse a server, so a collision is an error rather than a run that
// certifies another checkout's source.

export type PlaywrightServer = "development" | "production";

const FALLBACK_PORTS: Record<PlaywrightServer, number> = { development: 4174, production: 4175 };
const BLOCK_OFFSETS: Record<PlaywrightServer, number> = { development: 0, production: 1 };

function blockBound(env: NodeJS.ProcessEnv, name: string): number {
  const raw = env[name] ?? "";
  if (!/^\d+$/u.test(raw) || Number(raw) < 1024 || Number(raw) > 65535) {
    throw new Error(`${name} must be a port from 1024 through 65535 when a port block is set; got "${raw}".`);
  }
  return Number(raw);
}

export function playwrightPort(server: PlaywrightServer, env: NodeJS.ProcessEnv = process.env): number {
  // The runner exports the block variables as empty strings for a worktree without a block.
  if (!env.WOLLIPOG_PORT_BLOCK_START) return FALLBACK_PORTS[server];

  const start = blockBound(env, "WOLLIPOG_PORT_BLOCK_START");
  const end = blockBound(env, "WOLLIPOG_PORT_BLOCK_END");
  const port = start + BLOCK_OFFSETS[server];
  if (port > end) {
    throw new Error(
      `The worktree port block ${start}-${end} has no port for the ${server} Playwright server; ` +
        `it needs at least ${Math.max(...Object.values(BLOCK_OFFSETS)) + 1} ports.`,
    );
  }
  return port;
}
