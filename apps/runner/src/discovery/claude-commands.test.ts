import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { ExecResult } from "./resolve.js";
import type { SessionMeta } from "../session-store.js";
import {
  CLAUDE_COMMAND_LIMITS,
  assertClaudeCommandPathContained,
  claudeSlashCommandProvenance,
  discoverClaudeSlashCommands,
  includeClaudeUserCommandsForTarget,
  mergeClaudeSlashCommands,
  parseClaudeCommandMetadata,
  prepareClaudeSlashCommandCatalog,
  refreshClaudeSlashCommandCatalog,
  wslAbsolutePathToUnc,
} from "./claude-commands.js";

const roots: string[] = [];

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `wollipog-claude-commands-${label}-`));
  roots.push(root);
  return root;
}

function command(root: string, relative: string, contents: string): void {
  const path = join(root, ".claude", "commands", relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

function sessionMeta(root: string, overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: "session",
    agentId: "claude",
    workspaceId: "workspace",
    repoPath: root,
    worktreePath: null,
    driver: "claude-code",
    command: "claude",
    args: [],
    env: {},
    context: { kind: "native" },
    agentSessionId: null,
    status: "starting",
    title: "session",
    config: {},
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    preview: null,
    pendingApproval: null,
    seq: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function executionTarget(adapter: "host" | "container" | "cloud", id = adapter): NonNullable<SessionMeta["executionTarget"]> {
  return {
    id,
    runnerId: "runner",
    kind: adapter === "cloud" ? "cloud" : adapter === "container" ? "container" : "local",
    workspaceStrategy: adapter === "host" ? "in_place" : "worktree",
    adapter,
    boundaries: {
      filesystem: adapter === "host" ? "host" : adapter === "container" ? "container" : "snapshot",
      network: "inherit",
      secrets: "runner_local",
      process: adapter === "container" ? "container" : adapter === "cloud" ? "remote" : "host",
    },
  } as NonNullable<SessionMeta["executionTarget"]>;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("metadata parser reads bounded documented frontmatter and falls back to the first body line", () => {
  assert.deepEqual(parseClaudeCommandMetadata([
    "---",
    "description: \"Review the current change\\ncarefully\"",
    "argument-hint: '[scope] [--fix]'",
    "ignored: !!js/function boom",
    "---",
    "Do something else",
  ].join("\n")), {
    description: "Review the current change carefully",
    argumentHint: "[scope] [--fix]",
  });
  assert.deepEqual(parseClaudeCommandMetadata("\uFEFF\n# Deploy the current branch\n\nRun it."), {
    description: "Deploy the current branch",
  });
});

test("metadata parser supports bounded block scalars and ignores unterminated frontmatter", () => {
  assert.deepEqual(parseClaudeCommandMetadata([
    "---",
    "description: >",
    "  Review the change",
    "  and report risks.",
    "argument-hint: |",
    "  <base>",
    "  [path]",
    "---",
    "body",
  ].join("\n")), {
    description: "Review the change and report risks.",
    argumentHint: "<base> [path]",
  });
  assert.deepEqual(parseClaudeCommandMetadata("---\ndescription: must not escape\nbody"), {
    description: "description: must not escape",
  });
});

test("metadata output and input reads are character and byte bounded", () => {
  const description = "\u{1F986}".repeat(CLAUDE_COMMAND_LIMITS.maxDescriptionCharacters + 20);
  const hint = "x".repeat(CLAUDE_COMMAND_LIMITS.maxArgumentHintCharacters + 20);
  const parsed = parseClaudeCommandMetadata(`---\ndescription: ${description}\nargument-hint: ${hint}\n---\nbody`);
  assert.equal([...(parsed.description ?? "")].length, CLAUDE_COMMAND_LIMITS.maxDescriptionCharacters);
  assert.equal(parsed.argumentHint?.length, CLAUDE_COMMAND_LIMITS.maxArgumentHintCharacters);

  const oversizedFrontmatter = `---\n${"padding: x\n".repeat(CLAUDE_COMMAND_LIMITS.maxFrontmatterLines + 1)}description: hidden\n---\nbody`;
  assert.notEqual(parseClaudeCommandMetadata(oversizedFrontmatter).description, "hidden");
});

test("native discovery uses worktreePath, enriches nested commands, and personal shadows project", async () => {
  const home = tempRoot("home");
  const repo = tempRoot("repo");
  const worktree = tempRoot("worktree");
  command(home, "review.md", "---\ndescription: Personal review\nargument-hint: <path>\n---\nPrompt");
  command(home, "ops/deploy.md", "Deploy from the personal account");
  command(home, "z/deploy.md", "Later personal duplicate");
  command(repo, "repo-only.md", "This must never be read");
  command(worktree, "review.md", "---\ndescription: Project review\n---\nPrompt");
  command(worktree, "_scratch.md", "Scratch command");
  command(worktree, "safe name.md", "invalid filename");
  command(worktree, "ops/test.md", "# Test the project");

  const result = await discoverClaudeSlashCommands(
    { context: { kind: "native" }, repoPath: repo, worktreePath: worktree },
    { nativeHome: () => home },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.commands, [
    { name: "_scratch", source: "project", description: "Scratch command" },
    { name: "deploy", source: "user", description: "Deploy from the personal account" },
    { name: "review", source: "user", description: "Personal review", argumentHint: "<path>" },
    { name: "test", source: "project", description: "Test the project" },
  ]);
});

test("native discovery uses repoPath only when worktreePath is nullish", async () => {
  const home = tempRoot("home");
  const repo = tempRoot("repo");
  command(repo, "project.md", "Project command");
  const result = await discoverClaudeSlashCommands(
    { context: { kind: "native" }, repoPath: repo, worktreePath: null },
    { nativeHome: () => home },
  );
  assert.deepEqual(result, {
    ok: true,
    commands: [{ name: "project", source: "project", description: "Project command" }],
  });
});

test("remote execution scope discovers project commands without reading the host user catalog", async () => {
  const home = tempRoot("remote-home");
  const repo = tempRoot("remote-repo");
  command(home, "personal.md", "Host-only command");
  command(repo, "project.md", "Mounted project command");
  const result = await discoverClaudeSlashCommands(
    { context: { kind: "native" }, repoPath: repo, includeUserCommands: false },
    { nativeHome: () => home },
  );
  assert.deepEqual(result, {
    ok: true,
    commands: [{ name: "project", source: "project", description: "Mounted project command" }],
  });
});

test("container and cloud targets select project-only command discovery", () => {
  assert.equal(includeClaudeUserCommandsForTarget(undefined), true);
  assert.equal(includeClaudeUserCommandsForTarget("host"), true);
  assert.equal(includeClaudeUserCommandsForTarget("container"), false);
  assert.equal(includeClaudeUserCommandsForTarget("cloud"), false);
});

test("catalog provenance covers provider, context, exact root, target, user scope, and handoff", () => {
  const root = tempRoot("provenance");
  const meta = sessionMeta(root, {
    context: { kind: "wsl", distro: "Alpine" },
    worktreePath: "/worktree",
    executionTarget: executionTarget("cloud", "cloud-a"),
    executionHandoff: { manifestDigest: "manifest-a" } as SessionMeta["executionHandoff"],
  });
  assert.deepEqual(claudeSlashCommandProvenance(meta), {
    driver: "claude-code",
    context: "wsl:Alpine",
    root: "/worktree",
    targetAdapter: "cloud",
    targetId: "cloud-a",
    includeUserCommands: false,
    handoffManifestDigest: "manifest-a",
  });
});

test("mismatched provider or root never retains a prior command catalog on discovery failure", async () => {
  const oldRoot = tempRoot("old-root");
  const newRoot = tempRoot("new-root");
  command(newRoot, "blocked.md", "Blocked");
  const prior = sessionMeta(oldRoot, {
    sessionSlashCommands: [{ name: "stale", source: "user" }],
  });
  prior.sessionSlashCommandProvenance = claudeSlashCommandProvenance(prior);

  const changedProvider = sessionMeta(oldRoot, {
    driver: "codex",
    sessionSlashCommands: prior.sessionSlashCommands,
    sessionSlashCommandProvenance: prior.sessionSlashCommandProvenance,
  });
  await prepareClaudeSlashCommandCatalog(changedProvider);
  assert.equal(changedProvider.sessionSlashCommands, undefined);
  assert.equal(changedProvider.sessionSlashCommandProvenance, undefined);

  const changedRoot = sessionMeta(newRoot, {
    sessionSlashCommands: prior.sessionSlashCommands,
    sessionSlashCommandProvenance: prior.sessionSlashCommandProvenance,
  });
  const result = await prepareClaudeSlashCommandCatalog(changedRoot, {
    nativeHome: () => tempRoot("new-home"),
    beforeNativeDirectoryRead: () => { throw Object.assign(new Error("I/O failure"), { code: "EIO" }); },
  });
  assert.equal(result.outcome, "discarded");
  assert.equal(changedRoot.sessionSlashCommands, undefined);
  assert.equal(changedRoot.sessionSlashCommandProvenance, undefined);
});

test("host to container becomes project-only and host to cloud becomes authoritative empty", async () => {
  const home = tempRoot("target-home");
  const repo = tempRoot("target-repo");
  command(home, "personal.md", "Personal command");
  command(repo, "project.md", "Project command");
  const host = sessionMeta(repo, {
    sessionSlashCommands: [{ name: "personal", source: "user" }],
  });
  host.sessionSlashCommandProvenance = claudeSlashCommandProvenance(host);

  const container = sessionMeta(repo, {
    executionTarget: executionTarget("container", "container-a"),
    sessionSlashCommands: host.sessionSlashCommands,
    sessionSlashCommandProvenance: host.sessionSlashCommandProvenance,
  });
  assert.equal((await prepareClaudeSlashCommandCatalog(container, { nativeHome: () => home })).outcome, "updated");
  assert.deepEqual(container.sessionSlashCommands, [
    { name: "project", source: "project", description: "Project command" },
  ]);
  assert.equal(container.sessionSlashCommandProvenance?.includeUserCommands, false);

  const cloud = sessionMeta(repo, {
    executionTarget: executionTarget("cloud", "cloud-a"),
    sessionSlashCommands: host.sessionSlashCommands,
    sessionSlashCommandProvenance: host.sessionSlashCommandProvenance,
  });
  const cloudResult = await prepareClaudeSlashCommandCatalog(cloud, {
    run: async () => { throw new Error("cloud discovery must not touch the host or WSL"); },
    nativeHome: () => { throw new Error("cloud discovery must not read host HOME"); },
  });
  assert.equal(cloudResult.outcome, "cleared");
  assert.deepEqual(cloud.sessionSlashCommands, []);
  assert.equal(cloud.sessionSlashCommandProvenance?.targetAdapter, "cloud");
});

test("a changed cloud handoff digest invalidates retained provenance", async () => {
  const repo = tempRoot("handoff-repo");
  command(repo, "blocked.md", "Blocked");
  const meta = sessionMeta(repo, {
    executionTarget: executionTarget("container", "container-a"),
    executionHandoff: { manifestDigest: "new" } as SessionMeta["executionHandoff"],
    sessionSlashCommands: [{ name: "stale", source: "project" }],
  });
  meta.sessionSlashCommandProvenance = {
    ...claudeSlashCommandProvenance(meta),
    handoffManifestDigest: "old",
  };
  const result = await prepareClaudeSlashCommandCatalog(meta, {
    beforeNativeDirectoryRead: () => { throw Object.assign(new Error("I/O failure"), { code: "EIO" }); },
  });
  assert.equal(result.outcome, "discarded");
  assert.equal(meta.sessionSlashCommands, undefined);
});

test("same-source case-only collisions have a deterministic exact-name survivor", () => {
  assert.deepEqual(mergeClaudeSlashCommands([
    { name: "review", source: "user", description: "lower user" },
    { name: "Review", source: "user", description: "upper user" },
    { name: "deploy", source: "project", description: "lower project" },
    { name: "Deploy", source: "project", description: "upper project" },
  ]), [
    { name: "Deploy", source: "project", description: "upper project" },
    { name: "Review", source: "user", description: "upper user" },
  ]);
});

test("native traversal is bounded by directory count", async () => {
  const home = tempRoot("home");
  const repo = tempRoot("repo");
  const commandsRoot = join(repo, ".claude", "commands");
  mkdirSync(commandsRoot, { recursive: true });
  for (let index = 0; index <= CLAUDE_COMMAND_LIMITS.maxDirectoriesPerSource; index += 1) {
    mkdirSync(join(commandsRoot, `d-${String(index).padStart(3, "0")}`));
  }
  command(repo, `d-${String(CLAUDE_COMMAND_LIMITS.maxDirectoriesPerSource).padStart(3, "0")}/too-deep.md`, "Not reached");
  const result = await discoverClaudeSlashCommands(
    { context: { kind: "native" }, repoPath: repo },
    { nativeHome: () => home },
  );
  assert.deepEqual(result, { ok: true, commands: [] });
});

test("native per-directory truncation deterministically keeps ordinal-lowest entries", async () => {
  const home = tempRoot("home");
  const repo = tempRoot("entry-order");
  for (let index = CLAUDE_COMMAND_LIMITS.maxEntriesPerDirectory; index >= 0; index -= 1) {
    command(repo, `command-${String(index).padStart(4, "0")}.md`, `Command ${index}`);
  }
  const result = await discoverClaudeSlashCommands(
    { context: { kind: "native" }, repoPath: repo },
    { nativeHome: () => home },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.commands.length, CLAUDE_COMMAND_LIMITS.maxFilesPerSource);
  assert.equal(result.commands[0]?.name, "command-0000");
  assert.equal(result.commands.at(-1)?.name, "command-0255");
});

function execResult(overrides: Partial<ExecResult> = {}): ExecResult {
  return { code: 0, stdout: "", stderr: "", ...overrides };
}

test("WSL discovery uses only HOME argv plus the UNC provider and preserves special paths", async () => {
  const home = tempRoot("wsl-home");
  const repo = tempRoot("wsl-project");
  command(home, "ops/review.md", "Personal description");
  command(repo, "team/review.md", "Project description");
  const calls: { file: string; args: string[] }[] = [];
  const mappings: Array<[string, string]> = [];
  const distro = "Ubuntu Dev; echo nope";
  const project = "/work/space's/$repo";
  const result = await discoverClaudeSlashCommands(
    { context: { kind: "wsl", distro }, repoPath: "/wrong", worktreePath: project },
    {
      run: async (file, args) => {
        calls.push({ file, args });
        return execResult({ stdout: "/home/me\n" });
      },
      wslPathToWindows: (mappedDistro, path) => {
        mappings.push([mappedDistro, path]);
        return path.startsWith("/home/me") ? join(home, ".claude", "commands") : join(repo, ".claude", "commands");
      },
    },
  );
  assert.deepEqual(result, {
    ok: true,
    commands: [{ name: "review", source: "user", description: "Personal description" }],
  });
  assert.deepEqual(calls, [{ file: "wsl.exe", args: ["-d", distro, "--exec", "printenv", "HOME"] }]);
  assert.deepEqual(mappings, [
    [distro, "/home/me/.claude/commands"],
    [distro, `${project}/.claude/commands`],
  ]);
});

test("WSL UNC mapping is exact, BusyBox-independent, and fails closed on ambiguous names", () => {
  assert.equal(
    wslAbsolutePathToUnc("Alpine-3.19", "/work/space's/$repo/.claude/commands"),
    "\\\\wsl.localhost\\Alpine-3.19\\work\\space's\\$repo\\.claude\\commands",
  );
  for (const [distro, path] of [
    ["bad/share", "/repo"],
    ["bad:name", "/repo"],
    ["Alpine", "/repo/../outside"],
    ["Alpine", "/repo/back\\slash"],
  ]) assert.throws(() => wslAbsolutePathToUnc(distro!, path!), /cannot be represented|normalized/);
});

test("WSL nested basename collisions are deterministic and personal commands override project", async () => {
  const home = tempRoot("wsl-collision-home");
  const repo = tempRoot("wsl-collision-repo");
  command(home, "z/deploy.md", "Z personal");
  command(home, "a/deploy.md", "A personal");
  command(repo, "a/deploy.md", "A project");
  const result = await discoverClaudeSlashCommands(
    { context: { kind: "wsl", distro: "Alpine" }, repoPath: "/repo" },
    {
      run: async () => execResult({ stdout: "/home/me\n" }),
      wslPathToWindows: (_distro, path) => path.startsWith("/home/me")
        ? join(home, ".claude", "commands")
        : join(repo, ".claude", "commands"),
    },
  );
  assert.deepEqual(result, {
    ok: true,
    commands: [{ name: "deploy", source: "user", description: "A personal" }],
  });
});

test("native and UNC-backed WSL traversal share one aggregate hard deadline", async () => {
  for (const context of [{ kind: "native" as const }, { kind: "wsl" as const, distro: "Alpine" }]) {
    const home = tempRoot(`deadline-${context.kind}-home`);
    const repo = tempRoot(`deadline-${context.kind}-repo`);
    command(repo, "slow.md", "Slow command");
    const started = performance.now();
    const result = await discoverClaudeSlashCommands(
      { context, repoPath: context.kind === "native" ? repo : "/repo", includeUserCommands: false },
      {
        nativeDiscoveryTimeoutMs: 20,
        wslDiscoveryTimeoutMs: 20,
        run: async () => execResult({ stdout: "/home/me\n" }),
        wslPathToWindows: () => join(repo, ".claude", "commands"),
        beforeNativeCommandRead: () => new Promise<void>((resolve) => setTimeout(resolve, 35)),
      },
    );
    const elapsed = performance.now() - started;
    assert.equal(result.ok, false);
    assert.ok(elapsed < 250, `aggregate ${context.kind} deadline took ${elapsed}ms`);
  }
});

test("WSL HOME probe timeouts and process errors retain the prior catalog", async () => {
  const previous = [{ name: "known-good", source: "user" as const }];
  for (const failure of [
    execResult({ code: 1, timedOut: true }),
    execResult({ code: 1, errorCode: "ENOENT" }),
    execResult({ code: 1, stderr: "transport failed" }),
  ]) {
    const refreshed = await refreshClaudeSlashCommandCatalog(
      previous,
      { context: { kind: "wsl", distro: "Alpine" }, repoPath: "/repo" },
      { run: async () => failure },
    );
    assert.equal(refreshed.outcome, "retained");
    assert.equal(refreshed.commands, previous);
  }
});

test("native discovery follows stable linked personal and project roots through their canonical targets", async () => {
  const home = tempRoot("linked-home");
  const repo = tempRoot("linked-repo");
  const personal = tempRoot("linked-personal");
  const project = tempRoot("linked-project");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(repo, ".claude"), { recursive: true });
  writeFileSync(join(personal, "shared.md"), "Personal command", "utf8");
  writeFileSync(join(personal, "personal.md"), "Personal only", "utf8");
  writeFileSync(join(project, "shared.md"), "Project command", "utf8");
  writeFileSync(join(project, "project.md"), "Project only", "utf8");
  symlinkSync(personal, join(home, ".claude", "commands"), process.platform === "win32" ? "junction" : "dir");
  symlinkSync(project, join(repo, ".claude", "commands"), process.platform === "win32" ? "junction" : "dir");

  const result = await discoverClaudeSlashCommands(
    { context: { kind: "native" }, repoPath: repo },
    { nativeHome: () => home },
  );
  assert.deepEqual(result, {
    ok: true,
    commands: [
      { name: "personal", source: "user", description: "Personal only" },
      { name: "project", source: "project", description: "Project only" },
      { name: "shared", source: "user", description: "Personal command" },
    ],
  });
});

test("native discovery rejects a linked command root retargeted between identity capture and canonicalization", async () => {
  const repo = tempRoot("linked-race-repo");
  const first = tempRoot("linked-race-first");
  const second = tempRoot("linked-race-second");
  mkdirSync(join(repo, ".claude"), { recursive: true });
  writeFileSync(join(first, "safe.md"), "Safe command", "utf8");
  writeFileSync(join(second, "outside.md"), "Outside command", "utf8");
  const commandsRoot = join(repo, ".claude", "commands");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  symlinkSync(first, commandsRoot, linkType);
  let swapped = false;

  const result = await discoverClaudeSlashCommands(
    { context: { kind: "native" }, repoPath: repo, includeUserCommands: false },
    {
      beforeNativeRootRealpath: (path) => {
        if (path !== commandsRoot) return;
        swapped = true;
        rmSync(commandsRoot, { force: true });
        symlinkSync(second, commandsRoot, linkType);
      },
    },
  );
  assert.equal(swapped, true);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /root changed/);
});

test("native discovery rejects a linked command root retargeted after canonical traversal", async () => {
  const repo = tempRoot("linked-late-race-repo");
  const first = tempRoot("linked-late-race-first");
  const second = tempRoot("linked-late-race-second");
  mkdirSync(join(repo, ".claude"), { recursive: true });
  writeFileSync(join(first, "safe.md"), "Safe command", "utf8");
  writeFileSync(join(second, "outside.md"), "Outside command", "utf8");
  const commandsRoot = join(repo, ".claude", "commands");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  symlinkSync(first, commandsRoot, linkType);
  let swapped = false;

  const result = await discoverClaudeSlashCommands(
    { context: { kind: "native" }, repoPath: repo, includeUserCommands: false },
    {
      beforeNativeCommandRead: (path) => {
        if (path !== join(first, "safe.md")) return;
        swapped = true;
        rmSync(commandsRoot, { force: true });
        symlinkSync(second, commandsRoot, linkType);
      },
    },
  );
  assert.equal(swapped, true);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /root changed/);
});

test("native discovery rejects a command root replaced between lstat and realpath", async () => {
  const home = tempRoot("root-race-home");
  const repo = tempRoot("root-race-repo");
  const external = tempRoot("root-race-external");
  command(repo, "safe.md", "Safe command");
  writeFileSync(join(external, "outside.md"), "Outside command", "utf8");
  const commandsRoot = join(repo, ".claude", "commands");
  let swapped = false;
  const result = await discoverClaudeSlashCommands(
    { context: { kind: "native" }, repoPath: repo, includeUserCommands: false },
    {
      beforeNativeRootRealpath: (path) => {
        if (path !== commandsRoot) return;
        swapped = true;
        rmSync(commandsRoot, { recursive: true, force: true });
        symlinkSync(external, commandsRoot, process.platform === "win32" ? "junction" : "dir");
      },
    },
  );
  assert.equal(swapped, true);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /root changed/);
});

