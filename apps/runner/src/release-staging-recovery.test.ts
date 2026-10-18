import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync,
  writeFileSync, writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { downloadVerifiedAsset, type ReleaseAsset } from "./release-assets.js";
import { ReleaseStaging, stagingFilesystem, type StagingFilesystem } from "./release-staging.js";
import { JOURNAL_DIR, JOURNAL_KEEP, StagingJournal, describeJournal, readJournal, redactDetail, type ProcessIdentity } from "./release-staging-journal.js";
import {
  RECOVERY_DIR, RecoveryRefusedError, findHolders, inspectStaging, procProcesses, recoverStaging, type StagingProcesses,
} from "./release-staging-recovery.js";

const linux = { skip: process.platform !== "linux" };
const UID = process.geteuid?.() ?? 0;
const context = { mode: "user" as const, serviceUid: null };
const now = () => "2026-10-17T12:00:00.000Z";

function release(): { assets: ReleaseAsset[]; bodies: Map<string, Buffer>; manifest: Map<string, string> } {
  const bodies = new Map<string, Buffer>([
    ["wollipog-runner-x86_64-unknown-linux-gnu", Buffer.from("inert runner fixture")],
    ["wollipog-web.tar.gz", Buffer.from("inert web archive fixture")],
  ]);
  const hex = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const manifestText = Buffer.from([...bodies].map(([name, bytes]) => `${hex(bytes)}  ${name}`).join("\n") + "\n");
  bodies.set("SHA256SUMS", manifestText);
  const assets = [...bodies].map(([name, bytes]) => ({ name, size: bytes.length, digest: `sha256:${hex(bytes)}`, url: `https://fixture.invalid/${name}` }));
  return { assets, bodies, manifest: new Map([...bodies].filter(([name]) => name !== "SHA256SUMS").map(([name, bytes]) => [name, hex(bytes)])) };
}

/** A controllable process table: the recovering process is pid 1 and sees only what a test adds. */
function processes() {
  const holders = new Map<number, string[]>();
  const running = new Map<number, ProcessIdentity>();
  const unreadable = new Set<number>();
  const procs: StagingProcesses = {
    self: 1,
    list: () => [1, ...new Set([...holders.keys(), ...running.keys(), ...unreadable])],
    uids: () => [UID, UID, UID, UID],
    links: (pid) => {
      if (unreadable.has(pid)) throw Object.assign(new Error("fixture EACCES"), { code: "EACCES" });
      return holders.get(pid) ?? [];
    },
    identity: (pid) => running.get(pid) ?? null,
    name: (pid) => (unreadable.has(pid) ? "ssh-agent" : null),
  };
  return { procs, holders, running, unreadable };
}

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "wollipog-staging-recovery-"));
  const data = join(root, "data");
  mkdirSync(data, { mode: 0o700 });
  const open: ReleaseStaging[] = [];
  t.after(() => {
    for (const attempt of open) attempt.finish();
    rmSync(root, { recursive: true, force: true });
  });
  const { assets, bodies, manifest } = release();
  const download = async (url: string, sink: NodeJS.WritableStream) => { sink.end(bodies.get(url.replace("https://fixture.invalid/", ""))!); };
  const asset = (name: string) => assets.find((candidate) => candidate.name === name)!;
  const slot = join(data, "upgrades", "download-attempt-v1");
  return {
    root, data, slot, assets, asset, ...processes(),
    /** Start an attempt in this process and abandon it like a killed updater (its handles stay open until teardown). */
    async abandoned(options: { publish?: string[]; partial?: string; moveOut?: string[]; journal?: boolean; holder?: ProcessIdentity; selected?: string[] } = {}) {
      const selected = options.selected ? assets.filter((candidate) => options.selected!.includes(candidate.name)) : assets;
      const attempt = ReleaseStaging.create(data, context, "v0.32.0", selected, stagingFilesystem, options.holder ?? null);
      open.push(attempt);
      if (options.journal) {
        const journal = StagingJournal.open(data, { nonce: attempt.nonce, tag: "v0.32.0", mode: "user", process: { pid: 4242, startTime: "77", bootId: "boot" } }, stagingFilesystem, now);
        journal.note("reserved");
      }
      for (const name of options.publish ?? []) {
        await downloadVerifiedAsset(download, asset(name), join(attempt.path, name), { staging: attempt, manifest: name === "SHA256SUMS" ? null : manifest });
      }
      if (options.partial) {
        const partial = attempt.createPartial(asset(options.partial), join(attempt.path, options.partial));
        writeSync(partial.fd, Buffer.from("half"));
      }
      for (const name of options.moveOut ?? []) {
        const source = join(attempt.path, name);
        attempt.beforeMove(source);
        renameSync(source, join(root, `installed-${name}`));
        attempt.moved(source);
      }
      return attempt;
    },
    inspect(procs?: StagingProcesses) { return inspectStaging(data, context, stagingFilesystem, procs ?? this.procs); },
    recover(token: string, fs: StagingFilesystem = stagingFilesystem, procs?: StagingProcesses, acceptUninspectable = false) {
      return recoverStaging(data, context, token, fs, procs ?? this.procs, now, { acceptUninspectable });
    },
    /** The next update is admitted and retires normally. */
    admitsNext() {
      const next = ReleaseStaging.create(data, context, "v0.33.0", assets, stagingFilesystem);
      assert.equal(next.finish(), null);
    },
  };
}

