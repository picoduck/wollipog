import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { budgetApi, collectHealth, githubApi, readHealthState } from './main-ci-health.mjs';
import { workerIdentity, WORKER } from './main-rolling-validation.mjs';
import { INVESTIGATION_PROMPT, LIMITS, PARAMETERS } from './main-regression-policy.mjs';

export const STATE_REF = 'refs/heads/ci/main-regression-automation-state';
const SHA = /^[a-f0-9]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ID = /^[A-Za-z0-9_]{1,100}$/;
const positive = n => Number.isSafeInteger(n) && n > 0;
const fail = reason => { throw Object.assign(new Error(reason), { reason }); };
const digest = value => createHash('sha256').update(value).digest('hex');
const terminal = new Set(['succeeded', 'failed', 'ceiling_paused', 'skipped', 'expired']);
const receiptStates = new Set(['pending', 'dispatched', 'skipped', 'expired', 'rejected']);

export function validateWake(event, repository) {
  const identity = workerIdentity(event?.workflow_run, repository);
  if (event?.action !== 'completed' || !identity || event.workflow_run.status !== 'completed') fail('untrusted-wake');
  return identity;
}

export function emptyState(repository) {
  return { version: 1, repository, sequence: 0, active: null, pending: null, seen: [], binding: null, blocked: null };
}
const validCandidate = c => c && positive(c.runId) && positive(c.attempt) && c.attempt <= 10 &&
  SHA.test(c.testedSha) && /^[a-f0-9]{64}$/.test(c.suiteVersion) &&
  (c.passingSha === 'none' || SHA.test(c.passingSha)) && Number.isSafeInteger(c.observedAt) && c.observedAt > 0;
const key = c => `${c.testedSha}:${c.suiteVersion}`;
export function validState(s, repository) {
  return s?.version === 1 && s.repository === repository && Number.isSafeInteger(s.sequence) && s.sequence >= 0 &&
    (s.binding === null || /^[a-f0-9]{64}$/.test(s.binding)) &&
    Array.isArray(s.seen) && s.seen.length <= LIMITS.ledgerEntries && new Set(s.seen).size === s.seen.length &&
    s.seen.every(k => /^[a-f0-9]{40}:[a-f0-9]{64}$/.test(k)) &&
    (s.pending === null || validCandidate(s.pending)) &&
    (s.active === null || validCandidate(s.active) && s.seen.includes(key(s.active)) &&
      Number.isSafeInteger(s.active.createdAt) && s.active.createdAt > 0 &&
      Number.isSafeInteger(s.active.tries) && s.active.tries >= 0 && s.active.tries <= LIMITS.deliveryAttempts &&
      Number.isSafeInteger(s.active.lastSentAt) && s.active.lastSentAt >= 0 &&
      Number.isSafeInteger(s.active.stopTries) && s.active.stopTries >= 0 && s.active.stopTries <= 3 &&
      (s.active.executionId === null || ID.test(s.active.executionId)) &&
      (s.active.invocationId === null || ID.test(s.active.invocationId))) &&
    (s.blocked === null || ['delivery-exhausted', 'elapsed-exhausted', 'ledger-exhausted', 'delivery-rejected'].includes(s.blocked));
}

