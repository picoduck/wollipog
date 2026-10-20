/** Test-only VM delivery harness. Executes the complete source bundle or the exact SEA asset;
 * only clocks, timer delivery and the message port are controlled. The canonical engine and
 * fixed native helpers still run. No production clock setting or diagnostic entry is added. */
const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
const { EventEmitter } = require("node:events");
const { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const vm = require("node:vm");

function verifyWorkerDeadlines(code, filename, { canonical = true } = {}) {
  let cases = 0;
  function lane(startupClock = "hrtime-ns-v1") {
    const time = { monotonic: 10_000_000_000_000n, wall: 1_800_000_000_000, afterNative: undefined };
    const port = new EventEmitter(), sent = [], timers = new Map();
    let timerId = 0;
    port.postMessage = frame => sent.push(JSON.parse(JSON.stringify(frame)));
    port.close = () => {};
    const epoch = randomUUID();
    const hrtime = Object.assign(process.hrtime.bind(process), { bigint: () => time.monotonic });
    const host = new Proxy(process, { get(target, key) {
      if (key === "hrtime") return hrtime;
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    class ClockDate extends Date { static now() { return time.wall; } }
    const native = require("node:child_process");
    const controlledRequire = name => name === "node:worker_threads" ? { parentPort: port,
      workerData: { epoch, ownerHash: "a".repeat(64), helperRoot: process.env.WOLLIPOG_LEASE_HELPER_ROOT || require("node:path").dirname(filename), ...(startupClock === "missing" ? {} : { clock: startupClock }) } }
      : name === "node:child_process" ? { ...native, spawnSync(...args) {
        const result = native.spawnSync(...args);
        time.afterNative?.();
        return result;
      } } : require(name);
    const context = vm.createContext({ require: controlledRequire, module: { exports: {} }, exports: {},
      __filename: filename, __dirname: require("node:path").dirname(filename),
      Buffer, URL, Uint8Array, TextEncoder, TextDecoder, Error, process: host, console,
      Date: ClockDate, performance,
      setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
      clearTimeout(id) { timers.delete(id); },
    });
    vm.runInContext(code, context, { filename });
    const ready = sent.shift();
    assert.deepEqual(ready, { kind: "ready", epoch, pid: process.pid, clock: "hrtime-ns-v1" });
    const execute = (operation, deadline = time.monotonic + 300_000_000_000n) => ({ kind: "execute", epoch, id: randomUUID(), deadline: deadline.toString(), operation });
    const deliver = frame => port.emit("message", frame);
    const accept = request => deliver({ kind: "accept", epoch, id: request.id, cancel: false });
    return { time, sent, timers, execute, deliver, accept };
  }
  const take = (f, kind) => {
    const frame = f.sent.shift(); assert.equal(frame?.kind, kind); return frame;
  };
  const evidence = home => {
    const root = join(home, ".agent-manager/provider-home-leases-v1");
    if (!existsSync(root)) return [];
    return [root, join(root, "mutable-home.lock")].flatMap(directory => readdirSync(directory)
      .filter(name => name.endsWith(".json")).sort().map(name => createHash("sha256").update(readFileSync(join(directory, name))).digest("hex")));
  };
  assert.throws(() => lane("missing"), /invalid lease worker startup/); cases++;
  assert.throws(() => lane("wall-ms-v0"), /invalid lease worker startup/); cases++;
  for (const deadline of [undefined, 123, 1n, "", "00", "-1", "+1", "1e9", "1.0", " 1", "18446744073709551616", "9".repeat(65_536)]) {
    const f = lane(), frame = f.execute({ method: "close" }); frame.deadline = deadline;
    assert.throws(() => f.deliver(frame), /invalid lease worker/); assert.equal(f.sent.length, 0); cases++;
  }
  {
    const f = lane(), frame = f.execute({ method: "close" });
    frame.deadline = (f.time.monotonic + 300_000_000_001n).toString();
    assert.throws(() => f.deliver(frame), /invalid lease worker/); cases++;
  }
  for (const offset of [-1n, 0n, 1n]) {
    const f = lane(), deadline = f.time.monotonic;
    f.time.monotonic = deadline + offset;
    const home = join(tmpdir(), `wollipog-expired-${randomUUID()}`);
    const request = f.execute(offset < 0n ? { method: "close" } : { method: "acquire", home, provider: "skills" }, deadline); f.deliver(request);
    const receipt = take(f, "receipt");
    assert.equal(receipt.ok, offset < 0n); assert.equal(receipt.error, offset < 0n ? undefined : "expired");
    if (offset < 0n) { f.accept(request); assert.equal(take(f, "done").ok, true); }
    else { assert.throws(() => f.accept(request), /deadline/); assert.equal(existsSync(home), false, "expired admission performs no HOME I/O"); }
    cases++;
  }
  for (const offset of [-1n, 0n, 1n]) {
    const f = lane(), request = f.execute({ method: "close" }); f.deliver(request); take(f, "receipt");
    f.time.monotonic = BigInt(request.deadline) + offset;
    if (offset < 0n) { f.accept(request); assert.equal(take(f, "done").ok, true); assert.equal(f.timers.size, 0); }
    else { assert.throws(() => f.accept(request), /deadline/); assert.equal(f.sent.length, 0); }
    cases++;
  }
  {
    const f = lane(), request = f.execute({ method: "close" }); f.deliver(request); take(f, "receipt");
    const fire = () => { const [id, timer] = f.timers.entries().next().value; f.timers.delete(id); timer.callback(); };
    fire(); assert.equal(f.timers.size, 1, "early worker callback must rearm");
    f.time.monotonic = BigInt(request.deadline) - 1n; fire();
    assert.equal([...f.timers.values()][0].delay, 1);
    f.time.monotonic++; assert.throws(fire, /deadline/); assert.equal(f.sent.length, 0); cases++;
  }
  if (!canonical) return { cases, exactWorkerSha256: createHash("sha256").update(code).digest("hex") };
  const root = mkdtempSync(join(tmpdir(), "wollipog-deadline-vm-"));
  try {
    for (const jump of [-360_000, 360_000]) {
      const home = join(root, String(jump)), f = lane();
      const request = f.execute({ method: "acquire", home, provider: "skills" });
      f.time.wall += jump; f.deliver(request); assert.deepEqual(take(f, "receipt"), { kind: "receipt", epoch: request.epoch, id: request.id, ok: true, value: true });
      f.time.wall += jump; f.accept(request); assert.equal(take(f, "done").ok, true);
      const owned = evidence(home); assert.ok(owned.length > 0, "actual engine published canonical proof");
      const release = f.execute({ method: "release", home }); f.time.wall -= jump * 10;
      f.deliver(release); assert.equal(take(f, "receipt").value, true);
      f.time.wall += jump * 10; f.accept(release); assert.equal(take(f, "done").ok, true);
      assert.notDeepEqual(evidence(home), owned, "exact release publishes canonical evidence"); cases++;
    }
    for (const mode of ["original", "refreshed", "expired"]) {
      const home = join(root, `compensation-${mode}`), f = lane();
      const request = f.execute({ method: "acquire_reference", home, provider: "skills" });
      f.deliver(request); assert.equal(take(f, "receipt").ok, true); f.accept(request); take(f, "done");
      const owned = evidence(home), deadline = BigInt(request.deadline);
      f.time.monotonic = deadline + (mode === "expired" ? 0n : -1n);
      f.time.wall -= 360_000;
      const cancel = f.execute({ method: "cancel", home, completedId: request.id }, deadline + (mode === "refreshed" ? 1n : 0n));
      f.deliver(cancel); const receipt = take(f, "receipt");
      assert.equal(receipt.ok, mode === "original");
      if (mode === "original") {
        assert.equal(receipt.value, true); f.accept(cancel); assert.equal(take(f, "done").ok, true);
        assert.notDeepEqual(evidence(home), owned);
      } else {
        assert.equal(receipt.error, mode === "expired" ? "expired" : "refusal");
        assert.deepEqual(evidence(home), owned, "unproved or late compensation preserves canonical proof");
      }
      cases++;
    }
    {
      const home = join(root, "late"), f = lane();
      const request = f.execute({ method: "acquire", home, provider: "skills" });
      f.time.afterNative = () => { f.time.monotonic = BigInt(request.deadline); };
      assert.throws(() => f.deliver(request), /deadline/);
      assert.equal(f.sent.filter(frame => frame.kind !== "diagnostic").length, 0, "late native completion cannot emit a successful receipt");
      const preserved = evidence(home); assert.ok(preserved.length > 0);
      const other = lane(), retry = other.execute({ method: "acquire", home, provider: "skills" });
      other.deliver(retry); const refusal = take(other, "receipt"); assert.equal(refusal.ok, false); assert.equal(refusal.error, "busy");
      assert.deepEqual(evidence(home), preserved, "a new registry cannot replace the lost live owner's proof"); cases++;
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
  return { cases, exactWorkerSha256: createHash("sha256").update(code).digest("hex") };
}
module.exports = { verifyWorkerDeadlines };