/** Every name, identity and byte under `path`, to prove an operation changed nothing. */
function snapshot(path: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const stat = lstatSync(full);
      out.push(`${full} ${stat.ino} ${stat.mode} ${stat.size} ${stat.nlink} ${stat.mtimeMs}`);
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile()) out.push(createHash("sha256").update(readFileSync(full)).digest("hex"));
    }
  };
  walk(path);
  return out;
}

test("interruption after publication (the reported 0.32.0 inventory) is inspectable and recoverable without deletion", linux, async (t) => {
  const f = fixture(t);
  await f.abandoned({ publish: ["SHA256SUMS", "wollipog-runner-x86_64-unknown-linux-gnu", "wollipog-web.tar.gz"], moveOut: ["wollipog-runner-x86_64-unknown-linux-gnu"] });
  assert.deepEqual(readdirSync(f.slot).sort(), ["SHA256SUMS", "owner.json", "wollipog-web.tar.gz"]);
  const before = snapshot(f.root);
  const inspection = f.inspect();
  assert.deepEqual(snapshot(f.root), before, "inspection changes nothing");
  assert.equal(inspection.state, "blocked");
  assert.equal(inspection.owner.state, "valid");
  assert.equal(inspection.owner.tag, "v0.32.0");
  assert.equal(inspection.journal.evidence, "absent");
  assert.equal(inspection.journal.outcome, "unknown");
  assert.match(inspection.journal.conclusion, /predates phase journaling.*unknown/u);
  assert.deepEqual(inspection.recovery.reasons, []);
  assert.match(inspection.recovery.token!, /^sa1-[0-9a-f]{32}$/u);
  const preservedBytes = readFileSync(join(f.slot, "wollipog-web.tar.gz"));

  const result = f.recover(inspection.recovery.token!);
  assert.equal(result.admissible, true);
  assert.deepEqual(result.warnings, []);
  assert.equal(existsSync(f.slot), false);
  assert.deepEqual(readdirSync(join(f.data, "upgrades")), [], "the staging parent is empty");
  assert.ok(result.preservedPath.startsWith(join(f.data, RECOVERY_DIR)));
  assert.deepEqual(readdirSync(result.preservedPath).sort(), ["SHA256SUMS", "owner.json", "wollipog-web.tar.gz"]);
  assert.deepEqual(readFileSync(join(result.preservedPath, "wollipog-web.tar.gz")), preservedBytes, "leftovers are preserved byte for byte");
  assert.equal(JSON.parse(readFileSync(join(result.container, "recovery.json"), "utf8")).state, "preserved");
  assert.equal(lstatSync(result.container).mode & 0o777, 0o700);
  f.admitsNext();
  const after = f.inspect();
  assert.equal(after.state, "clear");
  assert.deepEqual(after.preserved.map((entry) => entry.state), ["preserved"]);
});

