import assert from "node:assert/strict";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { SessionEventPayload } from "@wollipog/protocol";
import { CodexAppServerDriver } from "./drivers/codex-app-server.js";
import { provisionCodexGuard, type ClaudeHookHost } from "./hook-settings.js";

type Json = Record<string, unknown>;

const CODEX = process.env.CODEX_BIN || "codex";
const installedCodex = spawnSync(CODEX, ["--version"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 10_000,
});
const SKIP = process.platform !== "linux"
  ? "the Codex workspace sandbox boundary is Linux-specific"
  : installedCodex.status !== 0
    ? "codex is not installed"
    : false;

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", [
    "-c", "core.hooksPath=/dev/null",
    "-c", "commit.gpgsign=false",
    "-c", "tag.gpgsign=false",
    "-c", "user.email=codex-sandbox@example.invalid",
    "-c", "user.name=Codex Sandbox",
    ...args,
  ], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
}

function message(text: string): Json {
  return {
    type: "message",
    id: "final-message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text }],
  };
}

/** A credential-free local Responses-API provider that asks Codex to run the exact commands. */
function modelServer(commands: readonly string[]): Server {
  let call = 0;
  return createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      // Parse to make malformed provider requests fail visibly rather than advancing the script.
      JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const index = call++;
      const item: Json = index < commands.length
        ? {
            type: "function_call",
            id: `function-${index}`,
            call_id: `call-${index}`,
            name: "exec_command",
            arguments: JSON.stringify({ cmd: commands[index], yield_time_ms: 10_000 }),
            status: "completed",
          }
        : message("finished");
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = (event: string, data: Json) =>
        response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send("response.created", {
        type: "response.created",
        response: { id: `response-${index}`, status: "in_progress", output: [] },
      });
      send("response.output_item.done", { type: "response.output_item.done", output_index: 0, item });
      send("response.completed", {
        type: "response.completed",
        response: { id: `response-${index}`, status: "completed", output: [item] },
      });
      response.end();
    });
  });
}

