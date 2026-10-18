import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import {
  applyRetirementModelTransition, canonicalModelJson, createRetirementModel, inspectRetirementModel,
  nextModelCounter, RETIREMENT_MODEL_LIMITS, retirementModelAcknowledgement, retirementModelDigest,
  retirementModelFreezeBinding, retirementModelReference, RetirementModelRefusal, SyntheticRetirementModelStore,
  type ModelAction, type ModelGenesis, type ModelSnapshot, type ModelTransition,
} from "./provider-home-retirement-state.js";

const hash = (text: string) => retirementModelDigest("publication", text);
const genesis: ModelGenesis = {
  kind: "managed-home-retirement-model", version: 1, rootEpoch: "root", incarnationId: "home", profileId: "profile",
  provider: "claude", creatorId: "owner", storeEpoch: "store", nonce: "genesis",
};
function fixture(input = genesis) {
  const first = createRetirementModel(input);
  const store = new SyntheticRetirementModelStore(first, retirementModelReference(first));
  let sequence = 0;
  const event = (action: ModelAction): ModelTransition => ({ nonce: `event-${++sequence}`, preimage: retirementModelReference(store.read()), action });
  const run = (action: ModelAction) => store.compareAndSwap(event(action));
  const refuse = (action: ModelAction | unknown, reason?: RegExp) => {
    const before = store.read();
    assert.throws(() => store.compareAndSwap({ nonce: `event-${++sequence}`, preimage: retirementModelReference(before), action }),
      (error: unknown) => error instanceof RetirementModelRefusal && (!reason || reason.test(error.message)));
    assert.deepEqual(store.read(), before, "refusal must not consume a nonce or mutate storage");
  };
  const enroll = (name: string, ownerId = "owner", consumerKind: "session" | "history" | "account" = "session") => {
    const o = inspectRetirementModel(store.read()).owners.find(o => o.ownerId === ownerId)!;
    return run({ type: "enroll_intent", ownerId, storeEpoch: o.storeEpoch, intentId: `intent-${name}`, consumerId: `consumer-${name}`,
      consumerKind, baseSourceRevision: o.sourceRevision, grantRevision: o.grantRevision });
  };
  const publish = (name: string) => {
    const view = inspectRetirementModel(store.read()), i = view.intents.find(i => i.intentId === `intent-${name}`)!;
    const o = view.owners.find(o => o.ownerId === i.ownerId)!;
    return run({ type: "publish", ownerId: o.ownerId, storeEpoch: o.storeEpoch, intentId: i.intentId, ticket: i.ticket,
      sourceRevision: nextModelCounter(o.sourceRevision), sourceDigest: hash(`published-${name}`) });
  };
  const freeze = () => run({ type: "freeze", binding: retirementModelFreezeBinding(store.read()) });
  const barrierAction = (ownerId = "owner"): Extract<ModelAction, { type: "source_barrier" }> => {
    const v = inspectRetirementModel(store.read()), o = v.owners.find(o => o.ownerId === ownerId)!;
    return { type: "source_barrier", ownerId, storeEpoch: o.storeEpoch, freezeNonce: v.freeze!.nonce,
      previousSourceRevision: o.sourceRevision, previousSourceDigest: o.sourceDigest, sourceRevision: nextModelCounter(o.sourceRevision),
      sourceDigest: hash(`barrier-${ownerId}`), grantRevision: o.grantRevision,
      resolutions: v.intents.filter(i => i.ownerId === ownerId).map(i => ({ intentId: i.intentId, ticket: i.ticket,
        outcome: i.status === "published" ? "retired" : "aborted" })) };
  };
  const barrier = (ownerId = "owner") => run(barrierAction(ownerId));
  const ackAction = (ownerId = "owner"): Extract<ModelAction, { type: "acknowledge" }> =>
    ({ type: "acknowledge", ownerId, binding: retirementModelAcknowledgement(store.read(), ownerId) });
  const ack = (ownerId = "owner") => run(ackAction(ownerId));
  const terminalAction = (): ModelAction => ({ type: "terminal", freezeNonce: inspectRetirementModel(store.read()).freeze!.nonce });
  return { store, event, run, refuse, enroll, publish, freeze, barrierAction, barrier, ackAction, ack, terminalAction };
}