test("interrupted downloads with a partial are recoverable; interrupted initialization is inspectable but refused", linux, async (t) => {
  await t.test("partial download", async (t) => {
    const f = fixture(t);
    await f.abandoned({ publish: ["SHA256SUMS"], partial: "wollipog-runner-x86_64-unknown-linux-gnu" });
    const inspection = f.inspect();
    assert.ok(inspection.slotEntries!.some((entry) => entry.name.endsWith(".partial")));
    // Even without any phase record, a download still in progress proves nothing was replaced.
    assert.equal(inspection.journal.evidence, "absent");
    assert.equal(inspection.journal.outcome, "pre-installation-failure");
    assert.match(inspection.journal.conclusion, /a download was still in progress.*not replaced/u);
    assert.deepEqual(inspection.recovery.reasons, []);
    f.recover(inspection.recovery.token!);
    f.admitsNext();
  });
  for (const state of ["absent", "incomplete"] as const) await t.test(`owner record ${state}`, async (t) => {
    const f = fixture(t);
    mkdirSync(f.slot, { recursive: true, mode: 0o700 });
    if (state === "incomplete") writeFileSync(join(f.slot, "owner.json"), '{"schema":1,"nonce"', { mode: 0o600 });
    const before = snapshot(f.root);
    const inspection = f.inspect();
    assert.equal(inspection.state, "blocked");
    assert.equal(inspection.owner.state, state);
    assert.equal(inspection.recovery.token, null);
    assert.match(inspection.recovery.reasons.join(" "), /grants no recovery authority/u);
    assert.throws(() => f.recover(`sa1-${"0".repeat(32)}`), (error: Error) => error instanceof RecoveryRefusedError && /no recovery authority/u.test(error.message));
    assert.deepEqual(snapshot(f.root), before, "refusal changes nothing");
    assert.throws(() => f.admitsNext(), /occupied/u);
  });
});

test("unknown, linked, symlinked, substituted and foreign objects stay protected", linux, async (t) => {
  const cases: Record<string, (f: ReturnType<typeof fixture>) => void> = {
    unknown: (f) => writeFileSync(join(f.slot, "notes.txt"), "operator file", { mode: 0o600 }),
    hardlink: (f) => linkSync(join(f.slot, "SHA256SUMS"), join(f.root, "second-name")),
    symlink: (f) => symlinkSync("/etc/passwd", join(f.slot, "wollipog-web.tar.gz")),
    "foreign parent entry": (f) => mkdirSync(join(f.data, "upgrades", "v0.20.0"), { mode: 0o700 }),
    "copied slot": (f) => {
      // Same names and owner bytes in a different directory: pinned identities no longer match.
      renameSync(f.slot, join(f.root, "original"));
      mkdirSync(f.slot, { mode: 0o700 });
      for (const name of readdirSync(join(f.root, "original"))) writeFileSync(join(f.slot, name), readFileSync(join(f.root, "original", name)), { mode: 0o600 });
    },
    "wrong permissions": (f) => { writeFileSync(join(f.slot, "SHA256SUMS"), readFileSync(join(f.slot, "SHA256SUMS")), { mode: 0o644 }); },
    "web without a selected web archive": (f) => mkdirSync(join(f.slot, "web"), { mode: 0o700 }),
  };
  for (const [name, mutate] of Object.entries(cases)) await t.test(name, async (t) => {
    const f = fixture(t);
    await f.abandoned({ publish: ["SHA256SUMS"], ...(name.startsWith("web") ? { selected: ["SHA256SUMS", "wollipog-runner-x86_64-unknown-linux-gnu"] } : {}) });
    mutate(f);
    if (name === "wrong permissions") (await import("node:fs")).chmodSync(join(f.slot, "SHA256SUMS"), 0o644);
    const before = snapshot(f.root);
    const inspection = f.inspect();
    assert.equal(inspection.recovery.eligible, false, name);
    assert.equal(inspection.recovery.token, null);
    assert.ok(inspection.recovery.reasons.length > 0);
    assert.throws(() => f.recover(`sa1-${"0".repeat(32)}`), RecoveryRefusedError);
    assert.deepEqual(snapshot(f.root), before, `${name}: nothing moved or deleted`);
  });
});

