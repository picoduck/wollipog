import { createHash } from "node:crypto";
import { types } from "node:util";

/** Isolated executable specification, not a production retirement authority. Its in-memory
 * records model publication/acknowledgement; they prove no real durability, owner or process fact.
 * Only the accompanying test imports this module. There is deliberately no filesystem API. */
export const RETIREMENT_MODEL_LIMITS = { rows: 256, events: 256, bytes: 65_536, depth: 16, nodes: 32_768 } as const;
const MAX_COUNTER = (1n << 64n) - 1n;
const DOMAINS = ["genesis", "state", "roster", "manifest", "grants", "publication", "barrier", "retirement"] as const;
type Domain = typeof DOMAINS[number];
type Phase = "open" | "frozen" | "terminal_eligible";
type ConsumerKind = "account" | "default" | "session" | "history" | "switch" | "recovery" | "tui" | "login" | "launch" | "skill" | "probe" | "background";
const CONSUMER_KINDS: ConsumerKind[] = ["account", "default", "session", "history", "switch", "recovery", "tui", "login", "launch", "skill", "probe", "background"];

export class RetirementModelRefusal extends Error {
  constructor(reason: string) { super(`Retirement model refused: ${reason}`); }
}
function need(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new RetirementModelRefusal(reason);
}
/** Canonical JSON with bounded output, visited nodes and depth. Native Proxy detection precedes
 * reflection; data accessors are never invoked. This assumes the supported Node realm's intrinsics
 * are intact, not arbitrary hostile JavaScript. Ordinary-object own-key enumeration still requires
 * work/allocation proportional to the supplied key count; already-allocated input is not bounded.
 * Object key order has no semantic meaning; array order does. */