/** Durable tombstones never evict silently: bounded storage exhaustion requires an operator. */
export async function readState(api, repository) {
  let ref;
  try { ref = await api(`/repos/${repository}/git/ref/heads/ci/main-regression-automation-state`); }
  catch (e) { if (e.status === 404) return { oid: null, value: emptyState(repository) }; throw e; }
  const oid = ref?.object?.sha;
  if (!SHA.test(oid)) fail('invalid-state-ref');
  const file = await api(`/repos/${repository}/contents/state.json?ref=${oid}`);
  if (file?.type !== 'file' || file.encoding !== 'base64' || !Number.isSafeInteger(file.size) || file.size > 65536 ||
      !SHA.test(file.sha) || typeof file.content !== 'string' || file.content.length > 90000) fail('invalid-state');
  let value;
  try { value = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')); } catch { fail('invalid-state'); }
  if (!validState(value, repository)) fail('invalid-state');
  return { oid, value };
}
export async function writeState(api, repository, previous, value) {
  value = { ...value, sequence: previous.value.sequence + 1 };
  if (!validState(value, repository)) fail('invalid-state-write');
  const root = `/repos/${repository}`, compact = value.sequence % 128 === 0;
  const tree = await api(`${root}/git/trees`, { method: 'POST', body: { tree: [
    { path: 'state.json', mode: '100644', type: 'blob', content: JSON.stringify(value) + '\n' },
  ] } });
  const commit = await api(`${root}/git/commits`, { method: 'POST', body: {
    message: 'Reconcile bounded main regression investigation', tree: tree.sha,
    parents: previous.oid && !compact ? [previous.oid] : [],
  } });
  if (!SHA.test(commit?.sha)) fail('invalid-state-commit');
  const repo = await api(root);
  const result = await api('/graphql', { method: 'POST', body: {
    query: 'mutation($input:UpdateRefsInput!){updateRefs(input:$input){clientMutationId}}',
    variables: { input: { repositoryId: repo.node_id, refUpdates: [{ name: STATE_REF,
      beforeOid: previous.oid ?? '0'.repeat(40), afterOid: commit.sha, force: Boolean(previous.oid && compact) }] } },
  } });
  if (result?.errors?.length || !result?.data?.updateRefs) fail('state-conflict');
  return { oid: commit.sha, value };
}

/** Reuse independent exact-attempt health verification; never trust a health artifact/ref verdict. */
export async function selectCandidate(repository, health, api, now) {
  if (health.repository !== repository || health.status !== 'failing') return null;
  const failures = health.unresolvedFailures.filter(r => r.source === 'rolling-full' && r.result === 'failing' &&
    r.workflowPath === WORKER && r.workflowAncestryVerified && r.targetAncestryVerified)
    .sort((a, b) => b.runId - a.runId || b.attempt - a.attempt);
  const failure = failures[0];
  if (!failure) return null;
  const candidate = { runId: failure.runId, attempt: failure.attempt, testedSha: failure.testedSha,
    suiteVersion: failure.suiteVersion, passingSha: 'none', observedAt: now };
  if (!validCandidate(candidate)) fail('invalid-failure-evidence');
  const passes = currentPasses(health).filter(r =>
    r.suiteVersion === failure.suiteVersion && r.testedSha !== failure.testedSha && r.runId < failure.runId)
    .sort((a, b) => b.runId - a.runId);
  if (passes.length > 8) fail('comparison-budget-exhausted');
  for (const pass of passes) {
    if (!SHA.test(pass.testedSha)) fail('invalid-comparison');
    const comparison = await api(`/repos/${repository}/compare/${pass.testedSha}...${failure.testedSha}?per_page=1`);
    if (comparison?.merge_base_commit?.sha === pass.testedSha) { candidate.passingSha = pass.testedSha; break; }
  }
  return candidate;
}

function currentPasses(health) {
  return health.evidence.filter(r => r.certification === 'full' && r.result === 'passing' &&
    !health.evidence.some(other => other.testedSha === r.testedSha && other.result !== 'non-verdict' &&
      (other.runId > r.runId || other.runId === r.runId && other.attempt > r.attempt)) &&
    !(health.legacyEvidence ?? []).some(other => other.testedSha === r.testedSha &&
      other.result === 'failing' && other.runId > r.runId));
}

/** Persisted coordination fields never supply their own forge verdict. Revalidate before every send. */
export async function verifyIntent(repository, intent, health, api) {
  const record = health.evidence.find(r => r.runId === intent.runId && r.attempt === intent.attempt &&
    r.testedSha === intent.testedSha && r.suiteVersion === intent.suiteVersion &&
    r.source === 'rolling-full' && r.result === 'failing' && r.workflowPath === WORKER &&
    r.workflowAncestryVerified && r.targetAncestryVerified);
  if (!record || health.repository !== repository || health.status === 'unknown') return false;
  if (intent.passingSha !== 'none') {
    const pass = currentPasses(health).find(r => r.testedSha === intent.passingSha &&
      r.suiteVersion === intent.suiteVersion && r.runId < intent.runId);
    if (!pass) return false;
    const comparison = await api(`/repos/${repository}/compare/${intent.passingSha}...${intent.testedSha}?per_page=1`);
    if (comparison?.merge_base_commit?.sha !== intent.passingSha) return false;
  }
  return true;
}

export function deliveryBody(repository, candidate) {
  if (!REPO.test(repository) || !validCandidate(candidate)) fail('invalid-delivery');
  return JSON.stringify({ eventId: `main-regression:${candidate.runId}:${candidate.attempt}`,
    parameters: { repository, run_id: String(candidate.runId), attempt: String(candidate.attempt),
      tested_sha: candidate.testedSha, passing_sha: candidate.passingSha } });
}
export function signDelivery(body, triggerId, secret, now, nonce = randomBytes(18).toString('base64url')) {
  const timestamp = String(Math.floor(now / 1000));
  return { 'content-type': 'application/vnd.wollipog.automation-trigger+json',
    'x-wollipog-timestamp': timestamp, 'x-wollipog-nonce': nonce,
    'x-wollipog-signature': 'v1=' + createHmac('sha256', secret)
      .update(`v1\n${timestamp}\n${nonce}\n${triggerId}\n${digest(body)}`).digest('hex') };
}

/** Called before any send. Same-SHA/suite infrastructure reruns cannot buy another investigation. */
export function plan(state, candidate, now) {
  const next = structuredClone(state);
  if (next.blocked) return { next, reason: next.blocked };
  let reason = 'no-regression';
  if (candidate) {
    if (next.seen.includes(key(candidate))) reason = 'duplicate-or-rerun-suppressed';
    else { next.pending = next.pending && key(next.pending) === key(candidate) ? next.pending : candidate;
      reason = next.active ? 'pending-coalesced' : 'pending'; }
  } else next.pending = null;
  if (next.pending && now - next.pending.observedAt >= LIMITS.pendingMs) {
    if (!next.seen.includes(key(next.pending))) {
      if (next.seen.length >= LIMITS.ledgerEntries) next.blocked = 'ledger-exhausted';
      else next.seen.push(key(next.pending));
    }
    next.pending = null; reason = 'pending-expired';
  }
  if (!next.active && next.pending && !next.blocked) {
    if (next.seen.length >= LIMITS.ledgerEntries) next.blocked = 'ledger-exhausted';
    else {
      next.seen.push(key(next.pending));
      next.active = { ...next.pending, createdAt: now, tries: 0, lastSentAt: 0,
        stopTries: 0, invocationId: null, executionId: null };
      next.pending = null; reason = 'claimed';
    }
  }
  return { next, reason };
}

export function validateAutomation(payload, triggers, config) {
  const a = payload?.automation, trigger = triggers?.triggers?.find(t => t.triggerId === config.triggerId);
  if (!a || a.automationId !== config.automationId || a.revision !== config.revision || !a.enabled ||
      a.concurrencyPolicy !== 'wait' || a.runnerPolicy?.kind !== 'expire' ||
      !positive(a.runnerPolicy.afterMinutes) || a.runnerPolicy.afterMinutes > LIMITS.pendingMs / 60000 ||
      a.action?.kind !== 'create_session' || a.action.request?.useWorktree !== true ||
      a.action.request?.prompt !== INVESTIGATION_PROMPT ||
      a.limits?.maxCostUsd !== LIMITS.maxCostUsd || a.limits?.maxToolCalls !== LIMITS.maxToolCalls ||
      digest(JSON.stringify(a.action)) !== config.actionDigest || !Array.isArray(payload.executions) ||
      !trigger || trigger.automationId !== a.automationId || trigger.kind !== 'webhook' ||
      trigger.generation !== config.generation || trigger.deliveryPolicy?.allowPrompt !== false ||
      trigger.deliveryPolicy.missingReferences !== 'reject' ||
      !isDeepStrictEqual(trigger.deliveryPolicy.parameterNames, PARAMETERS) ||
      (trigger.deliveryPolicy.sessionSelectors?.length ?? 0) !== 0) fail('automation-policy-mismatch');
  // Legacy automations require a cron. Its annual delivery must stop before doing work.
  if (a.cron !== '0 0 1 1 *' || a.timezone !== 'UTC') fail('automation-cron-mismatch');
  return a;
}

export function controlClient(config, fetchImpl = fetch) {
  const origin = new URL(config.origin);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash)
    fail('invalid-control-plane-origin');
  let calls = 0;
  return async (path, { method = 'GET', body, headers } = {}) => {
    if (++calls > 6) fail('control-plane-budget-exhausted');
    let response;
    try {
      response = await fetchImpl(new URL(path, origin), { method, redirect: 'error',
        headers: headers ?? { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body }), signal: AbortSignal.timeout(10000) });
    } catch { fail('control-plane-unavailable'); }
    if (!response.ok) fail([400, 401, 403, 409, 413, 415].includes(response.status)
      ? 'control-plane-rejected' : 'control-plane-unavailable');
    const text = await boundedText(response, 256 * 1024);
    try { return JSON.parse(text); } catch { fail('invalid-control-plane-receipt'); }
  };
}
async function boundedText(response, limit) {
  let size = 0; const chunks = [];
  if (!response.body) fail('missing-response');
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > limit) fail('response-too-large');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** CAS intent precedes every external mutation; ambiguous dispatch retains its occupancy fence. */
export async function reconcile(repository, { api, control, config, now = Date.now,
  collect = collectHealth, dryRun = true, log = () => {} } = {}) {
  let previous = await readState(api, repository);
  const healthHints = await readHealthState(api, repository);
  const health = await collect(repository, { api, pointers: [...new Set([...healthHints.pointers,
    ...[previous.value.active?.runId, previous.value.pending?.runId].filter(positive)])] });
  const candidate = await selectCandidate(repository, health, api, now());
  const decision = plan(previous.value, candidate, now());
  let state = decision.next;
  const save = async () => {
    if (!isDeepStrictEqual(previous.value, state)) {
      const stored = await writeState(api, repository, previous, state);
      previous = { ...stored, value: structuredClone(stored.value) };
      state.sequence = stored.value.sequence;
    }
  };
  const report = status => ({ status, healthStatus: health.status, active: state.active && {
    runId: state.active.runId, attempt: state.active.attempt, tries: state.active.tries, stopTries: state.active.stopTries,
    eventId: `main-regression:${state.active.runId}:${state.active.attempt}`,
    invocationId: state.active.invocationId, executionId: state.active.executionId },
    pending: state.pending && { runId: state.pending.runId, attempt: state.pending.attempt },
    ledgerEntries: state.seen.length, blocked: state.blocked });
  if (dryRun) return { ...report('dry-run'), planned: decision.reason };
  const binding = digest(JSON.stringify([config.origin, config.automationId, config.revision,
    config.triggerId, config.generation, config.actionDigest]));
  if (state.binding && state.binding !== binding) fail('activation-binding-changed');
  state.binding = binding;
  await save();
  const a = state.active;
  if (!a) return report(state.blocked ?? decision.reason);
  const payload = await control(`/api/automations/${config.automationId}`);
  const executionKey = `trigger:${config.triggerId}:main-regression:${a.runId}:${a.attempt}`;
  if (!Array.isArray(payload?.executions)) fail('execution-provenance-unavailable');
  // Read-only recovery works even if an accepted send lost its response or its old failure
  // is now covered by a passing descendant. Never replay stale evidence just to find a receipt.
  if (!a.executionId && a.tries > 0) {
    const matches = payload.executions.filter(e => e.idempotencyKey === executionKey &&
      e.automationId === config.automationId && e.automationRevision === config.revision && e.actionKind === 'create_session');
    if (matches.length > 1) fail('execution-provenance-unavailable');
    if (matches.length === 1) {
      if (!ID.test(matches[0].executionId ?? '')) fail('execution-provenance-unavailable');
      a.executionId = matches[0].executionId; await save();
    }
  }
  // Existing exact executions are supervised under their recorded binding/revision. Future
  // policy/helper/docs changes can prevent new sends but cannot disable their timeout/settlement.
  if (a.executionId) {
    const execution = payload.executions.find(e => e.executionId === a.executionId);
    if (!execution || execution.automationId !== config.automationId || execution.automationRevision !== config.revision ||
        execution.actionKind !== 'create_session' ||
        execution.idempotencyKey !== executionKey)
      fail('execution-provenance-unavailable');
    if (terminal.has(execution.status)) {
      state.active = null;
      if (['elapsed-exhausted', 'delivery-exhausted', 'delivery-rejected'].includes(state.blocked)) state.blocked = null;
      await save();
      return report(`investigation-${execution.status}`);
    }
    if (now() - a.createdAt >= LIMITS.elapsedMs) {
      if (a.stopTries >= 3 || !ID.test(execution.sessionId ?? '')) {
        state.blocked = 'elapsed-exhausted'; await save(); return report('elapsed-exhausted-operator-required');
      }
      a.stopTries++; await save();
      await control(`/api/sessions/${execution.sessionId}/stop`, { method: 'POST', body: '{}' });
      // A stop response never proves completion; retain occupancy until execution settlement.
      return report('elapsed-stop-requested');
    }
    return report('investigation-active');
  }
  const triggers = await control(`/api/automations/${config.automationId}/triggers`);
  validateAutomation(payload, triggers, config);
  // Old adapters used the delivery-exhausted hold even when no send was charged.
  // Only that provably never-sent, elapsed claim may re-enter evidence validation.
  const neverSent = a.tries === 0 && a.lastSentAt === 0 && a.stopTries === 0 &&
    a.invocationId === null && a.executionId === null;
  const expiredNeverSent = neverSent && now() - a.createdAt >= LIMITS.elapsedMs;
  if (state.blocked && !(state.blocked === 'delivery-exhausted' && expiredNeverSent)) return report(state.blocked);
  let verified = null;
  if (a.tries === 0) {
    verified = await verifyIntent(repository, a, health, api);
    if (!verified && a.passingSha !== 'none' &&
        await verifyIntent(repository, { ...a, passingSha: 'none' }, health, api)) {
      // Before the first charged send there are no accepted body bytes to preserve.
      // A withdrawn comparison disables attribution; it does not withdraw the failure.
      a.passingSha = 'none'; verified = true; await save();
    }
    if (!verified) {
      const resolved = health.repository === repository && health.status !== 'unknown' &&
        [...(health.resolvedRunIds ?? []), ...(health.supersededRunIds ?? [])].includes(a.runId) &&
        !health.unresolvedFailures.some(r => r.testedSha === a.testedSha && r.suiteVersion === a.suiteVersion);
      if (!resolved) return report('dispatch-evidence-unavailable-operator-required');
      // Positive authoritative resolution plus no charged send proves safe release.
      if (!neverSent) return report('dispatch-evidence-unavailable-operator-required');
      state.active = null;
      if (state.blocked === 'delivery-exhausted') state.blocked = null;
      await save(); return report('stale-never-sent-intent-released');
    }
  }
  if (neverSent && now() - a.createdAt >= LIMITS.elapsedMs) {
    // The original budget expires permanently; its tombstone cannot buy a fresh claim.
    state.active = null;
    if (state.blocked === 'delivery-exhausted') state.blocked = null;
    await save();
    return { ...report('never-sent-intent-expired'), expired: {
      runId: a.runId, attempt: a.attempt, eventId: `main-regression:${a.runId}:${a.attempt}`, tries: 0 } };
  }
  if (a.tries >= LIMITS.deliveryAttempts || now() - a.createdAt >= LIMITS.elapsedMs) {
    state.blocked = 'delivery-exhausted'; await save(); return report('delivery-exhausted-operator-required');
  }
  if (a.lastSentAt && now() - a.lastSentAt < LIMITS.deliveryBackoffMs) return report('delivery-backoff');
  if (!(verified ?? await verifyIntent(repository, a, health, api))) return report('dispatch-evidence-unavailable-operator-required');
  a.tries++; a.lastSentAt = now(); await save();
  const body = deliveryBody(repository, a);
  let response;
  try {
    response = await control(`/hooks/v1/automation-triggers/${config.triggerId}`, { method: 'POST', body,
      headers: signDelivery(body, config.triggerId, config.secret, now()) });
  } catch (e) {
    log({ event: 'main_regression_delivery', outcome: e.reason === 'control-plane-rejected' ? 'rejected' : 'offline-or-unknown', tries: a.tries });
    if (e.reason === 'control-plane-rejected') { state.blocked = 'delivery-rejected'; await save(); }
    return report(state.blocked ?? 'offline-control-plane-or-unknown-delivery');
  }
  const receipt = response?.invocation;
  if (!receipt || receipt.eventId !== JSON.parse(body).eventId || receipt.triggerId !== config.triggerId ||
      !ID.test(receipt.invocationId) || !receiptStates.has(receipt.state) ||
      (receipt.executionId !== undefined && !ID.test(receipt.executionId))) fail('invalid-trigger-receipt');
  if (a.invocationId && a.invocationId !== receipt.invocationId) fail('invocation-changed');
  a.invocationId = receipt.invocationId; a.executionId = receipt.executionId ?? null;
  if (['skipped', 'expired', 'rejected'].includes(receipt.state)) state.active = null;
  await save();
  return report(receipt.state === 'pending' ? 'runner-offline-or-pending' : `delivery-${receipt.state}`);
}

