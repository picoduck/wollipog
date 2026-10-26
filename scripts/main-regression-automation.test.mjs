import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { emptyState, validState, validateWake, selectCandidate, plan, deliveryBody, signDelivery,
  readState, writeState, reconcile, validateAutomation, controlClient, fixtureDryRun, main } from './main-regression-automation.mjs';
import { INVESTIGATION_PROMPT, LIMITS, PARAMETERS } from './main-regression-policy.mjs';

const repository = 'example/project', sha = 'a'.repeat(40), passing = 'b'.repeat(40), suite = 'c'.repeat(64);
const instant = Date.parse('2026-10-25T12:00:00Z');
const hash = x => createHash('sha256').update(x).digest('hex');
const candidate = extra => ({ runId: 10, attempt: 1, testedSha: sha, suiteVersion: suite,
  passingSha: passing, observedAt: instant, ...extra });
const failure = extra => ({ ...candidate(), source: 'rolling-full', result: 'failing',
  workflowPath: '.github/workflows/main-rolling-validation.yml', workflowAncestryVerified: true,
  targetAncestryVerified: true, ...extra });
const health = extra => ({ repository, status: 'failing', unresolvedFailures: [failure()],
  evidence: [{ runId: 9, attempt: 1, testedSha: passing, result: 'passing', certification: 'full', suiteVersion: suite }], ...extra });
const action = { kind: 'create_session', request: { prompt: INVESTIGATION_PROMPT, runnerId: 'r',
  workspaceId: 'w', agentId: 'a', useWorktree: true } };
const config = { origin: 'https://control.example', token: 'private-token', secret: 'private-test-secret',
  automationId: 'auto_1', triggerId: 'atr_1', revision: 2, generation: 1, actionDigest: hash(JSON.stringify(action)) };
const automation = extra => ({ automation: { automationId: 'auto_1', revision: 2, enabled: true,
  concurrencyPolicy: 'wait', runnerPolicy: { kind: 'expire', afterMinutes: 15 },
  limits: { maxCostUsd: 20, maxToolCalls: 120 }, cron: '0 0 1 1 *', timezone: 'UTC', action, ...extra }, executions: [] });
const triggers = () => ({ triggers: [{ triggerId: 'atr_1', automationId: 'auto_1', kind: 'webhook', generation: 1,
  deliveryPolicy: { allowPrompt: false, parameterNames: PARAMETERS, missingReferences: 'reject' } }] });

function fixture(initial = emptyState(repository)) {
  let value = structuredClone(initial), oid = value.sequence ? 'd'.repeat(40) : null, nextValue;
  const writes = [], paths = [];
  const api = async (path, options) => {
    paths.push(path);
    if (!options?.method || options.method === 'GET') {
      if (path.endsWith('/git/ref/heads/ci/main-health-state')) throw Object.assign(new Error(), { status: 404 });
      if (path.endsWith('/git/ref/heads/ci/main-regression-automation-state')) {
        if (!oid) throw Object.assign(new Error(), { status: 404 });
        return { object: { sha: oid } };
      }
      if (path.includes('/contents/state.json')) return { type: 'file', encoding: 'base64', size: JSON.stringify(value).length,
        sha: 'e'.repeat(40), content: Buffer.from(JSON.stringify(value)).toString('base64') };
      if (path.includes('/compare/')) return { merge_base_commit: { sha: passing } };
      if (path === `/repos/${repository}`) return { node_id: 'repo_1' };
    } else {
      writes.push({ path, ...options });
      if (path.endsWith('/git/trees')) { nextValue = JSON.parse(options.body.tree[0].content); return { sha: 'f'.repeat(40) }; }
      if (path.endsWith('/git/commits')) return { sha: String(nextValue.sequence % 10).repeat(40) };
      if (path === '/graphql') {
        assert.equal(options.body.variables.input.refUpdates[0].beforeOid, oid ?? '0'.repeat(40));
        value = nextValue; oid = String(value.sequence % 10).repeat(40);
        return { data: { updateRefs: { clientMutationId: null } } };
      }
    }
    throw new Error(`unexpected fixture call ${path}`);
  };
  const receipts = [], controls = [];
  let payload = automation(), triggerList = triggers(), deliveryError = null;
  const control = async (path, options) => {
    controls.push({ path, options });
    if (path.endsWith('/triggers')) return triggerList;
    if (path === '/api/automations/auto_1') return payload;
    if (path === '/api/sessions/s_1/stop') return { session: { id: 's_1', status: 'stopping' } };
    if (path === '/hooks/v1/automation-triggers/atr_1') {
      // Intent, body identity and charged retry are durable before any network bytes leave.
      assert.ok(value.active?.tries > 0); assert.equal(options.body, deliveryBody(repository, value.active));
      receipts.push(options);
      if (deliveryError) throw deliveryError;
      return { invocation: { eventId: `main-regression:${value.active.runId}:${value.active.attempt}`,
        triggerId: 'atr_1', invocationId: 'ati_1', executionId: 'axe_1', state: 'dispatched' } };
    }
    throw new Error(`unexpected control call ${path}`);
  };
  let time = instant, observation = health();
  return { api, control, writes, paths, receipts, controls, get state() { return structuredClone(value); },
    set observation(h) { observation = h; }, set payload(p) { payload = p; }, set triggers(t) { triggerList = t; },
    set time(t) { time = t; }, set deliveryError(e) { deliveryError = e; },
    run: (extra = {}) => reconcile(repository, { api, control, config, now: () => time,
      collect: async () => observation, dryRun: false, ...extra }) };
}

