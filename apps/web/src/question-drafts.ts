import { parentControlRequestEligible, type AgentQuestion, type PendingApproval } from "@wollipog/protocol";
import type { QuestionResponseDraft } from "./question-response.js";

const STORAGE_PREFIX = "wollipog:question-drafts:v1:";
const LIMIT = 50;
const MAX_CHARS = 200_000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
interface Draft { values: Record<string, QuestionResponseDraft>; step: number }
interface Binding {
  scope: string;
  requestId: string;
  questions: readonly AgentQuestion[];
  durable: boolean;
}
interface RecordEntry extends Draft { sessionId: string; key: string; savedAt: number }
const bindings = new Map<string, Binding>();
const memory = new Map<string, Draft>();

// A schema discriminator, not a security digest. No question/context text is written as metadata.
function schemaDiscriminator(questions: readonly AgentQuestion[]): string {
  let hash = 0xcbf29ce484222325n;
  for (const character of JSON.stringify(questions)) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(character.codePointAt(0)!)) * 0x100000001b3n);
  }
  return hash.toString(16);
}

/** Provider ids can repeat. Only a server occurrence or occurrence time permits reload recovery;
 * legacy requests retain page-only drafts. The instance, epoch and schema fence every surface. */
export function questionDraftIdentity(
  requestId: string,
  questions: readonly AgentQuestion[],
  occurrenceId?: string,
  requestedAt?: number,
  scope = "local",
  recoveryId?: string,
): string {
  const epoch = occurrenceId || (Number.isSafeInteger(requestedAt) && requestedAt! > 0 ? requestedAt : null);
  const key = JSON.stringify([scope, requestId, epoch, recoveryId ?? null, schemaDiscriminator(questions)]);
  bindings.delete(key);
  bindings.set(key, { scope, requestId, questions, durable: epoch !== null });
  while (bindings.size > LIMIT * 4) bindings.delete(bindings.keys().next().value!);
  return key;
}

function storage(): Storage | undefined {
  try { return typeof window === "undefined" ? undefined : window.sessionStorage; } catch { return undefined; }
}

function records(scope: string): RecordEntry[] {
  try {
    const raw = storage()?.getItem(STORAGE_PREFIX + scope);
    if (!raw) return [];
    if (raw.length > MAX_CHARS) throw new Error("oversize draft storage");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length > LIMIT) throw new Error("invalid draft storage");
    return parsed.filter((entry): entry is RecordEntry => {
      if (!entry || typeof entry !== "object" || typeof entry.sessionId !== "string" || typeof entry.key !== "string" ||
          !Number.isSafeInteger(entry.step) || entry.step < 0 || !Number.isFinite(entry.savedAt) ||
          entry.savedAt > Date.now() || Date.now() - entry.savedAt > MAX_AGE_MS ||
          !entry.values || typeof entry.values !== "object" || Array.isArray(entry.values)) return false;
      return Object.values(entry.values).every((value: unknown) => {
        if (!value || typeof value !== "object") return false;
        const draft = value as QuestionResponseDraft;
        return draft.kind === "choice" ? Array.isArray(draft.labels) && draft.labels.length <= 100 &&
          draft.labels.every((label) => typeof label === "string" && label.length <= 4000)
          : (draft.kind === "entry" || draft.kind === "other") && typeof draft.value === "string" && draft.value.length <= 4000;
      });
    });
  } catch {
    try { storage()?.removeItem(STORAGE_PREFIX + scope); } catch { /* Storage may be disabled. */ }
    return [];
  }
}

function save(scope: string, entries: RecordEntry[]): void {
  try {
    while (entries.length > LIMIT || JSON.stringify(entries).length > MAX_CHARS) entries.shift();
    if (entries.length) storage()?.setItem(STORAGE_PREFIX + scope, JSON.stringify(entries));
    else storage()?.removeItem(STORAGE_PREFIX + scope);
  } catch { /* Drafts remain available in this page when browser storage is unavailable. */ }
}

function safeValues(binding: Binding, values: Record<string, QuestionResponseDraft>): Record<string, QuestionResponseDraft> {
  const safe: Record<string, QuestionResponseDraft> = {};
  for (const question of binding.questions) {
    // Apply the same conservative sensitive-field classification used by campaign routing.
    if (!parentControlRequestEligible("questions", { requestId: "draft", title: "", options: [], kind: "question", questions: [question] }) ||
        !Object.hasOwn(values, question.id)) continue;
    const value = values[question.id]!;
    if (value.kind === "choice") {
      if (value.labels.some((label) => !question.options.some((option) => option.label === label)) ||
          new Set(value.labels).size !== value.labels.length || (!question.multiSelect && value.labels.length > 1)) continue;
    } else if (value.value.length > Math.min(question.maxLength ?? 4000, 4000)) continue;
    Object.defineProperty(safe, question.id, { value: structuredClone(value), enumerable: true, configurable: true, writable: true });
  }
  return safe;
}

