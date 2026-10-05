import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, constants, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { downloadVerifiedAsset } from "./release-assets.js";
import { ReleaseStaging, stagingFilesystem, type StagingFilesystem } from "./release-staging.js";

const bytes = Buffer.from("inert fixture");
const asset = { name: "wollipog-runner-x86_64-unknown-linux-gnu", size: bytes.length,
  digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, url: "https://fixture.invalid/runner" };
type Opened = { fd: number; path: string; flags: number; closes: number };

/** Real fixture bytes, virtual foreign reuse: never allocate or touch a real foreign fd. */
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "wollipog-retire-descriptor-"));
  const handles = new Map<number, Opened>();
  const generations: Opened[] = [];
  const foreign = new Set<number>();
  const staleOperations: string[] = [];
  let closeFault: (handle: Opened) => boolean = () => false;
  let statFault: (handle: Opened) => boolean = () => false;
  let faults = 0;
  let release = true;
  const owned = (fd: number, operation: string): Opened => {
    if (foreign.has(fd)) {
      staleOperations.push(operation);
      throw new Error(`fixture foreign descriptor ${operation}`);
    }
    const handle = handles.get(fd);
    assert.ok(handle, `fixture owns descriptor for ${operation}`);
    return handle;
  };
  const fs: StagingFilesystem = {
    ...stagingFilesystem,
    open: (...args) => {
      const fd = stagingFilesystem.open(...args);
      assert.equal(foreign.has(fd), false, "no staging open follows the injected reuse");
      assert.equal(typeof args[1], "number");
      const handle = { fd, path: String(args[0]), flags: args[1] as number, closes: 0 };
      handles.set(fd, handle); generations.push(handle);
      return fd;
    },
    close: (fd) => {
      const handle = owned(fd, "close");
      handle.closes++;
      if (closeFault(handle)) {
        faults++;
        if (release) { stagingFilesystem.close(fd); handles.delete(fd); }
        foreign.add(fd);
        throw Object.assign(new Error("fixture close EIO"), { code: "EIO" });
      }
      stagingFilesystem.close(fd); handles.delete(fd);
    },
    fstat: (fd) => {
      const handle = owned(fd, "fstat");
      if (statFault(handle)) throw new Error("fixture identity failure");
      return stagingFilesystem.fstat(fd);
    },
    sync: (fd) => { owned(fd, "sync"); stagingFilesystem.sync(fd); },
    read: ((...args: Parameters<typeof stagingFilesystem.read>) => {
      owned(args[0], "read"); return stagingFilesystem.read(...args);
    }) as typeof stagingFilesystem.read,
    write: ((...args: Parameters<typeof stagingFilesystem.write>) => {
      owned(args[0], "write"); return stagingFilesystem.write(...args);
    }) as typeof stagingFilesystem.write,
  };
  t.after(() => {
    // Only fixture teardown owns deliberately unreleased custom-adapter handles.
    for (const fd of handles.keys()) stagingFilesystem.close(fd);
    rmSync(root, { recursive: true, force: true });
  });
  return { root, fs, handles, generations, staleOperations,
    failClose: (predicate: typeof closeFault, releaseBeforeError = true) => { closeFault = predicate; release = releaseBeforeError; },
    failStat: (predicate: typeof statFault) => { statFault = predicate; },
    create: () => ReleaseStaging.create(root, { mode: "user", serviceUid: null }, "v1.2.3", [asset], fs),
    verify: (expectedFaults = 1, unreleased = 0) => {
      assert.equal(faults, expectedFaults, "the requested close faults occurred");
      assert.deepEqual(staleOperations, [], "no operation targets virtual foreign reuse");
      assert.equal(handles.size, unreleased, "all other descriptors reached closure");
      assert.ok(generations.length > 0);
      for (const handle of generations) assert.equal(handle.closes, 1, `one close attempt per open generation: ${handle.path}`);
    },
  };
}

const reader = (handle: Opened) => handle.path.endsWith(".partial") &&
  (handle.flags & (constants.O_WRONLY | constants.O_RDWR)) === constants.O_RDONLY;
const linux = { skip: process.platform !== "linux" };

test("handoff close errors retire writers and temporary readers before virtual number reuse", linux, async (t) => {
  for (const phase of ["writer", "reader", "both", "unreleased-writer"]) await t.test(phase, async (t) => {
    const f = fixture(t);
    const staging = f.create();
    const destination = join(staging.path, asset.name);
    if (phase === "reader") f.failStat(reader);
    f.failClose((handle) => handle.path.endsWith(".partial") &&
      (phase === "both" || (phase === "reader" ? reader(handle) : !reader(handle))), phase !== "unreleased-writer");
    await assert.rejects(downloadVerifiedAsset(async (_url, sink) => { sink.end(bytes); }, asset, destination, { staging }));
    assert.equal(existsSync(destination), false, "failed writer handoff never publishes");
    const retained = readdirSync(staging.path);
    assert.match(staging.finish()!, /uncertain/u);
    assert.deepEqual(readdirSync(staging.path), retained, "uncertainty preserves the owner and partial evidence");
    assert.equal(staging.finish(), null, "repeated cleanup does nothing");
    assert.throws(() => staging.beforeMove(destination), /uncertain|unavailable/u);
    f.verify(phase === "both" ? 2 : 1, phase === "unreleased-writer" ? 1 : 0);
  });
});