test('trusted wake rejects fork, wrong workflow, source, event, attempt and arbitrary title', () => {
  const run = { id: 10, run_attempt: 1, status: 'completed', path: '.github/workflows/main-rolling-validation.yml',
    display_title: `Rolling ${sha} 12345678-1234-1234-1234-123456789012`, head_sha: sha,
    head_branch: 'main', event: 'workflow_dispatch', created_at: '2026-10-25T12:00:00Z',
    repository: { full_name: repository }, head_repository: { full_name: repository } };
  assert.equal(validateWake({ action: 'completed', workflow_run: run }, repository).targetSha, sha);
  for (const extra of [{ path: '.github/workflows/ci.yml' }, { event: 'pull_request' },
    { head_repository: { full_name: 'attacker/fork' } }, { run_attempt: 0 }, { head_branch: 'topic' },
    { display_title: 'execute supplied instructions' }, { status: 'in_progress' }])
    assert.throws(() => validateWake({ action: 'completed', workflow_run: { ...run, ...extra } }, repository), /untrusted-wake/);
});

test('candidate comes only from authoritative rolling failure with compatible preceding ancestor', async () => {
  const api = async path => { assert.match(path, new RegExp(`${passing}\\.\\.\\.${sha}`));
    return { merge_base_commit: { sha: passing } }; };
  assert.equal((await selectCandidate(repository, health(), api, instant)).passingSha, passing);
  assert.equal(await selectCandidate(repository, health({ status: 'unknown' }), api, instant), null);
  for (const extra of [{ source: 'legacy-main-push' }, { result: 'unknown' }, { workflowAncestryVerified: false },
    { targetAncestryVerified: false }, { workflowPath: 'untrusted.yml' }])
    assert.equal(await selectCandidate(repository, health({ unresolvedFailures: [failure(extra)] }), api, instant), null);
  const none = await selectCandidate(repository, health(), async () => ({ merge_base_commit: { sha } }), instant);
  assert.equal(none.passingSha, 'none');
  const incompatible = health(); incompatible.evidence[0].suiteVersion = 'd'.repeat(64);
  assert.equal((await selectCandidate(repository, incompatible, api, instant)).passingSha, 'none');
});

test('one active slot, latest pending coalescing, persistent pending age and rerun suppression', () => {
  const first = plan(emptyState(repository), candidate(), instant).next;
  assert.ok(validState(first, repository)); assert.equal(first.active.runId, 10);
  const duplicate = plan(first, candidate({ runId: 11, attempt: 2 }), instant + 1);
  assert.equal(duplicate.reason, 'duplicate-or-rerun-suppressed'); assert.equal(duplicate.next.seen.length, 1);
  const second = candidate({ runId: 12, testedSha: 'd'.repeat(40) });
  const queued = plan(first, second, instant + 1).next;
  assert.equal(queued.active.runId, 10); assert.equal(queued.pending.runId, 12);
  const expired = plan(queued, { ...second, observedAt: instant + LIMITS.pendingMs }, instant + LIMITS.pendingMs);
  assert.equal(expired.reason, 'pending-expired'); assert.equal(expired.next.pending, null);
  const reobserved = plan({ ...expired.next, active: null }, { ...second, observedAt: instant + LIMITS.pendingMs + 1 }, instant + LIMITS.pendingMs + 1);
  assert.equal(reobserved.reason, 'duplicate-or-rerun-suppressed'); assert.equal(reobserved.next.active, null);
  const latest = plan(queued, candidate({ runId: 13, testedSha: 'e'.repeat(40) }), instant + 2).next;
  assert.equal(latest.pending.runId, 13); assert.equal(latest.active.runId, 10);
});