test("a command root removed after lstat is a failed refresh, not an authoritative empty catalog", async () => {
  const repo = tempRoot("removed-root-repo");
  command(repo, "known.md", "Known command");
  const commandsRoot = join(repo, ".claude", "commands");
  const previous = [{ name: "known", source: "project" as const, description: "Known command" }];
  const result = await refreshClaudeSlashCommandCatalog(
    previous,
    { context: { kind: "native" }, repoPath: repo, includeUserCommands: false },
    {
      beforeNativeRootRealpath: (path) => {
        if (path === commandsRoot) rmSync(commandsRoot, { recursive: true, force: true });
      },
    },
  );
  assert.equal(result.outcome, "retained");
  assert.equal(result.commands, previous);
});

test("late native resource acquisition cannot delay the hard deadline and is closed when it arrives", async () => {
  const repo = tempRoot("late-resource-repo");
  command(repo, "safe.md", "Safe command");
  for (const resource of ["directory", "file"] as const) {
    let closes = 0;
    const started = performance.now();
    const result = await discoverClaudeSlashCommands(
      { context: { kind: "native" }, repoPath: repo, includeUserCommands: false },
      {
        nativeDiscoveryTimeoutMs: 200,
        ...(resource === "directory"
          ? {
              openNativeDirectory: async () => {
                await new Promise((resolve) => setTimeout(resolve, 400));
                return { close: async () => { closes += 1; } } as never;
              },
            }
          : {
              openNativeFile: async () => {
                await new Promise((resolve) => setTimeout(resolve, 400));
                return { close: async () => { closes += 1; } } as never;
              },
            }),
      },
    );
    assert.equal(result.ok, false, resource);
    assert.ok(performance.now() - started < 750, `${resource} exceeded the hard launch budget`);
    assert.equal(closes, 0, `${resource} had not arrived at timeout`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(closes, 1, `${resource} ownership was released`);
  }
});

test("a never-settling filesystem operation respects the launch budget and retains only matching provenance", async () => {
  const repo = tempRoot("never-settling-repo");
  command(repo, "known.md", "Known command");
  const previous = [{ name: "known", source: "project" as const, description: "Known command" }];
  const never = new Promise<never>(() => {});
  const deps = {
    nativeDiscoveryTimeoutMs: 20,
    openNativeDirectory: () => never,
  };

  const retained = sessionMeta(repo, {
    executionTarget: executionTarget("container", "container-a"),
    sessionSlashCommands: previous,
  });
  retained.sessionSlashCommandProvenance = claudeSlashCommandProvenance(retained);
  let started = performance.now();
  const retainedResult = await prepareClaudeSlashCommandCatalog(retained, deps);
  assert.ok(performance.now() - started < 250, "matching refresh exceeded the hard launch budget");
  assert.equal(retainedResult.outcome, "retained");
  assert.equal(retained.sessionSlashCommands, previous);

  const discarded = sessionMeta(repo, {
    executionTarget: executionTarget("container", "container-a"),
    sessionSlashCommands: previous,
  });
  discarded.sessionSlashCommandProvenance = {
    ...claudeSlashCommandProvenance(discarded),
    root: `${repo}-stale`,
  };
  started = performance.now();
  const discardedResult = await prepareClaudeSlashCommandCatalog(discarded, deps);
  assert.ok(performance.now() - started < 250, "mismatched refresh exceeded the hard launch budget");
  assert.equal(discardedResult.outcome, "discarded");
  assert.equal(discarded.sessionSlashCommands, undefined);
  assert.equal(discarded.sessionSlashCommandProvenance, undefined);
});

test("WSL containment remains case-sensitive for case-differing siblings", () => {
  const root = join("virtual", "repo", "A");
  assert.doesNotThrow(() => assertClaudeCommandPathContained(root, join(root, "safe.md"), true));
  assert.throws(
    () => assertClaudeCommandPathContained(root, join("virtual", "repo", "a", "outside.md"), true),
    /escaped/,
  );
});

test("native discovery rejects an enumeration-to-open intermediate directory swap", async () => {
  const home = tempRoot("swap-home");
  const repo = tempRoot("swap-repo");
  const external = tempRoot("swap-external");
  command(repo, "safe.md", "Safe command");
  writeFileSync(join(external, "safe.md"), "Outside command", "utf8");
  const commandsRoot = join(repo, ".claude", "commands");
  let swapped = false;

  const result = await discoverClaudeSlashCommands(
    { context: { kind: "native" }, repoPath: repo },
    {
      nativeHome: () => home,
      beforeNativeCommandRead: (path) => {
        if (swapped || path !== join(commandsRoot, "safe.md")) return;
        swapped = true;
        rmSync(commandsRoot, { recursive: true, force: true });
        symlinkSync(external, commandsRoot, process.platform === "win32" ? "junction" : "dir");
      },
    },
  );
  assert.equal(swapped, true);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /escaped|symlink|junction/);
});