async function runManagedTurn(integrationIsolation: boolean): Promise<void> {
  const root = mkdtempSync(join(homedir(), ".wollipog-codex-worktree-sandbox-"));
  roots.push(root);
  const repoPath = join(root, "repo");
  const worktreePath = join(root, "worktree");
  const codexHome = join(root, "codex-home");
  const unrelatedHostFile = join(root, "unrelated-host.txt");
  mkdirSync(repoPath, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(repoPath, "tracked.txt"), "base\n");
  writeFileSync(join(repoPath, "primary-only.txt"), "primary\n");
  writeFileSync(unrelatedHostFile, "host\n");
  git(repoPath, ["init", "--quiet", "--initial-branch=main", "."]);
  git(repoPath, ["config", "user.email", "codex-sandbox@example.invalid"]);
  git(repoPath, ["config", "user.name", "Codex Sandbox"]);
  git(repoPath, ["add", "tracked.txt", "primary-only.txt"]);
  git(repoPath, ["commit", "--quiet", "-m", "base"]);
  const branch = `agent/codex-sandbox-${String(integrationIsolation)}`;
  git(repoPath, ["worktree", "add", "--quiet", "-b", branch, worktreePath, "main"]);
  const gitLink = readFileSync(join(worktreePath, ".git"), "utf8");
  const linkedGitDir = realpathSync(resolve(worktreePath, gitLink.trim().replace(/^gitdir: /u, "")));
  const commonDirFile = join(linkedGitDir, "commondir");
  const commonDirLink = readFileSync(commonDirFile, "utf8");
  const gitDirFile = join(linkedGitDir, "gitdir");
  const gitDirLink = readFileSync(gitDirFile, "utf8");
  const nextBranch = `${branch}-next`;

  const commands = [
    "printf 'edited\\n' > tracked.txt",
    "git add tracked.txt",
    "git commit --quiet -m sandboxed",
    `git checkout --quiet -b ${nextBranch}`,
    "git status --porcelain",
    "git branch --show-current",
    "printf corrupt > .git",
    "mv .git .git.stolen",
    "rm -f .git",
    "printf corrupt > .git.tmp && mv .git.tmp .git",
    `printf corrupt > ${JSON.stringify(gitDirFile)}`,
    `rm -f ${JSON.stringify(gitDirFile)}`,
    `mv ${JSON.stringify(gitDirFile)} ${JSON.stringify(`${gitDirFile}.stolen`)}`,
    `printf corrupt > ${JSON.stringify(`${gitDirFile}.tmp`)} && mv ${JSON.stringify(`${gitDirFile}.tmp`)} ${JSON.stringify(gitDirFile)}`,
    `printf corrupt > ${JSON.stringify(commonDirFile)}`,
    `rm -f ${JSON.stringify(commonDirFile)}`,
    `mv ${JSON.stringify(commonDirFile)} ${JSON.stringify(`${commonDirFile}.stolen`)}`,
    `printf corrupt > ${JSON.stringify(`${commonDirFile}.tmp`)} && mv ${JSON.stringify(`${commonDirFile}.tmp`)} ${JSON.stringify(commonDirFile)}`,
    `printf corrupt > ${JSON.stringify(join(repoPath, "primary-only.txt"))}`,
    `printf corrupt > ${JSON.stringify(unrelatedHostFile)}`,
  ];
  const models = modelServer(commands);
  const modelPort = await listen(models);
  writeFileSync(join(codexHome, "config.toml"),
    'model = "probe-model"\nmodel_provider = "probe"\n\n' +
    '[model_providers.probe]\nname = "Probe"\n' +
    `base_url = "http://127.0.0.1:${modelPort}/v1"\n` +
    'wire_api = "responses"\nenv_key = "PROBE_KEY"\n');

  const errors: string[] = [];
  const events: SessionEventPayload[] = [];
  const baseArgs = [
    ...(integrationIsolation
      ? ["--disable", "apps", "--disable", "plugins", "--disable", "hooks"]
      : []),
    "-c", 'mcp_servers.wollipog={command="/bin/true",enabled=true}',
  ];
  const env = { HOME: codexHome, CODEX_HOME: codexHome, PROBE_KEY: "local" };
  const hookHost: ClaudeHookHost = {
    isSea: false,
    execPath: process.execPath,
    // The test runner's own `--test` flags would make every hook sidecar emit TAP after its JSON
    // verdict, which Codex correctly treats as malformed hook output. Production development
    // runners need only their TypeScript loader here; SEA launches carry no Node exec argv.
    execArgv: ["--import", "tsx"],
    scriptPath: fileURLToPath(new URL("./cli.ts", import.meta.url)),
    configDir: join(root, "hooks"),
  };
  const guarded = await provisionCodexGuard({
    sessionId: `s_codex_sandbox_${String(integrationIsolation)}`,
    command: CODEX,
    args: baseArgs,
    env,
    context: { kind: "native" },
  }, {
    protections: [{ worktreePath, repoPath }],
    cwd: worktreePath,
    isolateForeignHooks: integrationIsolation,
  }, (text) => errors.push(text), hookHost);
  assert.equal(guarded.guardActive, true, guarded.reason ?? "managed worktree guard was not active");
  const protections = [{ worktreePath, repoPath }];
  let driver!: CodexAppServerDriver;
  driver = new CodexAppServerDriver({
    command: CODEX,
    args: guarded.args,
    cwd: worktreePath,
    env,
    // `on-request` selects the same App Server workspaceWrite policy without Guardian making
    // independent requests to this deterministic one-client model fixture.
    config: { permissionMode: "on-request" },
    orchestrator: { strictProjectIsolation: false, integrationIsolation },
    context: { kind: "native" },
    managedWorktreeProtections: () => protections,
  }, {
    onEvent: (event) => {
      events.push(event);
      if (event.kind === "permission_request") queueMicrotask(() => driver.resolvePermission(event.requestId, "accept"));
    },
    onStderr: (text) => errors.push(text),
    onExit: () => {},
  });

  try {
    try {
      await driver.initialize();
      await driver.newSession(worktreePath);
      assert.equal(await driver.prompt("Run the scripted worktree checks."), "end_turn", errors.join("\n"));
    } catch (error) {
      throw new Error(`${String(error)}${errors.length ? `\n${errors.join("\n")}` : ""}`);
    }
  } finally {
    driver.dispose();
    models.close();
  }

  const diagnostics = JSON.stringify({ errors, events }, null, 2);
  assert.equal(readFileSync(join(worktreePath, ".git"), "utf8"), gitLink);
  assert.equal(readFileSync(gitDirFile, "utf8"), gitDirLink, diagnostics);
  assert.equal(existsSync(`${gitDirFile}.stolen`), false);
  assert.equal(existsSync(`${gitDirFile}.tmp`), false,
    "the guard rejects the whole registration replacement command before its source is created");
  assert.equal(existsSync(join(worktreePath, ".git.stolen")), false);
  assert.equal(existsSync(join(worktreePath, ".git.tmp")), true,
    "replacement is stopped at the protected destination after creating its harmless source file");
  assert.equal(readFileSync(commonDirFile, "utf8"), commonDirLink, diagnostics);
  assert.equal(existsSync(`${commonDirFile}.stolen`), false);
  assert.equal(existsSync(`${commonDirFile}.tmp`), false,
    "the guard rejects the whole registration replacement command before its source is created");
  assert.equal(git(worktreePath, ["branch", "--show-current"]).trim(), nextBranch, diagnostics);
  assert.match(git(worktreePath, ["log", "-1", "--pretty=%s"]), /sandboxed/u, diagnostics);
  assert.equal(readFileSync(join(worktreePath, "tracked.txt"), "utf8"), "edited\n");
  rmSync(join(worktreePath, ".git.tmp"));
  assert.equal(git(worktreePath, ["status", "--porcelain"]), "");
  assert.match(git(repoPath, ["show-ref", "--verify", "refs/heads/main"]), /^[a-f0-9]+ refs\/heads\/main\n$/u);
  assert.equal(readFileSync(join(repoPath, "primary-only.txt"), "utf8"), "primary\n");
  assert.equal(readFileSync(unrelatedHostFile, "utf8"), "host\n");
  assert.equal(
    events.filter((event) => event.kind === "permission_request").length,
    0,
    diagnostics,
  );
}

for (const integrationIsolation of [false, true]) {
  test(`a real Codex App workspace sandbox supports managed Git work (Integration Isolation ${
    integrationIsolation ? "enabled" : "disabled"})`, {
    skip: SKIP,
    timeout: 120_000,
  }, async () => {
    await runManagedTurn(integrationIsolation);
  });
}