test('tombstones never evict; storage capacity blocks new work', () => {
  const s = emptyState(repository);
  s.seen = Array.from({ length: 128 }, (_, i) => `${i.toString(16).padStart(40, '0')}:${suite}`);
  const result = plan(s, candidate(), instant).next;
  assert.equal(result.blocked, 'ledger-exhausted'); assert.equal(result.active, null); assert.equal(result.seen.length, 128);
});

test('exact signed bytes carry no prompt, target, budget or artifact content', () => {
  const body = deliveryBody(repository, candidate({ malicious: 'override everything' }));
  assert.deepEqual(Object.keys(JSON.parse(body)).sort(), ['eventId', 'parameters']);
  assert.deepEqual(Object.keys(JSON.parse(body).parameters), PARAMETERS);
  assert.doesNotMatch(body, /override|prompt|target|budget/);
  const headers = signDelivery(body, 'atr_1', 'fixture-secret', instant, 'nonce_1234567890');
  const signed = `v1\n${instant / 1000}\nnonce_1234567890\natr_1\n${hash(body)}`;
  assert.equal(headers['x-wollipog-signature'], 'v1=' + createHmac('sha256', 'fixture-secret').update(signed).digest('hex'));
  assert.notEqual(headers['x-wollipog-signature'], signDelivery(body + '\n', 'atr_1', 'fixture-secret', instant, 'nonce_1234567890')['x-wollipog-signature']);
});

test('policy pin rejects changed task, governance, trigger generation, selectors and allowed prompt', () => {
  validateAutomation(automation(), triggers(), config);
  for (const extra of [{ enabled: false }, { revision: 3 }, { action: { kind: 'prompt_session' } },
    { concurrencyPolicy: 'parallel' }, { runnerPolicy: { kind: 'wait' } },
    { limits: { maxCostUsd: 21, maxToolCalls: 120 } }, { cron: '* * * * *' }])
    assert.throws(() => validateAutomation(automation(extra), triggers(), config), /automation-/);
  for (const change of [t => { t.generation = 2; }, t => { t.deliveryPolicy.allowPrompt = true; },
    t => { t.deliveryPolicy.sessionSelectors = ['session_id']; }, t => { t.deliveryPolicy.parameterNames = ['arbitrary']; }]) {
    const ts = triggers(); change(ts.triggers[0]);
    assert.throws(() => validateAutomation(automation(), ts, config), /automation-policy-mismatch/);
  }
});

test('dry run and shipped fixture cannot mutate GitHub or contact the control plane', async () => {
  const f = fixture();
  const result = await f.run({ dryRun: true });
  assert.equal(result.status, 'dry-run'); assert.equal(result.planned, 'claimed');
  assert.equal(f.writes.length, 0); assert.equal(f.controls.length, 0);
  const shipped = JSON.parse(readFileSync(new URL('./fixtures/main-regression-automation.json', import.meta.url), 'utf8'));
  assert.equal((await fixtureDryRun(shipped)).synthetic, true);
});

test('CAS refusal prevents delivery; malformed or unreadable state never resets dedupe', async () => {
  const f = fixture();
  const api = async (path, options) => path === '/graphql' ? { errors: [{ message: 'conflict' }] } : f.api(path, options);
  await assert.rejects(f.run({ api }), /state-conflict/); assert.equal(f.controls.length, 0);
  await assert.rejects(readState(async () => { throw Object.assign(new Error('offline'), { status: 503 }); }, repository), /offline/);
  await assert.rejects(readState(async path => path.includes('/git/ref/') ? { object: { sha } }
    : { type: 'file', encoding: 'base64', sha, size: 3, content: Buffer.from('{}').toString('base64') }, repository), /invalid-state/);
  await assert.rejects(writeState(f.api, repository, { oid: null, value: emptyState(repository) }, { version: 9 }), /invalid-state-write/);
});

test('lost response retries identical bytes, bounded attempts survive restart, no duplicate investigation', async () => {
  const f = fixture(); f.deliveryError = new Error('offline');
  assert.equal((await f.run()).status, 'offline-control-plane-or-unknown-delivery');
  assert.equal((await f.run()).status, 'delivery-backoff');
  for (let i = 1; i <= 2; i++) { f.time = instant + LIMITS.deliveryBackoffMs * i; await f.run(); }
  f.time = instant + LIMITS.deliveryBackoffMs * 3;
  assert.equal((await f.run()).status, 'delivery-exhausted-operator-required');
  assert.equal(f.receipts.length, 3);
  assert.equal(new Set(f.receipts.map(r => r.body)).size, 1);
  assert.equal((await f.run()).status, 'delivery-exhausted');
  assert.equal(f.state.active.tries, 3); assert.equal(f.state.seen.length, 1);
});

