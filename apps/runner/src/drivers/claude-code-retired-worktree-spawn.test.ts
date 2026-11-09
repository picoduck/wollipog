import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { buildBwrapArgs, type BwrapSpawnIsolation } from "../spawn.js";
import type { ManagedWorktreeProtection } from "../managed-worktree-protection.js";
import { CLAUDE_PERSISTENT_FLAG, ClaudeCodeDriver } from "./claude-code.js";
import type { DriverOptions } from "./driver.js";
import { isolationWithoutRetiredWorktrees } from "./retired-worktree-isolation.js";

// A provider whose bwrap boundary binds a sibling worktree keeps that bind list for every later spawn
// (#3402). The session manager relaunches it once the sibling is retired, but under #4210 that
// relaunch stands aside while the live process's background work is unfinished. The session's
// `backgroundWorkState` stays `continuation_pending` after every task has ended and before the
// continuation runs, so in that window the driver's own task list is empty: a model, effort or
// permission-mode change then respawned Claude from the stored binds, bwrap refused the removed
// sibling, and the person's turn failed.

const nextTask = () => new Promise<void>((resolve) => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 6; i += 1) await nextTask(); };

function fakeProcess() {
  const child = new EventEmitter() as any;
  child.pid = 4210;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}

/** Render the bwrap argv as the real launcher would and refuse a missing bind source, as bwrap does. */
function bwrapRefusesMissingSources(options: any): void {
  const args = buildBwrapArgs(options, options.isolation as BwrapSpawnIsolation);
  for (let index = 0; index < args.length; index += 1) {
    if ((args[index] === "--bind" || args[index] === "--ro-bind") && !existsSync(args[index + 1]!)) {
      throw new Error(`bwrap: Can't find source path ${args[index + 1]}: No such file or directory`);
    }
  }
}