test("native discovery rejects an enumeration-to-open final-component link swap", async () => {
  const home = tempRoot("final-home");
  const repo = tempRoot("final-repo");
  const external = tempRoot("final-external");
  command(repo, "safe.md", "Safe command");
  const commandPath = join(repo, ".claude", "commands", "safe.md");
  let swapped = false;
  const result = await discoverClaudeSlashCommands(
    { context: { kind: "native" }, repoPath: repo },
    {
      nativeHome: () => home,
      beforeNativeCommandRead: (path) => {
        if (path !== commandPath) return;
        swapped = true;
        rmSync(path, { force: true });
        symlinkSync(external, path, process.platform === "win32" ? "junction" : "dir");
      },
    },
  );
  assert.equal(swapped, true);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /regular in-root file/);
});

test("UNC-backed WSL discovery rejects final and intermediate link escapes", async () => {
  for (const mode of ["final", "intermediate"] as const) {
    const home = tempRoot(`wsl-${mode}-home`);
    const repo = tempRoot(`wsl-${mode}-repo`);
    const external = tempRoot(`wsl-${mode}-external`);
    const commandsRoot = join(repo, ".claude", "commands");
    mkdirSync(commandsRoot, { recursive: true });
    command(repo, mode === "final" ? "safe.md" : "ops/safe.md", "Safe command");
    writeFileSync(join(external, "safe.md"), "Outside command", "utf8");
    const expectedFile = join(commandsRoot, mode === "intermediate" ? "ops" : "", "safe.md");
    const result = await discoverClaudeSlashCommands(
      { context: { kind: "wsl", distro: "Alpine" }, repoPath: "/repo", includeUserCommands: false },
      {
        run: async () => execResult({ stdout: "/home/me\n" }),
        wslPathToWindows: () => commandsRoot,
        beforeNativeCommandRead: (path) => {
          if (path !== expectedFile) return;
          if (mode === "final") {
            rmSync(path, { force: true });
            symlinkSync(external, path, process.platform === "win32" ? "junction" : "dir");
          } else {
            const parent = join(commandsRoot, "ops");
            rmSync(parent, { recursive: true, force: true });
            symlinkSync(external, parent, process.platform === "win32" ? "junction" : "dir");
          }
        },
      },
    );
    assert.equal(result.ok, false, mode);
  }
});