test("active attempts and concurrent recoveries are protected; unavailable proof refuses", linux, async (t) => {
  await t.test("a live updater holding the slot", async (t) => {
    const f = fixture(t);
    const attempt = await f.abandoned({ publish: ["SHA256SUMS"] });
    f.holders.set(777, [join(f.slot, "SHA256SUMS")]);
    const inspection = f.inspect();
    assert.equal(inspection.holders.state, "found");
    assert.deepEqual(inspection.holders.pids, [777]);
    assert.equal(inspection.recovery.token, null);
    // A token taken before the updater appeared is refused too.
    f.holders.clear();
    const token = f.inspect().recovery.token!;
    f.holders.set(777, [f.slot]);
    assert.throws(() => f.recover(token), /may still be active/u);
    assert.ok(existsSync(join(f.slot, "owner.json")));
    // The active attempt still completes and retires normally.
    assert.equal(attempt.finish(), null);
    assert.equal(existsSync(f.slot), false);
  });
  await t.test("another recovery holding the parent", async (t) => {
    const f = fixture(t);
    await f.abandoned({ publish: ["SHA256SUMS"] });
    const token = f.inspect().recovery.token!;
    f.holders.set(778, [join(f.data, "upgrades")]);
    assert.throws(() => f.recover(token), /hold.*open/u);
    assert.ok(existsSync(f.slot));
  });
  for (const source of ["owner record", "journal"]) await t.test(`the updater recorded in the ${source} is still running`, async (t) => {
    const f = fixture(t);
    const identity = { pid: 4242, startTime: "77", bootId: "boot" };
    await f.abandoned({ publish: ["SHA256SUMS"], ...(source === "journal" ? { journal: true } : { holder: identity }) });
    f.running.set(4242, identity);
    assert.match(f.inspect().recovery.reasons.join(" "), /4242 .*still running/u);
    // A reused PID with a different start time, or the same one after a reboot, is not the updater.
    f.running.set(4242, { ...identity, startTime: "78" });
    assert.deepEqual(f.inspect().recovery.reasons, []);
    f.running.set(4242, { ...identity, bootId: "next-boot" });
    assert.deepEqual(f.inspect().recovery.reasons, []);
  });
  await t.test("uninspectable same-user processes need a recorded identity or explicit attestation", async (t) => {
    const legacy = fixture(t);
    await legacy.abandoned({ publish: ["SHA256SUMS"] });
    legacy.unreadable.add(900);
    const inspection = legacy.inspect();
    assert.equal(inspection.recovery.eligible, false);
    assert.match(inspection.recovery.acknowledgement!, /1 same-user process could not be inspected \(900 ssh-agent\)/u);
    assert.match(inspection.recovery.reasons.join(" "), /--accept-uninspectable-processes/u);
    const token = inspection.recovery.token!;
    assert.match(token, /^sa1-/u, "the evidence is proven, so the token is offered for an attested recovery");
    assert.throws(() => legacy.recover(token), /could not be inspected/u);
    assert.ok(existsSync(legacy.slot));
    const attested = legacy.recover(token, stagingFilesystem, undefined, true);
    assert.match(JSON.parse(readFileSync(join(attested.container, "recovery.json"), "utf8")).acknowledged, /ssh-agent/u);
    legacy.admitsNext();

    // A recorded updater identity proven gone needs no attestation.
    const recorded = fixture(t);
    await recorded.abandoned({ publish: ["SHA256SUMS"], holder: { pid: 4243, startTime: "1", bootId: "boot" } });
    recorded.unreadable.add(900);
    const proven = recorded.inspect();
    assert.equal(proven.recovery.acknowledgement, null);
    assert.equal(proven.recovery.eligible, true);
    // A readable holder still refuses even with the attestation.
    recorded.holders.set(901, [recorded.slot]);
    assert.throws(() => recorded.recover(proven.recovery.token!, stagingFilesystem, undefined, true), /may still be active/u);

    const unlisted: StagingProcesses = { ...legacy.procs, list: () => { throw new Error("no /proc"); } };
    await legacy.abandoned({ publish: ["SHA256SUMS"] });
    assert.match(legacy.inspect(unlisted).recovery.reasons.join(" "), /process table cannot be listed/u);
    assert.equal(legacy.inspect(unlisted).recovery.token, null);
  });
  await t.test("evidence changed since inspection", async (t) => {
    const f = fixture(t);
    await f.abandoned({ publish: ["SHA256SUMS"], partial: "wollipog-web.tar.gz" });
    const token = f.inspect().recovery.token!;
    appendFileSync(join(f.slot, readdirSync(f.slot).find((name) => name.endsWith(".partial"))!), "more");
    assert.throws(() => f.recover(token), /token does not match/u);
    assert.ok(existsSync(f.slot));
    assert.throws(() => f.recover("not-a-token"), /malformed/u);
  });
  await t.test("the preservation directory renamed during recovery", async (t) => {
    const f = fixture(t);
    await f.abandoned({ publish: ["SHA256SUMS", "wollipog-runner-x86_64-unknown-linux-gnu"], journal: true });
    const inspection = f.inspect();
    // Staged executables can remain while a swap has already moved a live executable aside.
    assert.equal(inspection.journal.outcome, "unknown", "retained staged executables do not prove the installation is untouched");
    const displaced = join(f.data, "displaced");
    const racing: StagingFilesystem = { ...stagingFilesystem, rename: (from, to) => {
      stagingFilesystem.rename(from, to);
      if (String(to).endsWith("/recovery.json") && !existsSync(displaced)) renameSync(join(f.data, RECOVERY_DIR), displaced);
    } };
    assert.throws(() => f.recover(inspection.recovery.token!, racing), /was moved or replaced while recovery was preparing; nothing was moved/u);
    assert.ok(existsSync(join(f.slot, "owner.json")), "the attempt stays in place rather than landing in the displaced directory");
  });
  await t.test("a change between preparation and the move", async (t) => {
    const f = fixture(t);
    await f.abandoned({ publish: ["SHA256SUMS"] });
    const token = f.inspect().recovery.token!;
    // The intent record is written just before the final revalidation: an updater appears then.
    const racing: StagingFilesystem = { ...stagingFilesystem, rename: (from, to) => {
      stagingFilesystem.rename(from, to);
      if (String(to).endsWith("/recovery.json")) f.holders.set(779, [f.slot]);
    } };
    assert.throws(() => f.recover(token, racing), /changed while recovery was preparing.*nothing was moved/u);
    assert.ok(existsSync(join(f.slot, "owner.json")));
    assert.deepEqual(f.inspect().preserved.map((entry) => entry.state), ["incomplete"]);
  });
});