test("configured synthetic consumer reaches only model terminal eligibility, preserving all tombstones", () => {
  const f = fixture();
  f.enroll("configured", "owner", "account"); f.publish("configured"); f.enroll("failed-sign-in");
  f.freeze();
  const frozen = inspectRetirementModel(f.store.read()).freeze!;
  f.refuse(f.terminalAction());
  f.barrier();
  f.refuse(f.terminalAction());
  f.ack(); f.run(f.terminalAction());
  const view = inspectRetirementModel(f.store.read());
  assert.equal(view.phase, "terminal_eligible");
  assert.deepEqual(view.freeze, frozen, "barrier/ack transitions cannot rebase the frozen census");
  assert.deepEqual(view.intents.map(i => i.status), ["retired", "aborted"]);
  assert.ok(view.consumers.every(c => c.status === "retired"));
  assert.equal(view.owners.length, 1); assert.equal(view.owners[0]!.grantStatus, "revoked");
  assert.equal(view.processStarts.length, 0); assert.equal(view.unknownHistory, false);
  f.refuse({ type: "unknown_history" }); f.refuse({ type: "owner_presence", ownerId: "owner", storeEpoch: "store", connected: true });
  assert.equal(Object.hasOwn(view, "removed"), false, "no physical-removal result exists");
});

test("tickets issued before freeze survive lost writes and cannot publish across the source barrier", () => {
  const f = fixture(); f.enroll("first"); f.enroll("second");
  const beforePublication = f.store.read(); f.publish("first");
  const oldIntent = inspectRetirementModel(f.store.read()).intents[1]!;
  f.refuse({ type: "publish", ownerId: "owner", storeEpoch: "store", intentId: oldIntent.intentId, ticket: oldIntent.ticket,
    sourceRevision: "2", sourceDigest: hash("stale-source") });
  f.freeze();
  assert.equal(inspectRetirementModel(f.store.read()).intents[1]!.status, "pending");
  f.refuse({ type: "publish", ownerId: "owner", storeEpoch: "store", intentId: oldIntent.intentId, ticket: oldIntent.ticket,
    sourceRevision: "2", sourceDigest: hash("late-rename") });
  const exact = f.barrierAction();
  f.refuse({ ...exact, resolutions: exact.resolutions.slice(1) });
  f.refuse({ ...exact, resolutions: [exact.resolutions[0]!, exact.resolutions[0]!] });
  f.refuse({ ...exact, previousSourceRevision: "0" });
  f.refuse({ ...exact, previousSourceDigest: hash("rolled-back") });
  f.refuse({ ...exact, sourceRevision: exact.previousSourceRevision });
  f.refuse({ ...exact, grantRevision: "1" });
  f.refuse({ ...exact, resolutions: exact.resolutions.map(r => ({ ...r, outcome: "aborted" as const })) });
  f.run(exact); f.ack(); f.run(f.terminalAction());
  assert.throws(() => new SyntheticRetirementModelStore(beforePublication, retirementModelReference(f.store.read())), /anchor/);
  f.refuse({ type: "publish", ownerId: "owner", storeEpoch: "store", intentId: oldIntent.intentId, ticket: oldIntent.ticket,
    sourceRevision: "3", sourceDigest: hash("post-terminal-write") });
});

test("a pending intent may be committed-and-retired only through its source barrier", () => {
  const f = fixture(); f.enroll("ambiguous-publication"); f.freeze();
  f.refuse(f.terminalAction());
  const barrier = f.barrierAction();
  f.run({ ...barrier, resolutions: barrier.resolutions.map(r => ({ ...r, outcome: "retired" })) });
  const v = inspectRetirementModel(f.store.read());
  assert.equal(v.intents[0]!.status, "retired");
  assert.equal(v.consumers[0]!.status, "retired");
  assert.equal(v.owners[0]!.grantStatus, "revoked");
  assert.equal(v.phase, "frozen");
  f.refuse(f.terminalAction());
  f.ack(); f.run(f.terminalAction());
  assert.equal(inspectRetirementModel(f.store.read()).phase, "terminal_eligible");
});