export async function main({ env = process.env, fetchImpl = fetch, log = console.log } = {}) {
  let result, exitCode = 0;
  const observationId = randomUUID();
  const entryPoint = ['workflow_run', 'schedule', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)
    ? env.GITHUB_EVENT_NAME : 'unsupported';
  const emit = value => log(JSON.stringify({ entryPoint, observationId, ...value }));
  try {
    if (!REPO.test(env.GITHUB_REPOSITORY ?? '') || env.GITHUB_REF !== 'refs/heads/main' ||
        !['workflow_run', 'schedule', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)) fail('untrusted-entry-point');
    if (env.GITHUB_EVENT_NAME === 'workflow_run') validateWake(JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')), env.GITHUB_REPOSITORY);
    if (env.MAIN_REGRESSION_AUTOMATION_ENABLED !== 'true') result = { status: 'disabled', incident: 'managed-independently-by-main-ci-health' };
    else {
      const dryRun = env.MAIN_REGRESSION_AUTOMATION_DRY_RUN !== 'false';
      const config = { origin: env.WOLLIPOG_REGRESSION_ORIGIN, token: env.WOLLIPOG_REGRESSION_TOKEN,
        secret: env.WOLLIPOG_REGRESSION_SECRET, automationId: env.WOLLIPOG_REGRESSION_AUTOMATION_ID,
        triggerId: env.WOLLIPOG_REGRESSION_TRIGGER_ID, revision: Number(env.WOLLIPOG_REGRESSION_REVISION),
        generation: Number(env.WOLLIPOG_REGRESSION_GENERATION), actionDigest: env.WOLLIPOG_REGRESSION_ACTION_DIGEST };
      if (!env.GITHUB_TOKEN) fail('missing-github-token');
      if (!dryRun && (!ID.test(config.automationId ?? '') || !ID.test(config.triggerId ?? '') || !positive(config.revision) ||
          !positive(config.generation) || !/^[a-f0-9]{64}$/.test(config.actionDigest ?? '') || !config.token ||
          !/^wollipogwhsec_[A-Za-z0-9_-]{43}$/.test(config.secret ?? ''))) fail('activation-config-incomplete');
      const started = Date.now(); let calls = 0;
      const github = githubApi(env.GITHUB_TOKEN, fetchImpl);
      const guarded = async (path, options) => {
        if (++calls > 120 || Date.now() - started > 240000) fail('adapter-budget-exhausted');
        if (dryRun && options?.method && options.method !== 'GET') fail('dry-run-mutation-refused');
        return github(path, options);
      };
      Object.defineProperties(guarded, {
        rateLimit: { get: () => github.rateLimit }, graphqlRateLimit: { get: () => github.graphqlRateLimit },
      });
      const api = budgetApi(guarded, { limit: 120, reserve: 0, requireHeaders: true });
      await api('/rate_limit');
      result = await reconcile(env.GITHUB_REPOSITORY, { api, config, dryRun,
        control: dryRun ? undefined : controlClient(config, fetchImpl), log: emit });
      result.apiCalls = calls;
    }
  } catch (e) { result = { status: 'operator-required', reason: e.reason ?? 'adapter-unavailable' }; exitCode = 1; }
  result = { entryPoint, observationId, ...result };
  emit({ event: 'main_regression_automation', ...result });
  if (env.MAIN_REGRESSION_AUTOMATION_OUTPUT) writeFileSync(env.MAIN_REGRESSION_AUTOMATION_OUTPUT, JSON.stringify(result, null, 2) + '\n');
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `Main regression automation: **${result.status}**\n\nMain CI Health owns the incident independently.\n`);
  return exitCode;
}
/** Explicit fixture route is permanently read-only and cannot construct a control-plane client. */
export async function fixtureDryRun(health) {
  if (!REPO.test(health?.repository ?? '')) fail('invalid-fixture');
  return { synthetic: true, ...await reconcile(health.repository, {
    api: async (path, options) => {
      if (options?.method && options.method !== 'GET') fail('fixture-mutation-refused');
      if (path.includes('/git/ref/')) throw Object.assign(new Error('absent-fixture-ref'), { status: 404 });
      if (path.includes('/compare/')) return { merge_base_commit: { sha: path.split('/compare/')[1].split('...')[0] } };
      fail('unexpected-fixture-api');
    }, collect: async () => health, now: () => Date.parse('2026-10-25T12:00:00Z'), dryRun: true,
  }) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === '--fixture' && process.argv.length === 4) {
    const bytes = readFileSync(process.argv[3]);
    if (bytes.length > LIMITS.evidenceBytes) fail('fixture-too-large');
    console.log(JSON.stringify(await fixtureDryRun(JSON.parse(bytes.toString('utf8')))));
  } else if (process.argv.length !== 2) fail('unsupported-arguments');
  else process.exitCode = await main();
}