test("permission-denied descendant directories are skipped while a denied root stays atomic", async () => {
  const home = tempRoot("denied-home");
  const repo = tempRoot("denied-repo");
  command(repo, "kept.md", "Readable command");
  command(repo, "blocked/hidden.md", "Hidden command");
  const commandsRoot = join(repo, ".claude", "commands");
  const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
  const skipped = await discoverClaudeSlashCommands(
    { context: { kind: "native" }, repoPath: repo },
    {
      nativeHome: () => home,
      beforeNativeDirectoryRead: (path) => {
        if (path === join(commandsRoot, "blocked")) throw denied;
      },
    },
  );
  assert.deepEqual(skipped, {
    ok: true,
    commands: [{ name: "kept", source: "project", description: "Readable command" }],
  });
  const failed = await discoverClaudeSlashCommands(
    { context: { kind: "native" }, repoPath: repo, includeUserCommands: false },
    { beforeNativeDirectoryRead: () => { throw denied; } },
  );
  assert.equal(failed.ok, false);
});

test("transient native file disappearance is skipped without discarding readable commands", async () => {
  const home = tempRoot("transient-home");
  const repo = tempRoot("transient-repo");
  command(repo, "gone.md", "Gone command");
  command(repo, "kept.md", "Readable command");
  const gone = join(repo, ".claude", "commands", "gone.md");
  const result = await discoverClaudeSlashCommands(
    { context: { kind: "native" }, repoPath: repo },
    {
      nativeHome: () => home,
      beforeNativeCommandRead: (path) => {
        if (path === gone) rmSync(path, { force: true });
      },
    },
  );
  assert.deepEqual(result, {
    ok: true,
    commands: [{ name: "kept", source: "project", description: "Readable command" }],
  });
});