test("a source barrier cannot resolve another owner's valid intent and ticket", () => {
  const f = fixture();
  f.run({ type: "enroll_owner", ownerId: "foreign", storeEpoch: "foreign-store" });
  f.enroll("local"); f.enroll("foreign", "foreign"); f.freeze();
  const local = f.barrierAction(), foreign = f.barrierAction("foreign");
  assert.equal(local.resolutions.length, foreign.resolutions.length);
  f.refuse({ ...local, resolutions: foreign.resolutions }, /intent\/source barrier mismatch/);
  f.run(local); f.ack(); f.refuse(f.terminalAction());
  f.run(foreign); f.refuse(f.terminalAction()); f.ack("foreign");
  f.run(f.terminalAction());
  const v = inspectRetirementModel(f.store.read());
  assert.equal(v.phase, "terminal_eligible");
  assert.deepEqual(v.intents.map(i => i.status), ["aborted", "aborted"]);
  assert.equal(v.acknowledgements.length, 2);
});

test("grant revocation refuses publication while retaining the enrolled intent and owner", () => {
  const f = fixture(); f.enroll("revoked-publication");
  f.run({ type: "set_grant", ownerId: "owner", storeEpoch: "store", grantRevision: "0", status: "revoked" });
  const before = inspectRetirementModel(f.store.read()), i = before.intents[0]!, o = before.owners[0]!;
  f.refuse({ type: "publish", ownerId: o.ownerId, storeEpoch: o.storeEpoch, intentId: i.intentId, ticket: i.ticket,
    sourceRevision: nextModelCounter(o.sourceRevision), sourceDigest: hash("revoked-publication") }, /publication preimage/);
  assert.equal(before.intents[0]!.status, "pending");
  assert.equal(before.consumers[0]!.status, "pending");
  assert.equal(before.owners.length, 1);
  assert.equal(before.owners[0]!.grantStatus, "revoked");
  f.freeze(); f.refuse(f.terminalAction()); f.barrier(); f.refuse(f.terminalAction());
  f.ack(); f.run(f.terminalAction());
  const after = inspectRetirementModel(f.store.read());
  assert.equal(after.phase, "terminal_eligible");
  assert.equal(after.intents[0]!.status, "aborted");
  assert.equal(after.owners.length, 1);
});

test("revocation cannot forget historical/foreign owners, disconnected stores or their acknowledgements", () => {
  const f = fixture();
  f.run({ type: "enroll_owner", ownerId: "foreign", storeEpoch: "foreign-store" });
  f.enroll("dormant-history", "foreign", "history");
  f.run({ type: "set_grant", ownerId: "foreign", storeEpoch: "foreign-store", grantRevision: "0", status: "revoked" });
  f.refuse({ type: "enroll_owner", ownerId: "foreign", storeEpoch: "replacement-store" });
  f.freeze(); f.barrier(); f.ack(); f.refuse(f.terminalAction());
  f.run({ type: "owner_presence", ownerId: "foreign", storeEpoch: "foreign-store", connected: false });
  f.refuse(f.barrierAction("foreign"));
  f.refuse({ type: "owner_presence", ownerId: "foreign", storeEpoch: "replacement-store", connected: true });
  f.run({ type: "owner_presence", ownerId: "foreign", storeEpoch: "foreign-store", connected: true });
  f.barrier("foreign"); f.refuse(f.terminalAction()); f.ack("foreign");
  f.run({ type: "owner_presence", ownerId: "foreign", storeEpoch: "foreign-store", connected: false });
  f.refuse(f.terminalAction());
  f.run({ type: "owner_presence", ownerId: "foreign", storeEpoch: "foreign-store", connected: true });
  f.run(f.terminalAction());
  assert.deepEqual(inspectRetirementModel(f.store.read()).owners.map(o => o.ownerId).sort(), ["foreign", "owner"]);
});

test("every freeze/ack field is bound, including source barrier and resolution, not just the owner id", () => {
  const f = fixture(); f.enroll("dormant");
  const freeze = retirementModelFreezeBinding(f.store.read());
  for (const key of Object.keys(freeze) as Array<keyof typeof freeze>) {
    const bad = { ...freeze, [key]: key === "generation" ? "999" : key.endsWith("Digest") ? hash(key) : `other-${key.toLowerCase()}` };
    f.refuse({ type: "freeze", binding: bad });
  }
  f.freeze();
  assert.throws(() => retirementModelAcknowledgement(f.store.read(), "owner"), /source barrier/);
  const b = f.barrierAction();
  f.refuse({ ...b, freezeNonce: "old-freeze" });
  f.refuse({ ...b, storeEpoch: "old-store" });
  f.refuse({ ...b, resolutions: b.resolutions.map(r => ({ ...r, ticket: hash("different-ticket") })) });
  f.barrier();
  const ack = f.ackAction();
  for (const key of Object.keys(ack.binding) as Array<keyof typeof ack.binding>) {
    const bad = { ...ack.binding, [key]: key === "generation" ? "999" : key.endsWith("Digest") ? hash(key) : `other-${key.toLowerCase()}` };
    f.refuse({ ...ack, binding: bad });
  }
  f.refuse({ ...ack, ownerId: "other-owner" });
  f.ack(); f.run(f.terminalAction());
});