test("interruption during recovery leaves either the slot in place or a preserved attempt", linux, async (t) => {
  await t.test("before the move", async (t) => {
    const f = fixture(t);
    await f.abandoned({ publish: ["SHA256SUMS"] });
    const token = f.inspect().recovery.token!;
    const crash: StagingFilesystem = { ...stagingFilesystem, rename: (from, to) => {
      if (String(from).endsWith("/download-attempt-v1")) throw new Error("fixture crash before the move");
      stagingFilesystem.rename(from, to);
    } };
    assert.throws(() => f.recover(token, crash), /fixture crash/u);
    assert.ok(existsSync(join(f.slot, "owner.json")), "the slot is untouched");
    const inspection = f.inspect();
    assert.equal(inspection.preserved[0]!.state, "incomplete");
    assert.match(inspection.preserved[0]!.detail, /before moving the attempt/u);
    assert.equal(inspection.recovery.token, token, "the unchanged attempt keeps its token");
    f.recover(token);
    f.admitsNext();
  });
  await t.test("after the move, before the record is finalized", async (t) => {
    const f = fixture(t);
    await f.abandoned({ publish: ["SHA256SUMS"] });
    const token = f.inspect().recovery.token!;
    let moved = false;
    const crash: StagingFilesystem = { ...stagingFilesystem, rename: (from, to) => {
      if (moved && String(to).endsWith("/recovery.json")) throw new Error("fixture crash before finalizing");
      stagingFilesystem.rename(from, to);
      if (String(from).endsWith("/download-attempt-v1")) moved = true;
    } };
    const result = f.recover(token, crash);
    assert.match(result.warnings.join(" "), /could not be finalized/u);
    assert.equal(result.admissible, true);
    const inspection = f.inspect();
    assert.equal(inspection.state, "clear");
    assert.equal(inspection.preserved[0]!.state, "incomplete");
    assert.match(inspection.preserved[0]!.detail, /moved here/u);
    f.admitsNext();
  });
});