test("read-only handoff closes the original writer before inert execution and pins the moved inode", linux, async (t) => {
  const f = fixture(t);
  const staging = f.create();
  const destination = join(staging.path, asset.name);
  await downloadVerifiedAsset(async (_url, sink) => { sink.end(bytes); }, asset, destination, { staging });
  const writer = f.generations.find((handle) => handle.path.endsWith(".partial") && !reader(handle))!;
  const readers = [...f.handles.values()].filter(reader);
  assert.equal(writer.closes, 1, "writer closure precedes any execution authority");
  assert.equal(readers.length, 1);
  assert.equal(stagingFilesystem.fstat(readers[0]!.fd).ino, stagingFilesystem.lstat(destination).ino);
  staging.executable(destination, () => {
    // Permission mutation only; no subprocess/native executable fixture.
    assert.equal(writer.closes, 1);
    chmodSync(destination, 0o755);
  });
  staging.beforeMove(destination);
  const installed = join(f.root, "installed-fixture");
  renameSync(destination, installed);
  staging.moved(destination);
  assert.equal(stagingFilesystem.fstat(readers[0]!.fd).ino, stagingFilesystem.lstat(installed).ino);
  assert.deepEqual(readFileSync(installed), bytes);
  assert.equal(staging.finish(), null);
  assert.equal(staging.finish(), null);
  f.verify(0);
});

test("every cleanup descriptor retires once while other handles drain after release-plus-error", linux, (t) => {
  for (const retained of [false, true]) for (const phase of ["owner", "partial", "data", "slot", "parent", "all-final"]) {
    const f = fixture(t);
    const staging = f.create();
    const partial = staging.createPartial(asset, join(staging.path, asset.name));
    f.fs.write(partial.fd, bytes, 0, bytes.length);
    if (retained) writeFileSync(join(staging.path, "unknown"), "preserved", { mode: 0o600 });
    const matches = (handle: Opened) => phase === "owner" ? handle.path.endsWith("/owner.json") :
      phase === "partial" ? handle.path.endsWith(".partial") : phase === "data" ? handle.path === f.root :
      phase === "slot" ? handle.path === staging.path : phase === "parent" ? handle.path === join(f.root, "upgrades") :
      handle.path.endsWith("/owner.json") || handle.path.endsWith(".partial") || handle.path === f.root;
    f.failClose(matches);
    const before = readdirSync(staging.path);
    assert.match(staging.finish()!, /closure failed|uncertain|retained/u, `${phase}/${retained}`);
    if (retained) {
      assert.deepEqual(readdirSync(staging.path), before);
      assert.deepEqual(readFileSync(partial.path), bytes);
      assert.equal(readFileSync(join(staging.path, "unknown"), "utf8"), "preserved");
    }
    assert.equal(staging.finish(), null);
    f.verify(phase === "all-final" ? 3 : 1);
  }
});

test("published read-only receipts retire after final close errors without repeating cleanup", linux, async (t) => {
  for (const retained of [false, true]) {
    const f = fixture(t);
    const staging = f.create();
    const destination = join(staging.path, asset.name);
    await downloadVerifiedAsset(async (_url, sink) => { sink.end(bytes); }, asset, destination, { staging });
    f.failClose(reader);
    if (retained) writeFileSync(join(staging.path, "unknown"), "preserved", { mode: 0o600 });
    assert.match(staging.finish()!, /closure failed|retained/u);
    assert.equal(existsSync(destination), retained);
    if (retained) assert.deepEqual(readFileSync(destination), bytes);
    assert.equal(staging.finish(), null);
    f.verify();
  }
});

test("failed initialization and pinning retire local descriptors without stale cleanup authority", linux, (t) => {
  for (const phase of ["data", "data-substitution", "parent", "slot", "owner", "partial"]) {
    const f = fixture(t);
    const matches = (handle: Opened) => phase.startsWith("data") ? handle.path === f.root :
      phase === "parent" ? handle.path === join(f.root, "upgrades") :
      phase === "slot" ? handle.path.endsWith("/download-attempt-v1") :
      phase === "owner" ? handle.path.endsWith("/owner.json") : handle.path.endsWith(".partial");
    f.failClose(matches);
    if (phase === "partial") {
      const staging = f.create();
      f.failStat(matches);
      assert.throws(() => staging.createPartial(asset, join(staging.path, asset.name)), /fixture close EIO/u);
      assert.match(staging.finish()!, /uncertain/u);
      assert.equal(staging.finish(), null);
      assert.ok(readdirSync(staging.path).some((name) => name.endsWith(".partial")));
    } else {
      if (phase === "data-substitution") {
        const fstat = f.fs.fstat;
        f.fs.fstat = (fd) => {
          const stat = fstat(fd);
          return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { ino: stat.ino + 1n }) as typeof stat;
        };
      } else f.failStat(matches);
      assert.throws(f.create, /fixture close EIO/u);
      if (phase === "parent") assert.ok(existsSync(join(f.root, "upgrades")));
      if (phase === "slot" || phase === "owner") assert.ok(existsSync(join(f.root, "upgrades", "download-attempt-v1")));
    }
    f.verify();
  }
});