test("no-process eligibility comes from genesis/admission history, and process/unknown history are sticky", () => {
  for (const evidence of ["process", "unknown"] as const) {
    const f = fixture(); f.enroll("used"); f.publish("used");
    f.run(evidence === "process" ? { type: "process_started", consumerId: "consumer-used" } : { type: "unknown_history" });
    f.freeze(); f.barrier(); f.ack(); f.refuse(f.terminalAction(), /no-process history unproved/);
    const v = inspectRetirementModel(f.store.read());
    assert.equal(v.processStarts.length > 0 || v.unknownHistory, true);
    const tampered = f.store.read(); tampered.events.splice(2, 1);
    assert.throws(() => inspectRetirementModel(tampered), RetirementModelRefusal);
  }
  const f = fixture();
  f.refuse({ type: "process_started", consumerId: "unadmitted" });
  assert.throws(() => createRetirementModel({ ...genesis, noProcess: true } as ModelGenesis), /keys/);
  f.freeze(); f.barrier(); f.ack();
  f.run({ type: "unknown_history" }); f.refuse(f.terminalAction(), /no-process history unproved/);
});

test("a caller noProcesses flag is an unknown schema key even when modeled history permits terminal", () => {
  const f = fixture(); f.freeze(); f.barrier(); f.ack();
  f.refuse({ ...f.terminalAction(), noProcesses: true }, /unknown or missing keys/);
  f.run(f.terminalAction());
  assert.equal(inspectRetirementModel(f.store.read()).phase, "terminal_eligible");
});

test("synthetic CAS rejects stale preimages, nonce reuse and cross-root replay; exact lost-reply retries are inert", () => {
  const f = fixture();
  const accepted = f.event({ type: "enroll_owner", ownerId: "second", storeEpoch: "second-store" });
  f.store.compareAndSwap(accepted);
  f.enroll("later");
  const current = f.store.read(), ref = retirementModelReference(current);
  assert.deepEqual(f.store.compareAndSwap(JSON.parse(JSON.stringify(accepted))), current);
  assert.deepEqual(retirementModelReference(f.store.read()), ref);
  for (const bad of [
    { ...accepted, nonce: "fresh-nonce" },
    { ...accepted, preimage: ref },
    { ...accepted, action: { type: "unknown_history" } },
    { nonce: genesis.nonce, preimage: ref, action: { type: "unknown_history" } },
  ]) {
    assert.throws(() => f.store.compareAndSwap(bad), RetirementModelRefusal); assert.deepEqual(f.store.read(), current);
  }
  const other = fixture({ ...genesis, rootEpoch: "other-root" });
  assert.throws(() => other.store.compareAndSwap(accepted), /preimage/);
  const restored = new SyntheticRetirementModelStore(current, ref);
  const detached = restored.read(); detached.events[0]!.nonce = "mutated";
  assert.deepEqual(restored.read(), current);
  const rewound = { ...current, events: current.events.slice(0, -1) };
  assert.throws(() => new SyntheticRetirementModelStore(rewound, ref), /anchor/);
  const missing = { ...current, events: current.events.slice(1) };
  assert.throws(() => inspectRetirementModel(missing), /preimage/);
  const reused = { ...current, events: [...current.events, current.events[0]!] };
  assert.throws(() => inspectRetirementModel(reused), /nonce reuse/);
});