test("the phase journal is bounded, private and distinguishes attempt outcomes", linux, async (t) => {
  const f = fixture(t);
  const nonces: string[] = [];
  for (let i = 0; i < JOURNAL_KEEP + 3; i++) {
    const nonce = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    nonces.push(nonce);
    StagingJournal.open(f.data, { nonce, tag: "v1.0.0", mode: "user", process: null }, stagingFilesystem, now).note("reserved");
  }
  const records = readdirSync(join(f.data, JOURNAL_DIR));
  assert.equal(records.length, JOURNAL_KEEP);
  assert.ok(records.includes(`${nonces.at(-1)}.json`));
  assert.equal(lstatSync(join(f.data, JOURNAL_DIR)).mode & 0o777, 0o700);
  assert.equal(lstatSync(join(f.data, JOURNAL_DIR, records[0]!)).mode & 0o777, 0o600);

  const outcome = (phases: string[]) => {
    const nonce = `11111111-0000-4000-8000-${String(phases.length).padStart(6, "0")}${String(phases.join("").length).padStart(6, "0")}`;
    const journal = StagingJournal.open(f.data, { nonce, tag: "v1.0.0", mode: "user", process: null }, stagingFilesystem, now);
    for (const phase of phases) journal.note(phase as Parameters<typeof journal.note>[0], phase === "cleanup-failed" ? "fixture EBUSY" : undefined);
    return describeJournal(readJournal(f.data, nonce, stagingFilesystem));
  };
  const failed = outcome(["reserved", "failed", "cleaned"]);
  assert.equal(failed.outcome, "pre-installation-failure");
  assert.equal(failed.cleanup, "complete");
  assert.equal(failed.uncertain, false);
  const interrupted = outcome(["reserved", "staged"]);
  assert.equal(interrupted.outcome, "unknown", "best-effort journaling cannot prove an unrecorded installation did not start");
  assert.match(interrupted.conclusion, /may still have been replaced/u);
  assert.equal(interrupted.uncertain, true);
  const awaiting = outcome(["reserved", "staged", "installing", "installed"]);
  assert.equal(awaiting.outcome, "installation-awaiting-verification");
  assert.equal(awaiting.uncertain, true);
  assert.match(awaiting.conclusion, /health verification did not complete/u);
  const cleanupFailed = outcome(["reserved", "staged", "installing", "installed", "verified", "cleanup-failed"]);
  assert.equal(cleanupFailed.outcome, "healthy-installation-cleanup-failed");
  assert.match(cleanupFailed.conclusion, /fixture EBUSY/u);
  const complete = outcome(["reserved", "staged", "installing", "installed", "verified", "cleaned"]);
  assert.equal(complete.outcome, "completed-cleanup");
  assert.equal(complete.cleanup, "complete");
  const rolled = outcome(["reserved", "staged", "installing", "rolled-back", "cleaned"]);
  assert.equal(rolled.outcome, "rolled-back");

  // A journal path that fails validation is never written, at open or later.
  for (const swap of ["symlink at open", "symlink after open", "shared permissions"]) {
    const g = fixture(t);
    const target = join(g.root, "elsewhere");
    mkdirSync(target, { mode: 0o700 });
    const journalPath = join(g.data, JOURNAL_DIR);
    const nonce = "33333333-0000-4000-8000-000000000000";
    if (swap === "symlink at open") symlinkSync(target, journalPath);
    if (swap === "shared permissions") mkdirSync(journalPath, { mode: 0o755 });
    const journal = StagingJournal.open(g.data, { nonce, tag: "v1.0.0", mode: "user", process: null }, stagingFilesystem, now);
    if (swap === "symlink after open") { rmSync(journalPath, { recursive: true }); symlinkSync(target, journalPath); }
    journal.note("reserved");
    assert.ok(journal.problem, swap);
    assert.deepEqual(readdirSync(target), [], `${swap}: nothing is written through the rejected path`);
    if (swap === "shared permissions") assert.deepEqual(readdirSync(journalPath), []);
    assert.doesNotThrow(() => journal.note("installing"), "journal problems never throw into the upgrade");
  }

  writeFileSync(join(f.data, JOURNAL_DIR, `${"2".repeat(8)}-0000-4000-8000-000000000000.json`), '{"schema":1', { mode: 0o600 });
  assert.equal(readJournal(f.data, `${"2".repeat(8)}-0000-4000-8000-000000000000`, stagingFilesystem).state, "unreadable");
  assert.equal(describeJournal(readJournal(f.data, `${"2".repeat(8)}-0000-4000-8000-000000000000`, stagingFilesystem)).uncertain, true);
  assert.equal(redactDetail("failed with token=abc123 and ghp_abcdefghijklmnopqrstuvwxyz0123"), "failed with token=[redacted] and [redacted]");
});