export function canonicalModelJson(value: unknown): string {
  let nodes = 0, bytes = 0;
  const token = (text: string): string => {
    bytes += Buffer.byteLength(text);
    need(bytes <= RETIREMENT_MODEL_LIMITS.bytes, "canonical byte bound"); return text;
  };
  const visit = (v: unknown, depth: number): string => {
    need(++nodes <= RETIREMENT_MODEL_LIMITS.nodes && depth <= RETIREMENT_MODEL_LIMITS.depth, "JSON work bound");
    if (v === null || typeof v === "boolean") return token(JSON.stringify(v));
    if (typeof v === "string") { need(v.length <= RETIREMENT_MODEL_LIMITS.bytes, "string bound"); return token(JSON.stringify(v)); }
    if (typeof v === "number") { need(Number.isSafeInteger(v) && !Object.is(v, -0), "noncanonical number"); return token(String(v)); }
    need(typeof v === "object", "non-JSON value");
    need(!types.isProxy(v), "Proxy input");
    if (Array.isArray(v)) {
      need(Object.getPrototypeOf(v) === Array.prototype && v.length <= RETIREMENT_MODEL_LIMITS.events, "array bound/prototype");
      need(Reflect.ownKeys(v).length === v.length + 1, "array keys");
      token("[]" + ",".repeat(Math.max(0, v.length - 1)));
      return `[${Array.from({ length: v.length }, (_, i) => {
        const d = Object.getOwnPropertyDescriptor(v, String(i)); need(d && "value" in d && d.enumerable, "array entry");
        return visit(d.value, depth + 1);
      }).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(v);
    need(prototype === Object.prototype || prototype === null, "object prototype");
    const keys = Reflect.ownKeys(v); need(keys.length <= 256 && keys.every(k => typeof k === "string"), "object keys");
    token("{}" + ",".repeat(Math.max(0, keys.length - 1)));
    return `{${(keys as string[]).sort().map(k => {
      need(k.length <= RETIREMENT_MODEL_LIMITS.bytes, "key bound");
      const d = Object.getOwnPropertyDescriptor(v, k); need(d && "value" in d && d.enumerable, "object entry");
      return `${token(JSON.stringify(k) + ":")}${visit(d.value, depth + 1)}`;
    }).join(",")}}`;
  };
  const result = visit(value, 0);
  need(Buffer.byteLength(result) <= RETIREMENT_MODEL_LIMITS.bytes, "canonical byte bound");
  return result;
}
export function retirementModelDigest(domain: Domain, value: unknown): string {
  need(DOMAINS.includes(domain), "digest domain");
  return createHash("sha256").update(`wollipog:retirement-model:v1:${domain}\0`).update(canonicalModelJson(value)).digest("hex");
}
function object(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  need(value !== null && typeof value === "object" && !Array.isArray(value), "object required");
  const own = Object.keys(value).sort();
  need(own.length === keys.length && own.every((k, i) => k === [...keys].sort()[i]), "unknown or missing keys");
}
function id(value: unknown): asserts value is string { need(typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(value), "identifier"); }
function digest(value: unknown): asserts value is string { need(typeof value === "string" && /^[a-f0-9]{64}$/u.test(value), "digest"); }
function counter(value: unknown): asserts value is string {
  need(typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/u.test(value) && BigInt(value) <= MAX_COUNTER, "counter");
}
export function nextModelCounter(value: string): string {
  counter(value); need(BigInt(value) < MAX_COUNTER, "counter overflow"); return (BigInt(value) + 1n).toString();
}
function same(left: unknown, right: unknown): boolean { return canonicalModelJson(left) === canonicalModelJson(right); }
function copy<T>(v: T): T { return JSON.parse(canonicalModelJson(v)) as T; }

export interface ModelGenesis {
  kind: "managed-home-retirement-model"; version: 1;
  rootEpoch: string; incarnationId: string; profileId: string; provider: "claude" | "codex";
  creatorId: string; storeEpoch: string; nonce: string;
}
export interface ModelReference { revision: string; digest: string }
export interface FreezeBinding {
  rootEpoch: string; incarnationId: string; provenanceDigest: string; generation: string;
  rosterDigest: string; manifestDigest: string; grantDigest: string; publicationDigest: string;
}
export interface ModelAcknowledgement extends FreezeBinding {
  freezeNonce: string; ownerId: string; storeEpoch: string; sourceBarrierDigest: string;
  resolutionDigest: string; historyDigest: string;
}
export interface IntentResolution { intentId: string; ticket: string; outcome: "aborted" | "retired" }
export type ModelAction =
  | { type: "enroll_owner"; ownerId: string; storeEpoch: string }
  | { type: "owner_presence"; ownerId: string; storeEpoch: string; connected: boolean }
  | { type: "set_grant"; ownerId: string; storeEpoch: string; grantRevision: string; status: "active" | "revoked" }
  | { type: "enroll_intent"; ownerId: string; storeEpoch: string; intentId: string; consumerId: string; consumerKind: ConsumerKind; baseSourceRevision: string; grantRevision: string }
  | { type: "publish"; ownerId: string; storeEpoch: string; intentId: string; ticket: string; sourceRevision: string; sourceDigest: string }
  | { type: "process_started"; consumerId: string }
  | { type: "unknown_history" }
  | { type: "freeze"; binding: FreezeBinding }
  | { type: "source_barrier"; ownerId: string; storeEpoch: string; freezeNonce: string; previousSourceRevision: string; previousSourceDigest: string; sourceRevision: string; sourceDigest: string; grantRevision: string; resolutions: IntentResolution[] }
  | { type: "acknowledge"; ownerId: string; binding: ModelAcknowledgement }
  | { type: "terminal"; freezeNonce: string };
export interface ModelTransition { nonce: string; preimage: ModelReference; action: ModelAction }
export interface ModelSnapshot { kind: "retirement-model-snapshot"; version: 1; genesis: ModelGenesis; events: ModelTransition[] }
interface Owner {
  ownerId: string; storeEpoch: string; connected: boolean; sourceRevision: string; sourceDigest: string;
  grantRevision: string; grantStatus: "active" | "revoked";
}
interface Consumer { consumerId: string; ownerId: string; kind: ConsumerKind; status: "pending" | "live" | "retired" }
interface Intent {
  intentId: string; ownerId: string; consumerId: string; baseSourceRevision: string; grantRevision: string;
  ticket: string; status: "pending" | "published" | "aborted" | "retired";
}
interface Barrier { ownerId: string; digest: string; resolutionDigest: string }
export interface ModelView {
  phase: Phase; generation: string; provenanceDigest: string;
  owners: Owner[]; consumers: Consumer[]; intents: Intent[]; barriers: Barrier[]; acknowledgements: ModelAcknowledgement[];
  processStarts: string[]; unknownHistory: boolean;
  freeze: { nonce: string; binding: FreezeBinding } | null;
}

function checkReference(v: unknown): asserts v is ModelReference {
  object(v, ["revision", "digest"]); counter(v.revision); digest(v.digest);
}
const FREEZE_KEYS = ["rootEpoch", "incarnationId", "provenanceDigest", "generation", "rosterDigest", "manifestDigest", "grantDigest", "publicationDigest"];
function checkBinding(v: unknown, acknowledgement = false): void {
  object(v, [...FREEZE_KEYS, ...(acknowledgement ? ["freezeNonce", "ownerId", "storeEpoch", "sourceBarrierDigest", "resolutionDigest", "historyDigest"] : [])]);
  id(v.rootEpoch); id(v.incarnationId); counter(v.generation);
  for (const k of ["provenanceDigest", "rosterDigest", "manifestDigest", "grantDigest", "publicationDigest"]) digest(v[k]);
  if (acknowledgement) {
    for (const k of ["freezeNonce", "ownerId", "storeEpoch"]) id(v[k]);
    for (const k of ["sourceBarrierDigest", "resolutionDigest", "historyDigest"]) digest(v[k]);
  }
}
const ACTION_KEYS: Record<ModelAction["type"], string[]> = {
  enroll_owner: ["ownerId", "storeEpoch"], owner_presence: ["ownerId", "storeEpoch", "connected"],
  set_grant: ["ownerId", "storeEpoch", "grantRevision", "status"],
  enroll_intent: ["ownerId", "storeEpoch", "intentId", "consumerId", "consumerKind", "baseSourceRevision", "grantRevision"],
  publish: ["ownerId", "storeEpoch", "intentId", "ticket", "sourceRevision", "sourceDigest"],
  process_started: ["consumerId"], unknown_history: [], freeze: ["binding"],
  source_barrier: ["ownerId", "storeEpoch", "freezeNonce", "previousSourceRevision", "previousSourceDigest", "sourceRevision", "sourceDigest", "grantRevision", "resolutions"],
  acknowledge: ["ownerId", "binding"], terminal: ["freezeNonce"],
};
function checkTransition(v: unknown): asserts v is ModelTransition {
  object(v, ["nonce", "preimage", "action"]); id(v.nonce); checkReference(v.preimage);
  need(v.action !== null && typeof v.action === "object", "action");
  const a = v.action as Record<string, unknown>;
  need(typeof a.type === "string" && Object.hasOwn(ACTION_KEYS, a.type), "action type");
  object(a, ["type", ...ACTION_KEYS[a.type as ModelAction["type"]]]);
  for (const k of ["ownerId", "storeEpoch", "consumerId", "intentId", "freezeNonce"]) if (Object.hasOwn(a, k)) id(a[k]);
  for (const k of ["grantRevision", "baseSourceRevision", "sourceRevision", "previousSourceRevision"]) if (Object.hasOwn(a, k)) counter(a[k]);
  for (const k of ["ticket", "sourceDigest", "previousSourceDigest"]) if (Object.hasOwn(a, k)) digest(a[k]);
  if (a.type === "owner_presence") need(typeof a.connected === "boolean", "presence");
  if (a.type === "set_grant") need(a.status === "active" || a.status === "revoked", "grant status");
  if (a.type === "enroll_intent") need(CONSUMER_KINDS.includes(a.consumerKind as ConsumerKind), "consumer kind");
  if (a.type === "freeze" || a.type === "acknowledge") checkBinding(a.binding, a.type === "acknowledge");
  if (a.type === "source_barrier") {
    need(Array.isArray(a.resolutions) && a.resolutions.length <= RETIREMENT_MODEL_LIMITS.rows, "resolutions bound");
    for (const r of a.resolutions) {
      object(r, ["intentId", "ticket", "outcome"]); id(r.intentId); digest(r.ticket);
      need(r.outcome === "aborted" || r.outcome === "retired", "resolution outcome");
    }
  }
}
function checkGenesis(g: unknown): asserts g is ModelGenesis {
  object(g, ["kind", "version", "rootEpoch", "incarnationId", "profileId", "provider", "creatorId", "storeEpoch", "nonce"]);
  need(g.kind === "managed-home-retirement-model" && g.version === 1, "genesis version/kind");
  for (const k of ["rootEpoch", "incarnationId", "profileId", "creatorId", "storeEpoch", "nonce"]) id(g[k]);
  need(g.provider === "claude" || g.provider === "codex", "provider");
}
function newOwner(ownerId: string, storeEpoch: string, sourceDigest: string): Owner {
  return { ownerId, storeEpoch, connected: true, sourceRevision: "0", sourceDigest, grantRevision: "0", grantStatus: "active" };
}
function initial(g: ModelGenesis): ModelView {
  const provenanceDigest = retirementModelDigest("genesis", g);
  return { phase: "open", generation: "0", provenanceDigest, owners: [newOwner(g.creatorId, g.storeEpoch, provenanceDigest)],
    consumers: [], intents: [], barriers: [], acknowledgements: [], processStarts: [], unknownHistory: false, freeze: null };
}
function sorted<T>(rows: T[], key: (row: T) => string): T[] {
  return [...rows].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
}
function binding(g: ModelGenesis, v: ModelView): FreezeBinding {
  return { rootEpoch: g.rootEpoch, incarnationId: g.incarnationId, provenanceDigest: v.provenanceDigest, generation: v.generation,
    rosterDigest: retirementModelDigest("roster", sorted(v.owners.map(o => ({ ownerId: o.ownerId, storeEpoch: o.storeEpoch })), o => o.ownerId)),
    manifestDigest: retirementModelDigest("manifest", { consumers: sorted(v.consumers, c => c.consumerId), intents: sorted(v.intents, i => i.intentId) }),
    grantDigest: retirementModelDigest("grants", sorted(v.owners.map(o => ({ ownerId: o.ownerId, revision: o.grantRevision, status: o.grantStatus })), o => o.ownerId)),
    publicationDigest: retirementModelDigest("publication", sorted(v.owners.map(o => ({ ownerId: o.ownerId, revision: o.sourceRevision, digest: o.sourceDigest })), o => o.ownerId)) };
}
function owner(v: ModelView, ownerId: string, storeEpoch?: string): Owner {
  const result = v.owners.find(o => o.ownerId === ownerId);
  need(result && (storeEpoch === undefined || result.storeEpoch === storeEpoch), "owner/store continuity");
  return result;
}
function acknowledgement(v: ModelView, ownerId: string): ModelAcknowledgement {
  need(v.freeze, "not frozen"); const o = owner(v, ownerId);
  const b = v.barriers.find(b => b.ownerId === ownerId); need(b, "missing source barrier");
  return { ...v.freeze.binding, freezeNonce: v.freeze.nonce, ownerId, storeEpoch: o.storeEpoch,
    sourceBarrierDigest: b.digest, resolutionDigest: b.resolutionDigest,
    historyDigest: retirementModelDigest("retirement", { provenanceDigest: v.provenanceDigest, processStarts: v.processStarts, unknownHistory: v.unknownHistory }) };
}
function step(g: ModelGenesis, v: ModelView, event: ModelTransition): void {
  const a = event.action;
  need(v.phase !== "terminal_eligible", "terminal is irreversible");
  const openOnly = ["enroll_owner", "set_grant", "enroll_intent", "publish", "process_started", "freeze"];
  if (openOnly.includes(a.type)) need(v.phase === "open", "admission frozen");
  if (a.type === "enroll_owner") {
    need(!v.owners.some(o => o.ownerId === a.ownerId), "historical owner cannot be replaced");
    v.owners.push(newOwner(a.ownerId, a.storeEpoch, retirementModelDigest("genesis", { genesis: v.provenanceDigest, ownerId: a.ownerId, storeEpoch: a.storeEpoch })));
  } else if (a.type === "owner_presence") {
    owner(v, a.ownerId, a.storeEpoch).connected = a.connected;
  } else if (a.type === "set_grant") {
    const o = owner(v, a.ownerId, a.storeEpoch); need(o.connected && o.grantRevision === a.grantRevision, "grant preimage");
    o.grantRevision = nextModelCounter(o.grantRevision); o.grantStatus = a.status;
  } else if (a.type === "enroll_intent") {
    const o = owner(v, a.ownerId, a.storeEpoch);
    need(o.connected && o.grantStatus === "active" && o.grantRevision === a.grantRevision && o.sourceRevision === a.baseSourceRevision, "enrollment preimage");
    need(!v.intents.some(i => i.intentId === a.intentId) && !v.consumers.some(c => c.consumerId === a.consumerId), "consumer/intent reuse");
    const ticket = retirementModelDigest("publication", { genesis: v.provenanceDigest, event });
    v.intents.push({ intentId: a.intentId, ownerId: a.ownerId, consumerId: a.consumerId, baseSourceRevision: a.baseSourceRevision,
      grantRevision: a.grantRevision, ticket, status: "pending" });
    v.consumers.push({ consumerId: a.consumerId, ownerId: a.ownerId, kind: a.consumerKind, status: "pending" });
  } else if (a.type === "publish") {
    const o = owner(v, a.ownerId, a.storeEpoch), i = v.intents.find(i => i.intentId === a.intentId);
    need(o.connected && o.grantStatus === "active" && i && i.ownerId === o.ownerId && i.ticket === a.ticket && i.status === "pending" &&
      i.grantRevision === o.grantRevision && i.baseSourceRevision === o.sourceRevision && a.sourceRevision === nextModelCounter(o.sourceRevision), "publication preimage");
    o.sourceRevision = a.sourceRevision; o.sourceDigest = a.sourceDigest; i.status = "published";
    v.consumers.find(c => c.consumerId === i.consumerId)!.status = "live";
  } else if (a.type === "process_started") {
    need(v.consumers.some(c => c.consumerId === a.consumerId && c.status === "live"), "process admission missing");
    v.processStarts.push(event.nonce);
  } else if (a.type === "unknown_history") v.unknownHistory = true;
  else if (a.type === "freeze") {
    need(same(a.binding, binding(g, v)), "freeze preimage"); v.phase = "frozen"; v.freeze = { nonce: event.nonce, binding: copy(a.binding) };
  } else if (a.type === "source_barrier") {
    need(v.phase === "frozen" && v.freeze?.nonce === a.freezeNonce, "freeze barrier preimage");
    const o = owner(v, a.ownerId, a.storeEpoch);
    need(o.connected && !v.barriers.some(b => b.ownerId === o.ownerId), "source barrier already sealed or owner disconnected");
    need(a.previousSourceRevision === o.sourceRevision && a.previousSourceDigest === o.sourceDigest &&
      a.sourceRevision === nextModelCounter(o.sourceRevision) && a.grantRevision === o.grantRevision, "source/grant barrier preimage");
    const mine = v.intents.filter(i => i.ownerId === o.ownerId);
    need(a.resolutions.length === mine.length && new Set(a.resolutions.map(r => r.intentId)).size === mine.length, "incomplete intent resolution");
    for (const r of a.resolutions) {
      const i = mine.find(i => i.intentId === r.intentId);
      need(i && i.ticket === r.ticket && (i.status === "pending" || i.status === "published") &&
        (r.outcome !== "aborted" || i.status === "pending"), "intent/source barrier mismatch");
      i.status = r.outcome; v.consumers.find(c => c.consumerId === i.consumerId)!.status = "retired";
    }
    o.sourceRevision = a.sourceRevision; o.sourceDigest = a.sourceDigest;
    if (o.grantStatus === "active") o.grantRevision = nextModelCounter(o.grantRevision);
    o.grantStatus = "revoked";
    v.barriers.push({ ownerId: o.ownerId, digest: retirementModelDigest("barrier", { freeze: v.freeze, action: a, grantRevision: o.grantRevision }),
      resolutionDigest: retirementModelDigest("retirement", sorted(a.resolutions, r => r.intentId)) });
  } else if (a.type === "acknowledge") {
    need(v.phase === "frozen" && owner(v, a.ownerId).connected, "acknowledgement admission");
    need(!v.acknowledgements.some(ack => ack.ownerId === a.ownerId) && same(a.binding, acknowledgement(v, a.ownerId)), "acknowledgement binding");
    v.acknowledgements.push(copy(a.binding));
  } else {
    need(v.phase === "frozen" && v.freeze?.nonce === a.freezeNonce, "terminal freeze");
    need(!v.unknownHistory && v.processStarts.length === 0, "no-process history unproved");
    need(v.intents.every(i => i.status === "aborted" || i.status === "retired") && v.consumers.every(c => c.status === "retired"), "outstanding consumers/intents");
    need(v.owners.every(o => o.connected && o.grantStatus === "revoked" &&
      v.acknowledgements.some(ack => ack.ownerId === o.ownerId && same(ack, acknowledgement(v, o.ownerId)))), "missing owner acknowledgement");
    v.phase = "terminal_eligible";
  }
  need(v.owners.length + v.consumers.length + v.intents.length <= RETIREMENT_MODEL_LIMITS.rows, "combined row bound");
  // Frozen generation remains fixed even while barrier/ack records advance the state revision.
  if (v.phase === "open") v.generation = nextModelCounter(v.generation);
  canonicalModelJson(v);
}

function reference(snapshot: ModelSnapshot): ModelReference {
  return { revision: String(snapshot.events.length), digest: retirementModelDigest("state", snapshot) };
}
function replay(input: unknown): { snapshot: ModelSnapshot; view: ModelView } {
  // Canonicalization first rejects accessors/cycles/exotic values before any field reads.
  const snapshot: unknown = JSON.parse(canonicalModelJson(input));
  object(snapshot, ["kind", "version", "genesis", "events"]);
  need(snapshot.kind === "retirement-model-snapshot" && snapshot.version === 1, "snapshot version/kind");
  checkGenesis(snapshot.genesis);
  need(Array.isArray(snapshot.events) && snapshot.events.length <= RETIREMENT_MODEL_LIMITS.events, "history bound");
  const prefix: ModelSnapshot = { kind: "retirement-model-snapshot", version: 1, genesis: snapshot.genesis, events: [] };
  const view = initial(prefix.genesis), nonces = new Set([prefix.genesis.nonce]);
  for (const event of snapshot.events) {
    checkTransition(event); need(!nonces.has(event.nonce), "nonce reuse");
    need(same(event.preimage, reference(prefix)), "history CAS preimage");
    step(prefix.genesis, view, event); prefix.events.push(event); nonces.add(event.nonce);
  }
  return { snapshot: prefix, view };
}
export function createRetirementModel(genesis: ModelGenesis): ModelSnapshot {
  return replay({ kind: "retirement-model-snapshot", version: 1, genesis, events: [] }).snapshot;
}
export function inspectRetirementModel(snapshot: unknown): ModelView { return replay(snapshot).view; }
export function retirementModelReference(snapshot: unknown): ModelReference { return reference(replay(snapshot).snapshot); }
export function retirementModelFreezeBinding(snapshot: unknown): FreezeBinding {
  const { snapshot: s, view } = replay(snapshot); need(view.phase === "open", "already frozen"); return binding(s.genesis, view);
}
export function retirementModelAcknowledgement(snapshot: unknown, ownerId: string): ModelAcknowledgement {
  return acknowledgement(replay(snapshot).view, ownerId);
}
export function applyRetirementModelTransition(input: unknown, transition: unknown): ModelSnapshot {
  const { snapshot, view } = replay(input);
  const event: unknown = JSON.parse(canonicalModelJson(transition)); checkTransition(event);
  const previous = snapshot.events.find(e => e.nonce === event.nonce);
  if (previous) { need(same(previous, event), "nonce reuse"); return snapshot; }
  need(event.nonce !== snapshot.genesis.nonce, "genesis nonce reuse");
  need(same(event.preimage, reference(snapshot)), "CAS preimage");
  need(snapshot.events.length < RETIREMENT_MODEL_LIMITS.events, "history bound");
  step(snapshot.genesis, view, event);
  const next = { ...snapshot, events: [...snapshot.events, event] };
  canonicalModelJson(next); return next;
}

/** Simulated atomic storage only. Copying protects stored preimages from caller mutation. Restore
 * requires an independent expected anchor; accepting a self-supplied anchor attests nothing real. */
export class SyntheticRetirementModelStore {
  private current: ModelSnapshot;
  constructor(snapshot: unknown, expectedAnchor: ModelReference) {
    const parsed = replay(snapshot).snapshot;
    need(same(reference(parsed), expectedAnchor), "restore anchor mismatch"); this.current = parsed;
  }
  read(): ModelSnapshot { return copy(this.current); }
  compareAndSwap(event: unknown): ModelSnapshot {
    const next = applyRetirementModelTransition(this.current, event);
    this.current = next; return this.read();
  }
}