test("unknown keys and versions refuse at every schema layer, including unused history", () => {
  const f = fixture(); f.enroll("one"); f.freeze(); f.barrier(); f.ack();
  const valid = f.store.read();
  const mutations: Array<(s: ModelSnapshot) => unknown> = [
    s => ({ ...s, extra: 1 }), s => ({ ...s, version: 2 }), s => ({ ...s, kind: "foreign" }),
    s => ({ ...s, genesis: { ...s.genesis, version: 2 } }), s => ({ ...s, genesis: { ...s.genesis, extra: 1 } }),
    s => { Object.assign(s.events[0]!, { extra: 1 }); return s; },
    s => { Object.assign(s.events[0]!.preimage, { extra: 1 }); return s; },
    s => { Object.assign(s.events[0]!.action, { extra: 1 }); return s; },
    s => { Object.assign((s.events[1]!.action as { binding: unknown }).binding!, { extra: 1 }); return s; },
    s => { Object.assign((s.events[2]!.action as Extract<ModelAction, { type: "source_barrier" }>).resolutions[0]!, { extra: 1 }); return s; },
    s => { Object.assign((s.events[3]!.action as { binding: unknown }).binding!, { extra: 1 }); return s; },
  ];
  for (const mutate of mutations) assert.throws(() => inspectRetirementModel(mutate(structuredClone(valid))), RetirementModelRefusal);
  for (const bad of [undefined, null, {}, { type: "__proto__" }, { type: "terminal", freezeNonce: "" }]) f.refuse(bad);
  const pending = fixture();
  pending.refuse({ type: "enroll_intent", ownerId: "owner", storeEpoch: "store", intentId: "i", consumerId: "c",
    consumerKind: "other", baseSourceRevision: "0", grantRevision: "0" });
});

test("canonical JSON refuses exotic/cyclic/oversized inputs and accessors without invoking their getters", () => {
  let read = false;
  const accessor = Object.defineProperty({}, "type", { enumerable: true, get() { read = true; return "unknown_history"; } });
  const sparse = new Array(2), extra = Object.assign([1], { named: 2 });
  const cycle: unknown[] = []; cycle.push(cycle);
  for (const bad of [accessor, sparse, extra, cycle, new Date(), Buffer.from("test"), -0, NaN, Infinity, 1n, undefined, { [Symbol("key")]: 1 }, { a: undefined }]) {
    assert.throws(() => canonicalModelJson(bad), RetirementModelRefusal);
  }
  assert.equal(read, false);
  assert.equal(Buffer.byteLength(canonicalModelJson("a".repeat(RETIREMENT_MODEL_LIMITS.bytes - 2))), RETIREMENT_MODEL_LIMITS.bytes);
  assert.throws(() => canonicalModelJson("a".repeat(RETIREMENT_MODEL_LIMITS.bytes - 1)), /byte bound/);
  assert.throws(() => canonicalModelJson(Array.from({ length: 256 }, () => "é".repeat(1000))), /byte bound/);
  assert.throws(() => canonicalModelJson(new Array(257).fill(0)), /array bound/);
  assert.throws(() => canonicalModelJson(Object.fromEntries(Array.from({ length: 257 }, (_, n) => [`key-${n}`, 0]))), /object keys/);
  assert.throws(() => canonicalModelJson({ ["k".repeat(RETIREMENT_MODEL_LIMITS.bytes + 1)]: 0 }), /key bound/);
  let deep: unknown = null; for (let n = 0; n < 18; n++) deep = { deep };
  assert.throws(() => canonicalModelJson(deep), /work bound/);
});

test("native Proxy refusal precedes all reflection traps for direct, nested, array and revoked inputs", () => {
  let traps = 0;
  const trap = () => { traps++; throw new Error("Proxy trap must not run"); };
  const handler: ProxyHandler<object> = { getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, get: trap };
  const direct = new Proxy({}, handler), array = new Proxy([], handler);
  const revokedObject = Proxy.revocable({}, handler), revokedArray = Proxy.revocable([], handler);
  revokedObject.revoke(); revokedArray.revoke();
  for (const input of [direct, { nested: direct }, [direct], array, { nested: array }, revokedObject.proxy, revokedArray.proxy,
    { nested: revokedObject.proxy }, [revokedArray.proxy]]) {
    assert.throws(() => canonicalModelJson(input), (error: unknown) =>
      error instanceof RetirementModelRefusal && error.message === "Retirement model refused: Proxy input");
    assert.equal(traps, 0);
  }
});