const memoryKey = (sessionId: string, key: string) => JSON.stringify([sessionId, key]);

function read(sessionId: string, key: string): Draft {
  const binding = bindings.get(key);
  const current = memory.get(memoryKey(sessionId, key));
  const persisted = !current && binding?.durable ? records(binding.scope).find((entry) => entry.sessionId === sessionId && entry.key === key) : undefined;
  const draft = current ?? persisted ?? { values: {}, step: 0 };
  return { values: binding ? safeValues(binding, draft.values) : structuredClone(draft.values),
    step: binding ? Math.min(draft.step, Math.max(0, binding.questions.length - 1)) : draft.step };
}

export function storedQuestionDrafts(sessionId: string, key: string): Record<string, QuestionResponseDraft> {
  return read(sessionId, key).values;
}
export function storedQuestionStep(sessionId: string, key: string): number { return read(sessionId, key).step; }

function update(sessionId: string, key: string, patch: Partial<Draft>): void {
  const binding = bindings.get(key);
  const draft = { ...read(sessionId, key), ...patch };
  if (binding) draft.values = safeValues(binding, draft.values);
  const id = memoryKey(sessionId, key);
  memory.delete(id);
  memory.set(id, structuredClone(draft));
  while (memory.size > LIMIT) memory.delete(memory.keys().next().value!);
  if (binding?.durable) save(binding.scope, [
    ...records(binding.scope).filter((entry) => entry.sessionId !== sessionId || entry.key !== key),
    { ...draft, sessionId, key, savedAt: Date.now() },
  ]);
}
export function storeQuestionDrafts(sessionId: string, key: string, values: Record<string, QuestionResponseDraft>): void {
  update(sessionId, key, { values });
}
export function storeQuestionStep(sessionId: string, key: string, step: number): void { update(sessionId, key, { step }); }

export function clearQuestionDrafts(sessionId: string, key: string): void {
  memory.delete(memoryKey(sessionId, key));
  const binding = bindings.get(key);
  if (binding) save(binding.scope, records(binding.scope).filter((entry) => entry.sessionId !== sessionId || entry.key !== key));
  else {
    // A captured exact key remains clearable after its validator leaves the bounded registry.
    try {
      const parts: unknown = JSON.parse(key);
      if (Array.isArray(parts) && parts.length === 5 && typeof parts[0] === "string") {
        save(parts[0], records(parts[0]).filter((entry) => entry.sessionId !== sessionId || entry.key !== key));
        return;
      }
    } catch { /* A legacy provider id is not a JSON draft identity. */ }
    // Legacy lifecycle callers hold the provider id, rather than the bound draft identity.
    for (const [identity, candidate] of bindings) if (candidate.requestId === key || `${candidate.requestId}:${JSON.parse(identity)[2]}` === key) {
      clearQuestionDrafts(sessionId, identity);
    }
  }
}

/** Called for authoritative session updates, even when no question card is mounted. */
export function reconcileQuestionDrafts(sessionId: string, requests: readonly PendingApproval[], scope = "local"): void {
  const questions = requests.filter((request) => request.kind === "question");
  const live = (key: string) => {
    try {
      const [owner, requestId, epoch, recoveryId, schema] = JSON.parse(key);
      return owner === scope && questions.some((request) => request.requestId === requestId &&
        (request.occurrenceId || request.requestedAt || null) === epoch && (request.recoveryId ?? null) === recoveryId &&
        (request.questions === undefined || schemaDiscriminator(request.questions) === schema));
    } catch { return false; }
  };
  const persisted = records(scope);
  const remaining = persisted.filter((entry) => entry.sessionId !== sessionId || live(entry.key));
  // Most upserts have no draft lifecycle change. Do not rewrite the browser store for them.
  if (remaining.length !== persisted.length) save(scope, remaining);
  for (const id of memory.keys()) {
    const [owner, key] = JSON.parse(id) as [string, string];
    if (owner === sessionId && bindings.get(key)?.scope === scope && !live(key)) memory.delete(id);
  }
}