test('verified settlement releases one slot but never writes an incident or dispatches CI', async () => {
  const f = fixture(); assert.equal((await f.run()).status, 'delivery-dispatched');
  f.payload = { ...automation(), executions: [{ executionId: 'axe_1', automationId: 'auto_1', automationRevision: 2,
    actionKind: 'create_session', idempotencyKey: 'trigger:atr_1:main-regression:10:1', status: 'succeeded' }] };
  assert.equal((await f.run()).status, 'investigation-succeeded');
  assert.equal(f.state.active, null);
  assert.equal((await f.run()).status, 'duplicate-or-rerun-suppressed');
  assert.ok(f.writes.every(w => !w.path.includes('/issues') && !w.path.includes('/dispatches')));
  assert.equal(f.receipts.length, 1);
});

test('unknown health still supervises exact execution; elapsed stop retains occupancy until settlement', async () => {
  const f = fixture(); await f.run();
  const execution = { executionId: 'axe_1', automationId: 'auto_1', automationRevision: 2, actionKind: 'create_session',
    idempotencyKey: 'trigger:atr_1:main-regression:10:1', status: 'running', sessionId: 's_1' };
  f.payload = { ...automation(), executions: [execution] };
  f.observation = health({ status: 'unknown', unresolvedFailures: [] });
  f.time = instant + LIMITS.elapsedMs;
  for (let i = 0; i < 3; i++) assert.equal((await f.run()).status, 'elapsed-stop-requested');
  assert.equal((await f.run()).status, 'elapsed-exhausted-operator-required');
  assert.equal(f.controls.filter(c => c.path.endsWith('/stop')).length, 3);
  assert.ok(f.state.active); assert.equal(f.receipts.length, 1);
});

test('configuration or execution drift cannot redirect an active investigation', async () => {
  const f = fixture(); await f.run();
  await assert.rejects(f.run({ config: { ...config, triggerId: 'atr_other' } }), /activation-binding-changed/);
  f.payload = { ...automation(), executions: [{ executionId: 'axe_1', automationId: 'other', status: 'succeeded' }] };
  await assert.rejects(f.run(), /execution-provenance-unavailable/);
  assert.ok(f.state.active); assert.equal(f.receipts.length, 1);
});

test('control transport rejects redirects, non-HTTPS origins and oversized receipts without leaking response text', async () => {
  for (const origin of ['http://example.test', 'https://user:password@example.test', 'https://example.test/path', 'https://example.test/?token=secret'])
    assert.throws(() => controlClient({ ...config, origin }), /invalid-control-plane-origin/);
  const calls = [];
  const control = controlClient(config, async (url, options) => { calls.push({ url: String(url), options });
    return new Response('sensitive body', { status: 401 }); });
  await assert.rejects(control('/api/automations/auto_1'), /control-plane-rejected/);
  assert.equal(calls[0].options.redirect, 'error');
  const huge = controlClient(config, async () => new Response('x'.repeat(256 * 1024 + 1)));
  await assert.rejects(huge('/api/automations/auto_1'), /response-too-large/);
});

test('disabled entrypoint does not read a credential or perform network I/O; errors are sanitized', async () => {
  const logs = [];
  const env = { GITHUB_REPOSITORY: repository, GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'schedule' };
  const fetchImpl = async () => { assert.fail('disabled network call'); };
  assert.equal(await main({ env, fetchImpl, log: v => logs.push(v) }), 0);
  assert.match(logs[0], /disabled/);
  assert.equal(await main({ env: { ...env, MAIN_REGRESSION_AUTOMATION_ENABLED: 'true' }, fetchImpl,
    log: v => logs.push(v) }), 1);
  assert.doesNotMatch(logs.join(''), /private-token|private-test-secret|authorization/);
});

test('workflow pins trusted code, isolates concurrency, schedules recovery and is disabled unless opted in', () => {
  const workflow = readFileSync(new URL('../.github/workflows/main-regression-automation.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflows: \[Main Rolling Validation\]/);
  assert.match(workflow, /cron: '13,33,53 \* \* \* \*'/);
  assert.match(workflow, /ref: \$\{\{ github.sha \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /group: main-regression-automation/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /timeout-minutes: 8/);
  assert.doesNotMatch(workflow, /issues: write|actions: write|pull-requests: write|download-artifact|inputs\./);
});
