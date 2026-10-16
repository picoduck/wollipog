// Runs inside the sandbox of agent-control-sandbox-cli.integration.test.ts (#3270): the injected
// CLI with and without its FIFO channel, then each socket a sandbox must refuse, then a write into
// the FIFO channel directory and one into the workspace. Plain JavaScript, so nothing here needs
// the repository's loader. Prints one JSON object.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";

const [controlPlanePort, relayPort, unixSocket, fifoDirectory] = process.argv.slice(2);

const connect = (options) => new Promise((resolve) => {
  const socket = net.connect(options);
  const timer = setTimeout(() => { socket.destroy(); resolve("timeout"); }, 2000);
  socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve("connected"); });
  socket.once("error", (error) => { clearTimeout(timer); resolve(error.code ?? error.message); });
});

const write = (path) => {
  try {
    writeFileSync(path, "probe");
    return "written";
  } catch (error) {
    return error.code;
  }
};

// Under the seccomp filter Node cannot identify a socketpair stdout (getsockopt is refused) and
// silently discards what it writes there, and spawnSync's pipes are socketpairs. A shell command
// substitution reads through a real pipe, as Codex's own command runner and a shell script do.
const cli = (env) => {
  const result = spawnSync("/bin/sh", ["-c",
    'out=$("$WOLLIPOG_CLI" session list --json 2>&1); status=$?; printf "%s\\n%s" "$status" "$out"'],
  { env, encoding: "utf8", timeout: 60000 });
  const newline = result.stdout.indexOf("\n");
  return { status: Number(result.stdout.slice(0, newline)), stdout: result.stdout.slice(newline + 1), stderr: result.stderr };
};

const withoutFifo = { ...process.env };
delete withoutFifo.WOLLIPOG_AGENT_CONTROL_RELAY_FIFO;

process.stdout.write(JSON.stringify({
  cli: cli(process.env),
  cliOverLoopbackRelay: cli(withoutFifo),
  controlPlane: await connect({ host: "127.0.0.1", port: Number(controlPlanePort) }),
  loopbackRelay: await connect({ host: "127.0.0.1", port: Number(relayPort) }),
  unixSocket: await connect({ path: unixSocket }),
  outbound: await connect({ host: "192.0.2.1", port: 9 }),
  fifoDirectoryWrite: write(join(fifoDirectory, "probe-file")),
  workspaceWrite: write(join(process.cwd(), "probe-file")),
}));
