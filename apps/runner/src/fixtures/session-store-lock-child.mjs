import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const config = JSON.parse(process.env.LOCK_RACE_CHILD);
const signal = (name, suffix) => `${config.signalDir}/${name}.${suffix}`;
const realExists = fs.existsSync;
const cell = new Int32Array(new SharedArrayBuffer(4));
// Each pause fires once, right after its nth matching call (the first by default), and holds until the
// test writes <name>.go.
for (const fn of new Set(config.pauses.map((pause) => pause.fn))) {
  const original = fs[fn];
  const pending = config.pauses.filter((pause) => pause.fn === fn);
  fs[fn] = function (...args) {
    const result = original.apply(this, args);
    for (const pause of pending) {
      if (pause.fired) continue;
      const target = String(args[pause.arg]);
      if (pause.prefix ? !target.startsWith(pause.prefix) : target !== pause.path) continue;
      if (pause.exclude && target.includes(pause.exclude)) continue;
      if (pause.caller && !new Error().stack.includes(pause.caller)) continue;
      pause.seen = (pause.seen ?? 0) + 1;
      if (pause.seen < (pause.nth ?? 1)) continue;
      pause.fired = true;
      fs.writeFileSync(signal(pause.name, "checked"), "");
      while (!realExists(signal(pause.name, "go"))) Atomics.wait(cell, 0, 0, 5);
      break;
    }
    return result;
  };
}
if (config.splitWrite) {
  // The kernel accepts only the first bytes of the write to this file: they land, the writer stalls
  // until the test writes <name>.go, and then the rest follows, as writeFileSync's loop would.
  const { name, path, bytes } = config.splitWrite;
  const open = fs.openSync;
  const writeFile = fs.writeFileSync;
  const write = fs.writeSync;
  const fds = new Set();
  fs.openSync = function (...args) {
    const fd = open.apply(this, args);
    if (String(args[0]) === path) fds.add(fd);
    return fd;
  };
  fs.writeFileSync = function (...args) {
    if (!fds.delete(args[0])) return writeFile.apply(this, args);
    const data = Buffer.from(args[1]);
    write(args[0], data, 0, bytes);
    writeFile(signal(name, "checked"), "");
    while (!realExists(signal(name, "go"))) Atomics.wait(cell, 0, 0, 5);
    write(args[0], data, bytes, data.length - bytes);
  };
}
if (config.noHardLinks) {
  fs.linkSync = function () {
    throw Object.assign(new Error("not supported"), { code: "ENOTSUP" });
  };
}
if (config.refuseRenameOf) {
  // Windows-style refusal to move a file another process has open.
  const rename = fs.renameSync;
  fs.renameSync = function (...args) {
    if (String(args[0]) === config.refuseRenameOf) throw Object.assign(new Error("access denied"), { code: "EACCES" });
    return rename.apply(this, args);
  };
}
syncBuiltinESMExports();
const { SessionStore } = await import(config.storeModule);
const store = new SessionStore(config.root, undefined, undefined, config.breaker === true);
let result = null;
if (config.op === "acquire") result = store.acquireLock(config.id, config.owner);
else if (config.op === "acquireFree") result = store.acquireFreeLock(config.id, config.owner);
else if (config.op === "meta") result = store.patchMeta(config.id, { title: config.owner }) !== null;
else if (config.op === "reset") result = (store.resetEvents(config.id), true);
else if (config.op === "append") result = store.appendEvent(config.id, { kind: "agent_message", text: config.owner }) !== null;
else if (config.op === "refresh") result = store.refreshLock(config.id, config.owner);
else store.releaseLock(config.id, config.owner);
// Publish through a private sibling, so existence of the final path means every byte was written.
const resultPath = signal(config.name, "result");
const pendingPath = signal(config.name, "result.pending");
const payload = config.resultFault === "invalid" ? "private malformed result" : JSON.stringify(result);
if (config.resultPause) {
  fs.writeFileSync(pendingPath, payload.slice(0, config.resultPause.bytes));
  fs.writeFileSync(signal(config.resultPause.name, "checked"), "");
  while (!realExists(signal(config.resultPause.name, "go"))) Atomics.wait(cell, 0, 0, 5);
}
if (config.resultFault === "exit") {
  process.stderr.write("private child stderr: " + config.owner);
  process.exit(7);
}
fs.writeFileSync(pendingPath, payload);
fs.renameSync(pendingPath, resultPath);
// Optionally stay alive afterwards, so this process's files name a live pid.
while (config.stayAlive && !realExists(signal(config.name, "exit"))) Atomics.wait(cell, 0, 0, 5);
