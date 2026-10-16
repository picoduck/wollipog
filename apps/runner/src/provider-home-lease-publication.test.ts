import assert from "node:assert/strict";
import { linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { ProviderHomeLeaseRegistry } from "./provider-home-lease.js";

const temporary = ".provider-home-lease-11111111-1111-4111-8111-111111111111.tmp";

function snapshotInput(root: string): Buffer {
  const path = Buffer.from(root);
  const frame = Buffer.alloc(30 + path.length);
  frame.write("WPLL4");
  frame.writeUInt32LE(process.pid, 6);
  frame.writeUInt32LE(131_072, 10);
  frame.writeBigUInt64LE(268_435_456n, 14);
  frame.writeUInt32LE(path.length, 26);
  path.copy(frame, 30);
  return frame;
}

test("native snapshots tolerate publication staging cleanup and writes (#2414)", {
  skip: process.platform === "win32" ? "the POSIX lease helper is required" : false,
  timeout: 30_000,
}, (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-native-publication-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const registry = new ProviderHomeLeaseRegistry("a".repeat(64));
  registry.acquireHome(home);
  registry.releaseAll();
  const root = join(home, ".agent-manager", "provider-home-leases-v1");
  const source = readFileSync(new URL("../native/provider-home-lease-io.c", import.meta.url), "utf8");
  for (const change of ["cleanup", "descriptor-cleanup", "opened-cleanup", "write", "canonical-cleanup"] as const) {
    const enumeration = change === "cleanup" || change === "canonical-cleanup";
    const name = change === "canonical-cleanup" ? "mutable-home.recovery.json" : temporary;
    const seam = enumeration
      ? "    values[offset + count] = read_entry(dir, item->d_name); if (values[offset + count].name) count++; errno = 0;"
      : change === "descriptor-cleanup"
      ? "  require(fstat(fd, &before) == 0 && S_ISREG(before.st_mode) && before.st_size >= 0 && before.st_size <= MAX_FILE &&"
      : "  int named_status = fstatat(directory(dir), name, &named, AT_SYMLINK_NOFOLLOW);";
    assert.ok(source.includes(seam), "the fixed native publication seam must match");
    const action = enumeration
      ? `    if (!dir && !strcmp(item->d_name, "${name}")) require(unlinkat(root_fd, item->d_name, 0) == 0, "fixture cleanup failed");\n`
      : change === "opened-cleanup" || change === "descriptor-cleanup"
      ? `  if (!dir && !strcmp(name, "${temporary}")) require(unlinkat(root_fd, name, 0) == 0, "fixture cleanup failed");\n`
      : `  if (!dir && !strcmp(name, "${temporary}")) { int writer = openat(root_fd, name, O_WRONLY | O_TRUNC | O_NOFOLLOW); require(writer >= 0 && write(writer, "changed", 7) == 7, "fixture write failed"); close(writer); }\n`;
    const path = join(home, `${change}.c`);
    const executable = join(home, change);
    writeFileSync(path, source.replace(seam, action + seam));
    const compiled = spawnSync(process.platform === "darwin" ? "/usr/bin/clang" : "/usr/bin/cc",
      ["-Os", "-std=c11", "-Wall", "-Wextra", "-Werror", path, "-o", executable],
      { encoding: "utf8", timeout: 20_000 });
    assert.equal(compiled.status, 0, compiled.stderr);
    writeFileSync(join(root, temporary), "unfinished publication", { mode: 0o600 });
    const result = spawnSync(executable, [], { input: snapshotInput(root), timeout: 5_000 });
    assert.equal(result.status, change === "canonical-cleanup" ? 1 : 0, `${change}: ${result.stdout?.subarray(6).toString()}`);
    assert.equal(result.stdout?.[0], change === "canonical-cleanup" ? 69 : 83, `${change}: canonical evidence stays mandatory`);
    if (change === "write") assert.equal(readFileSync(join(root, temporary), "utf8"), "changed", "the concurrent write ran");
    if (change === "canonical-cleanup") continue;
    rmSync(join(root, temporary), { force: true });
    assert.equal(registry.acquireHome(home), true, "the canonical journal remains usable");
    registry.releaseAll();
  }
});

test("a crashed publisher staging alias remains recoverable (#2414)", (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-publication-alias-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const owner = "a".repeat(64);
  const crashed = new ProviderHomeLeaseRegistry(owner, {
    pid: 101, hostname: "synthetic-host",
    afterInitializationPublishForTest: () => { throw new Error("synthetic crash before mkdir"); },
  });
  assert.throws(() => crashed.acquireHome(home), /quarantine the entire/);
  const root = join(home, ".agent-manager", "provider-home-leases-v1");
  const anchor = join(root, "mutable-home.recovery.json");
  // A crash after exclusive publication but before unlinking leaves the immutable inode aliased.
  linkSync(anchor, join(root, temporary));
  const registry = new ProviderHomeLeaseRegistry(owner, {
    pid: 202, hostname: "synthetic-host", isProcessAlive: (pid) => pid === 202,
  });
  assert.equal(registry.acquireHome(home), true, "recovery preserves the published staging witness");
  assert.deepEqual(registry.getDiagnostics(), [], "checkpointing retains canonical mirror preimages");
  const competitor = new ProviderHomeLeaseRegistry(owner, {
    pid: 303, hostname: "synthetic-host", isProcessAlive: (pid) => pid === 202,
  });
  assert.throws(() => competitor.acquireHome(home), /already in use by process 202/);
  assert.equal(registry.releaseAll(), true);
  assert.equal(competitor.acquireHome(home), true);
  assert.equal(competitor.releaseAll(), true);
});