test("a recorded attempt's phases survive recovery in its journal and recovery record", linux, async (t) => {
  const f = fixture(t);
  await f.abandoned({ publish: ["SHA256SUMS"], journal: true });
  const inspection = f.inspect();
  assert.equal(inspection.journal.evidence, "recorded");
  assert.equal(inspection.journal.outcome, "unknown", "the selected runner is neither staged nor downloading, so the slot proves nothing");
  assert.equal(inspection.journal.uncertain, true);
  const result = f.recover(inspection.recovery.token!);
  const journal = describeJournal(readJournal(f.data, result.nonce, stagingFilesystem));
  assert.deepEqual(journal.events.map((event) => event.phase), ["reserved", "recovered"]);
  assert.equal(journal.uncertain, true, "recovery does not make an interrupted attempt look complete");
  const record = JSON.parse(readFileSync(join(result.container, "recovery.json"), "utf8"));
  assert.deepEqual(record.phase.events.map((event: { phase: string }) => event.phase), ["reserved"]);
});

test("the default process table finds a real process whose cwd is inside staging", linux, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-staging-holders-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const inside = join(root, "upgrades", "download-attempt-v1");
  mkdirSync(inside, { recursive: true });
  const child = spawn("sleep", ["30"], { cwd: inside, stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  await new Promise((resolve) => child.once("spawn", resolve));
  const procs = procProcesses();
  const found = findHolders(join(root, "upgrades"), BigInt(UID), procs);
  assert.equal(found.state, "found");
  assert.ok(found.pids.includes(child.pid!));
  const self = procs.identity(procs.self)!;
  assert.match(self.startTime, /^\d+$/u);
  assert.ok(self.bootId.length > 0);
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(findHolders(join(root, "upgrades"), BigInt(UID), procs).state, "none");
  assert.equal(typeof procs.name(procs.self), "string");
});