test("missing command directories are an explicit successful empty discovery", async () => {
  const home = tempRoot("home");
  const repo = tempRoot("repo");
  assert.deepEqual(await discoverClaudeSlashCommands(
    { context: { kind: "native" }, repoPath: repo },
    { nativeHome: () => home },
  ), { ok: true, commands: [] });
});

test("refresh clears on explicit empty and retains the exact prior catalog on discovery failure", async () => {
  const home = tempRoot("home");
  const repo = tempRoot("repo");
  const previous = [{ name: "known-good", source: "user" as const, description: "Last good value" }];

  const cleared = await refreshClaudeSlashCommandCatalog(
    previous,
    { context: { kind: "native" }, repoPath: repo },
    { nativeHome: () => home },
  );
  assert.deepEqual(cleared, { outcome: "cleared", commands: [] });

  const retained = await refreshClaudeSlashCommandCatalog(
    previous,
    { context: { kind: "wsl", distro: "Missing" }, repoPath: "/repo" },
    { run: async () => execResult({ code: 1, stderr: "WSL is unavailable" }) },
  );
  assert.equal(retained.outcome, "retained");
  assert.equal(retained.commands, previous, "failure must preserve the prior array and its metadata");
  assert.match(retained.outcome === "retained" ? retained.error : "", /WSL is unavailable/);
});

test("a non-transient UNC-backed WSL file read failure is atomic", async () => {
  const home = tempRoot("wsl-atomic-home");
  const repo = tempRoot("wsl-atomic-repo");
  command(home, "first.md", "First");
  command(home, "second.md", "Second");
  let reads = 0;
  const result = await discoverClaudeSlashCommands(
    { context: { kind: "wsl", distro: "Alpine" }, repoPath: "/repo" },
    {
      run: async () => execResult({ stdout: "/home/me\n" }),
      wslPathToWindows: (_distro, path) => path.startsWith("/home/me")
        ? join(home, ".claude", "commands")
        : join(repo, ".claude", "commands"),
      beforeNativeCommandRead: () => {
        reads += 1;
        if (reads === 2) throw Object.assign(new Error("I/O error"), { code: "EIO" });
      },
    },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /I\/O error/);
});