test("combined row and replay-history bounds never evict evidence", () => {
  const f = fixture();
  for (let i = 0; i < 127; i++) f.enroll(String(i));
  const v = inspectRetirementModel(f.store.read());
  assert.equal(v.owners.length + v.consumers.length + v.intents.length, 255);
  f.refuse({ type: "enroll_intent", ownerId: "owner", storeEpoch: "store", intentId: "overflow", consumerId: "overflow",
    consumerKind: "session", baseSourceRevision: "0", grantRevision: "0" });
  const history = fixture();
  for (let i = 0; i < RETIREMENT_MODEL_LIMITS.events; i++) {
    history.run({ type: "owner_presence", ownerId: "owner", storeEpoch: "store", connected: i % 2 === 0 });
  }
  assert.equal(history.store.read().events.length, RETIREMENT_MODEL_LIMITS.events);
  history.refuse({ type: "unknown_history" });
  assert.equal(inspectRetirementModel(history.store.read()).unknownHistory, false);
});

test("canonical counters cover uint64 exactly and refuse alternative spellings and overflow", () => {
  const max = (1n << 64n) - 1n;
  fc.assert(fc.property(fc.bigInt({ min: 0n, max: max - 1n }), n => {
    assert.equal(BigInt(nextModelCounter(n.toString())) - n, 1n);
    for (const invalid of [`0${n}`, `+${n}`, ` ${n}`, `${n}.0`, `${n}\n`]) assert.throws(() => nextModelCounter(invalid), RetirementModelRefusal);
  }), { examples: [[0n], [max - 1n], [9_007_199_254_740_993n]] });
  for (const bad of [max.toString(), (max + 1n).toString(), "-1", "", "9".repeat(21)]) assert.throws(() => nextModelCounter(bad), RetirementModelRefusal);
});

test("canonical equivalence, digest domains and unknown-key mutation hold across generated records", () => {
  fc.assert(fc.property(fc.uuid(), fc.boolean(), (uuid, codex) => {
    const g = { ...genesis, incarnationId: uuid, provider: codex ? "codex" as const : "claude" as const };
    const reordered = Object.fromEntries(Object.entries(g).reverse()) as unknown as ModelGenesis;
    assert.equal(canonicalModelJson(g), canonicalModelJson(reordered));
    const a = createRetirementModel(g), b = createRetirementModel(reordered);
    assert.deepEqual(retirementModelReference(a), retirementModelReference(b));
    const domains = ["genesis", "state", "roster", "manifest", "grants", "publication", "barrier", "retirement"] as const;
    assert.equal(new Set(domains.map(d => retirementModelDigest(d, g))).size, domains.length);
    assert.notEqual(retirementModelDigest("genesis", g), retirementModelDigest("genesis", { ...g, rootEpoch: "another" }));
    assert.throws(() => inspectRetirementModel({ ...a, [uuid]: "unknown" }), RetirementModelRefusal);
  }), { numRuns: 60 });
});

test("generated owner/intent schedules require every owner ack and retain every enrolled row", () => {
  fc.assert(fc.property(fc.array(fc.array(fc.boolean(), { maxLength: 2 }), { minLength: 1, maxLength: 4 }), fc.nat(), (owners, choice) => {
    const construct = (omit: number | null) => {
      const f = fixture();
      owners.forEach((consumers, n) => {
        const ownerId = n === 0 ? "owner" : `owner-${n}`;
        if (n) f.run({ type: "enroll_owner", ownerId, storeEpoch: `store-${n}` });
        consumers.forEach((publish, c) => { const name = `${n}-${c}`; f.enroll(name, ownerId, "history"); if (publish) f.publish(name); });
      });
      f.freeze();
      const frozen = inspectRetirementModel(f.store.read()).freeze;
      owners.forEach((_, n) => f.barrier(n === 0 ? "owner" : `owner-${n}`));
      // Vary acknowledgement order; census completeness cannot depend on that order.
      const order = owners.map((_, n) => n); if (choice % 2) order.reverse();
      for (const n of order) if (n !== omit) f.ack(n === 0 ? "owner" : `owner-${n}`);
      if (omit === null) f.run(f.terminalAction()); else f.refuse(f.terminalAction());
      const v = inspectRetirementModel(f.store.read());
      assert.deepEqual(v.freeze, frozen);
      assert.equal(v.owners.length, owners.length);
      assert.equal(v.intents.length, owners.reduce((count, cs) => count + cs.length, 0));
      assert.equal(v.consumers.length, v.intents.length);
      assert.ok(v.intents.every(i => i.status === "retired" || i.status === "aborted"));
      assert.equal(v.phase, omit === null ? "terminal_eligible" : "frozen");
    };
    construct(null); construct(choice % owners.length);
  }), { numRuns: 45, examples: [[[[]], 0], [[[true], [false]], 1]] });
});