function fixture() {
  // Not under the host's /tmp: the sandbox mounts a private writable tmpfs there, so a sibling under
  // it could never lose its overlays (see the last test).
  const root = mkdtempSync(join(process.cwd(), ".claude-retired-sibling-"));
  const parent = join(root, "worktrees");
  const selected = join(parent, "selected");
  const sibling = join(parent, "sibling");
  const common = join(root, "repo.git");
  const selectedAdmin = join(common, "worktrees", "selected");
  const siblingAdmin = join(common, "worktrees", "sibling");
  const objects = join(common, "objects");
  const transcript = join(root, "transcripts");
  for (const dir of [selected, sibling, selectedAdmin, siblingAdmin, objects, transcript]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(selected, ".git"), `gitdir: ${selectedAdmin}\n`);
  writeFileSync(join(sibling, ".git"), `gitdir: ${siblingAdmin}\n`);
  writeFileSync(join(siblingAdmin, "gitdir"), `${sibling}/.git\n`);
  const isolation: BwrapSpawnIsolation = {
    backend: "bwrap",
    command: "/usr/bin/bwrap",
    args: [],
    network: "inherit",
    writableBinds: [
      { source: transcript, target: transcript },
      { source: sibling, target: sibling },
    ],
    protectedWorktree: {
      parent,
      path: selected,
      gitWritableRoots: [selectedAdmin, objects, siblingAdmin],
      ownedWorktrees: [{ path: sibling, gitAdmin: siblingAdmin }],
    },
    readOnlyBinds: [join(selected, ".git"), join(sibling, ".git"), join(siblingAdmin, "gitdir")],
  };
  let protections: ManagedWorktreeProtection[] = [
    { worktreePath: selected, repoPath: "/repo" },
    { worktreePath: sibling, repoPath: "/repo" },
  ];
  const launches: any[] = [];
  const children: any[] = [];
  const stderr: string[] = [];
  const make = (opts: Partial<DriverOptions> = {}) => new ClaudeCodeDriver({
    command: "claude", args: [], cwd: selected, env: { [CLAUDE_PERSISTENT_FLAG]: "1" },
    config: { model: "sonnet" }, context: { kind: "native" } as DriverOptions["context"],
    isolation, managedWorktreeProtections: () => protections, ...opts,
  }, { onEvent() {}, onStderr: (text) => stderr.push(text), onExit() {} }, {
    spawn: (options: any) => {
      launches.push(options);
      bwrapRefusesMissingSources(options);
      const child = fakeProcess();
      if (options.args.includes("--tools")) {
        // The resume usage probe: a local command that reports the restored totals and exits.
        const at = options.args.indexOf("--resume");
        const id = options.args[at + 1];
        child.stdin.once("data", () => {
          child.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: id }) + "\n");
          child.stdout.write(JSON.stringify({ type: "result", subtype: "success", session_id: id, total_cost_usd: 0 }) + "\n");
          setImmediate(() => child.emit("close", 0));
        });
        return child;
      }
      children.push(child);
      return child;
    },
    kill: () => {},
  } as any);
  const write = (child: any, frame: unknown) => child.stdout.write(JSON.stringify(frame) + "\n");
  return {
    root, selected, sibling, siblingAdmin, isolation, launches, children, stderr, make, write,
    /** Discard the sibling: its row goes, then its files. */
    retire() {
      protections = protections.filter((protection) => protection.worktreePath !== sibling);
      rmSync(sibling, { recursive: true, force: true });
      rmSync(siblingAdmin, { recursive: true, force: true });
    },
    /** Release the sibling's row only; its directory stays on disk. */
    unmanage() {
      protections = protections.filter((protection) => protection.worktreePath !== sibling);
    },
    restoreRow() {
      protections = [...protections, { worktreePath: sibling, repoPath: "/repo" }];
    },
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

const names = (isolation: BwrapSpawnIsolation, ...paths: string[]) =>
  paths.some((path) => JSON.stringify(isolation).includes(path));
/** Whether any writable mount (or owned-worktree entry) still names one of the paths. */
const writableNames = (isolation: BwrapSpawnIsolation, ...paths: string[]) => paths.some((path) =>
  JSON.stringify([isolation.writableBinds, isolation.protectedWorktree?.gitWritableRoots,
    isolation.protectedWorktree?.ownedWorktrees]).includes(path));

/** One turn on the live process that starts a watcher, then the watcher ends: the driver's own task
 * list is empty again while the session still owes the watcher's continuation. */
async function turnWithFinishedWatcher(f: ReturnType<typeof fixture>, driver: ClaudeCodeDriver): Promise<void> {
  const first = driver.prompt("start a watcher");
  await settle();
  const child = f.children.at(-1);
  f.write(child, { type: "system", subtype: "task_started", task_id: "watcher" });
  f.write(child, { type: "result", subtype: "success" });
  assert.equal(await first, "end_turn");
  f.write(child, { type: "system", subtype: "task_notification", task_id: "watcher", status: "completed" });
  await settle();
}

test("a model change after the live process's watcher ends respawns without the retired sibling (#4210 follow-up)", async () => {
  const f = fixture();
  const driver = f.make();
  try {
    await turnWithFinishedWatcher(f, driver);
    assert.equal(f.launches.length, 1);
    assert.equal(f.launches[0].isolation, f.isolation, "a launch with every sibling present uses the stored isolation");

    f.retire();
    driver.setConfig({ model: "opus" });
    const second = driver.prompt("the person's turn under the new model");
    await settle();
    f.children[0].emit("close", 0);
    await settle();
    assert.equal(f.launches.length, 2, "the model change respawns the provider");
    // Before the fix bwrap refused the retired bind here, so no process started and the turn failed.
    if (f.children[1]) f.write(f.children[1], { type: "result", subtype: "success" });
    assert.equal(await second, "end_turn", "the person's turn runs");
    const respawn = f.launches[1];
    assert.ok(respawn.args.includes("opus"), "the person's model change is applied, not deferred");
    assert.equal(names(respawn.isolation, f.sibling, f.siblingAdmin), false, "no bind names the retired sibling");
    assert.ok(f.stderr.some((text) => text.includes(`leaves out retired worktree ${f.sibling}`)));
  } finally {
    driver.dispose({ forceImmediate: true });
    f.cleanup();
  }
});

test("the resume usage probe ahead of that respawn leaves the retired sibling out too", async () => {
  const f = fixture();
  const driver = f.make({ resumeId: "11111111-2222-3333-4444-555555555555", agentVersion: "2.1.296" });
  try {
    await turnWithFinishedWatcher(f, driver);
    assert.ok(f.launches[0].args.includes("--tools"), "a resumed launch probes its usage baseline first");
    assert.equal(f.launches.length, 2);

    f.retire();
    driver.setConfig({ model: "opus", effort: "high" });
    const second = driver.prompt("the person's turn under the new effort");
    await settle();
    f.children[0].emit("close", 0);
    await settle();
    assert.equal(f.launches.length, 4, "a probe, then the respawn");
    assert.ok(f.launches[2].args.includes("--tools"));
    for (const launch of f.launches.slice(2)) {
      assert.equal(names(launch.isolation, f.sibling, f.siblingAdmin), false);
    }
    f.write(f.children[1], { type: "result", subtype: "success" });
    assert.equal(await second, "end_turn");
  } finally {
    driver.dispose({ forceImmediate: true });
    f.cleanup();
  }
});

test("a one-shot turn after the sibling is retired leaves it out", async () => {
  const f = fixture();
  const driver = f.make({ env: { [CLAUDE_PERSISTENT_FLAG]: "0" } });
  try {
    const first = driver.prompt("one");
    await settle();
    f.write(f.children[0], { type: "result", subtype: "success" });
    f.children[0].emit("close", 0);
    assert.equal(await first, "end_turn");

    f.retire();
    const second = driver.prompt("two");
    await settle();
    assert.equal(f.launches.length, 2);
    assert.equal(names(f.launches[1].isolation, f.sibling, f.siblingAdmin), false);
    f.write(f.children[1], { type: "result", subtype: "success" });
    f.children[1].emit("close", 0);
    assert.equal(await second, "end_turn");
  } finally {
    driver.dispose({ forceImmediate: true });
    f.cleanup();
  }
});

test("a sibling the session no longer manages loses its writable binds even while its directory remains", async () => {
  const f = fixture();
  const driver = f.make({ env: { [CLAUDE_PERSISTENT_FLAG]: "0" } });
  try {
    f.unmanage();
    const turn = driver.prompt("one");
    await settle();
    assert.equal(writableNames(f.launches[0].isolation, f.sibling, f.siblingAdmin), false);
    assert.deepEqual(f.launches[0].isolation.readOnlyBinds, f.isolation.readOnlyBinds,
      "its read-only overlays stay while their sources exist");
    f.write(f.children[0], { type: "result", subtype: "success" });
    f.children[0].emit("close", 0);
    assert.equal(await turn, "end_turn");
  } finally {
    driver.dispose({ forceImmediate: true });
    f.cleanup();
  }
});

test("a sibling left out stays out when its path reappears: only a fresh launch proves a new bind", async () => {
  const f = fixture();
  const driver = f.make({ env: { [CLAUDE_PERSISTENT_FLAG]: "0" } });
  try {
    f.retire();
    const first = driver.prompt("one");
    await settle();
    f.write(f.children[0], { type: "result", subtype: "success" });
    f.children[0].emit("close", 0);
    assert.equal(await first, "end_turn");

    mkdirSync(f.sibling, { recursive: true });
    mkdirSync(f.siblingAdmin, { recursive: true });
    writeFileSync(join(f.sibling, ".git"), `gitdir: ${f.siblingAdmin}\n`);
    writeFileSync(join(f.siblingAdmin, "gitdir"), `${f.sibling}/.git\n`);
    f.restoreRow();
    const second = driver.prompt("two");
    await settle();
    assert.equal(writableNames(f.launches[1].isolation, f.sibling, f.siblingAdmin), false);
    assert.deepEqual(f.launches[1].isolation.readOnlyBinds, f.isolation.readOnlyBinds);
    f.write(f.children[1], { type: "result", subtype: "success" });
    f.children[1].emit("close", 0);
    assert.equal(await second, "end_turn");
  } finally {
    driver.dispose({ forceImmediate: true });
    f.cleanup();
  }
});

test("a sibling that is still managed and present stays bound on every spawn", async () => {
  const f = fixture();
  const driver = f.make({ env: { [CLAUDE_PERSISTENT_FLAG]: "0" } });
  try {
    for (const label of ["one", "two"]) {
      const turn = driver.prompt(label);
      await settle();
      f.write(f.children.at(-1), { type: "result", subtype: "success" });
      f.children.at(-1).emit("close", 0);
      assert.equal(await turn, "end_turn");
    }
    assert.equal(f.launches.length, 2);
    for (const launch of f.launches) assert.equal(launch.isolation, f.isolation);
  } finally {
    driver.dispose({ forceImmediate: true });
    f.cleanup();
  }
});

test("leaving a retired worktree out removes exactly its writable binds and its missing overlays", () => {
  const f = fixture();
  try {
    const sibling = [{ path: f.sibling, gitAdmin: f.siblingAdmin }];
    const { protectedWorktree } = f.isolation;
    const narrowed = {
      backend: "bwrap",
      command: "/usr/bin/bwrap",
      args: [],
      network: "inherit",
      writableBinds: [f.isolation.writableBinds![0]],
      protectedWorktree: {
        parent: protectedWorktree!.parent,
        path: protectedWorktree!.path,
        gitWritableRoots: protectedWorktree!.gitWritableRoots.slice(0, 2),
      },
    };
    // Its files still exist: every read-only overlay stays, since dropping one only widens.
    assert.deepEqual(isolationWithoutRetiredWorktrees(f.isolation, sibling),
      { ...narrowed, readOnlyBinds: f.isolation.readOnlyBinds });
    // Once removed, an overlay of a missing source would make bwrap refuse the launch.
    f.retire();
    assert.deepEqual(isolationWithoutRetiredWorktrees(f.isolation, sibling),
      { ...narrowed, readOnlyBinds: [join(f.selected, ".git")] });
    assert.equal(isolationWithoutRetiredWorktrees(f.isolation, []), f.isolation);
    // A "retired" root that holds the selected worktree is never removed: the provider runs there.
    assert.deepEqual(
      isolationWithoutRetiredWorktrees(f.isolation, [{ path: protectedWorktree!.parent, gitAdmin: "/nowhere" }]),
      f.isolation,
    );
  } finally {
    f.cleanup();
  }
});

/** The mount that decides whether `path` is writable in a rendered bwrap argv: the last one covering it. */
function decidingMount(args: string[], path: string): string | undefined {
  let mount: string | undefined;
  for (let index = 0; index < args.length && args[index] !== "--"; index += 1) {
    const operands = args[index] === "--bind" || args[index] === "--ro-bind" ? 2 : args[index] === "--tmpfs" ? 1 : 0;
    if (!operands) continue;
    const target = args[index + operands]!;
    if (target === "/" || path === target || path.startsWith(`${target}/`)) mount = args[index];
  }
  return mount;
}

test("a retired sibling that a retained writable mount still covers never loses its read-only overlays", () => {
  const f = fixture();
  try {
    // A requested-worktree boundary, separate from the selected worktree's parent, holds a sibling.
    const boundary = join(f.root, "requested");
    const sibling = join(boundary, "sibling");
    const admin = join(f.root, "repo.git", "worktrees", "covered");
    mkdirSync(sibling, { recursive: true });
    mkdirSync(admin, { recursive: true });
    writeFileSync(join(sibling, ".git"), `gitdir: ${admin}\n`);
    writeFileSync(join(admin, "gitdir"), `${sibling}/.git\n`);
    const base = f.isolation.protectedWorktree!;
    const isolation: BwrapSpawnIsolation = {
      ...f.isolation,
      writableBinds: [...f.isolation.writableBinds!, { source: boundary, target: boundary }, { source: sibling, target: sibling }],
      protectedWorktree: { ...base, gitWritableRoots: [...base.gitWritableRoots, admin],
        ownedWorktrees: [...base.ownedWorktrees!, { path: sibling, gitAdmin: admin }] },
      readOnlyBinds: [...f.isolation.readOnlyBinds!, join(sibling, ".git"), join(admin, "gitdir")],
    };
    const covered = [{ path: sibling, gitAdmin: admin }];
    const render = (spawn: BwrapSpawnIsolation) => buildBwrapArgs({ command: "claude", args: [], cwd: f.selected }, spawn);
    assert.equal(decidingMount(render(isolation), join(sibling, ".git")), "--ro-bind");

    // Still on disk: the overlay stays read-only, whatever the transform keeps.
    const present = isolationWithoutRetiredWorktrees(isolation, covered) as BwrapSpawnIsolation;
    assert.equal(decidingMount(render(present), join(sibling, ".git")), "--ro-bind");
    // Removed: its overlays could only go by leaving the path writable through the boundary, so the
    // stored isolation is used unchanged, as before this change.
    rmSync(sibling, { recursive: true, force: true });
    rmSync(admin, { recursive: true, force: true });
    assert.equal(isolationWithoutRetiredWorktrees(isolation, covered), isolation);
  } finally {
    f.cleanup();
  }
});

for (const path of ["/tmp/retired", "/dev/shm/retired"]) {
  test(`a removed sibling under the sandbox's private ${path.split("/").slice(0, -1).join("/")} never loses its read-only overlays`, () => {
    // bwrap always mounts a writable tmpfs at /tmp and a writable private /dev, so a missing overlay
    // there could be recreated writable inside the sandbox. Paths are illustrative; nothing exists,
    // as `exists` reports.
    const owned = { path, gitAdmin: "/srv/repo.git/worktrees/retired" };
    const isolation: BwrapSpawnIsolation = {
      backend: "bwrap", command: "/usr/bin/bwrap", args: [], network: "inherit",
      writableBinds: [{ source: owned.path, target: owned.path }],
      protectedWorktree: { parent: "/srv/worktrees", path: "/srv/worktrees/selected",
        gitWritableRoots: ["/srv/repo.git/worktrees/selected", owned.gitAdmin], ownedWorktrees: [owned] },
      readOnlyBinds: [`${owned.path}/.git`, `${owned.gitAdmin}/gitdir`],
    };
    const narrowed = isolationWithoutRetiredWorktrees({ ...isolation, readOnlyBinds: [`${owned.gitAdmin}/gitdir`] },
      [owned], () => false) as BwrapSpawnIsolation;
    assert.equal(narrowed.writableBinds, undefined, "an overlay outside the private mount may still go");
    assert.equal(isolationWithoutRetiredWorktrees(isolation, [owned], () => false), isolation);
  });
}