test("generated command interleavings preserve independent admission and no-process invariants", () => {
  const commands = fc.array(fc.constantFrom("enroll", "publish", "freeze", "barrier", "ack", "terminal", "start", "unknown", "stale", "retry"), { maxLength: 25 });
  fc.assert(fc.property(commands, sequence => {
    const f = fixture();
    // Independent contract oracle: flags/counters, not the implementation's transition/digest code.
    let phase: "open" | "frozen" | "terminal" = "open", enrolled = false, published = false;
    let drained = false, acknowledged = false, process = false, unknown = false;
    let last: ModelTransition | undefined;
    for (const command of sequence) {
      const v = inspectRetirementModel(f.store.read());
      let action: ModelAction, allowed: boolean;
      if (command === "enroll") {
        action = { type: "enroll_intent", ownerId: "owner", storeEpoch: "store", intentId: "intent-one", consumerId: "consumer-one",
          consumerKind: "session", baseSourceRevision: "0", grantRevision: "0" }; allowed = phase === "open" && !enrolled;
      } else if (command === "publish") {
        action = { type: "publish", ownerId: "owner", storeEpoch: "store", intentId: "intent-one", ticket: v.intents[0]?.ticket ?? hash("absent"), sourceRevision: "1", sourceDigest: hash("source") };
        allowed = phase === "open" && enrolled && !published;
      } else if (command === "freeze") {
        action = { type: "freeze", binding: phase === "open" ? retirementModelFreezeBinding(f.store.read()) : v.freeze!.binding }; allowed = phase === "open";
      } else if (command === "barrier") {
        action = phase === "frozen" && !drained ? f.barrierAction() : { type: "source_barrier", ownerId: "owner", storeEpoch: "store", freezeNonce: "absent",
          previousSourceRevision: "0", previousSourceDigest: hash("absent"), sourceRevision: "1", sourceDigest: hash("source"), grantRevision: "0", resolutions: [] };
        allowed = phase === "frozen" && !drained;
      } else if (command === "ack") {
        if (!drained) { assert.throws(() => retirementModelAcknowledgement(f.store.read(), "owner"), RetirementModelRefusal); continue; }
        action = f.ackAction(); allowed = phase === "frozen" && !acknowledged;
      } else if (command === "terminal") {
        action = { type: "terminal", freezeNonce: v.freeze?.nonce ?? "absent" };
        allowed = phase === "frozen" && drained && acknowledged && !process && !unknown;
      } else if (command === "start") {
        action = { type: "process_started", consumerId: "consumer-one" }; allowed = phase === "open" && published;
      } else if (command === "unknown") { action = { type: "unknown_history" }; allowed = phase !== "terminal"; }
      else {
        if (!last) continue;
        const before = f.store.read();
        if (command === "retry") assert.deepEqual(f.store.compareAndSwap(last), before);
        else assert.throws(() => f.store.compareAndSwap({ ...last, nonce: "stale-request" }), RetirementModelRefusal);
        assert.deepEqual(f.store.read(), before); continue;
      }
      const event = f.event(action), before = f.store.read();
      if (!allowed) { assert.throws(() => f.store.compareAndSwap(event), RetirementModelRefusal); assert.deepEqual(f.store.read(), before); continue; }
      f.store.compareAndSwap(event); last = event;
      if (command === "enroll") enrolled = true;
      if (command === "publish") published = true;
      if (command === "freeze") phase = "frozen";
      if (command === "barrier") drained = true;
      if (command === "ack") acknowledged = true;
      if (command === "terminal") phase = "terminal";
      if (command === "start") process = true;
      if (command === "unknown") unknown = true;
      const after = inspectRetirementModel(f.store.read());
      assert.equal(after.phase === "terminal_eligible", phase === "terminal");
      if (after.phase === "terminal_eligible") assert.ok(drained && acknowledged && !process && !unknown);
      assert.equal(after.processStarts.length > 0, process);
      assert.equal(after.unknownHistory, unknown);
    }
  }), { numRuns: 100, examples: [[[]], [["enroll", "publish", "start", "freeze", "barrier", "ack", "terminal"]], [["freeze", "barrier", "ack", "terminal", "retry"]]] });
});
