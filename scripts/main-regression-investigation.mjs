import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { LIMITS } from './main-regression-policy.mjs';

const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const outcomes = new Set(['pass', 'product-failure', 'infrastructure', 'inconclusive']);
const fail = reason => { throw new Error(reason); };

/** This is an evidence protocol, not a certificate. The investigator must authenticate its inputs. */
export function classify(evidence) {
  if (!evidence || !SHA.test(evidence.testedSha) || !Array.isArray(evidence.failing) ||
      !Array.isArray(evidence.comparison) || evidence.failing.length > LIMITS.reproductionAttempts ||
      evidence.comparison.length > LIMITS.comparisonAttempts) fail('invalid-investigation-evidence');
  const valid = r => r && SHA.test(r.sha) && outcomes.has(r.outcome) &&
    (r.outcome !== 'product-failure' || HASH.test(r.signature));
  if (![...evidence.failing, ...evidence.comparison].every(valid) ||
      evidence.failing.some(r => r.sha !== evidence.testedSha) ||
      evidence.comparison.some(r => r.sha !== evidence.passingSha)) fail('crossed-investigation-evidence');
  const repeatedFailure = evidence.failing.length === 2 && evidence.failing.every(r => r.outcome === 'product-failure') &&
    evidence.failing[0].signature === evidence.failing[1].signature;
  const comparisonPassed = SHA.test(evidence.passingSha ?? '') && evidence.passingSha !== evidence.testedSha &&
    evidence.comparison.length === 2 && evidence.comparison.every(r => r.outcome === 'pass') &&
    evidence.comparisonAncestryVerified === true && evidence.compatibleSuite === true;
  const uncertain = evidence.interactions === true || evidence.nonmonotonic === true;
  const classification = uncertain ? 'inconclusive'
    : repeatedFailure && comparisonPassed ? 'reproducible-product-failure'
      : evidence.failing.length && evidence.failing.every(r => r.outcome === 'infrastructure') ? 'infrastructure-problem'
        : evidence.failing.some(r => r.outcome === 'pass') ? 'retry-only' : 'inconclusive';
  return { classification, bisectAllowed: classification === 'reproducible-product-failure',
    incidentResolved: false, attribution: 'unverified', reason: uncertain ? 'interaction-or-nonmonotonic-evidence' :
      classification === 'retry-only' ? 'passing-retry-does-not-exonerate-failure' : 'bounded-evidence-only' };
}

/** Four counterfactual checks, against BOTH boundary snapshots, are needed beyond bisection. */
export function verifyCulprit(evidence, proof) {
  const result = classify(evidence);
  if (!result.bisectAllowed || !SHA.test(proof?.culpritSha ?? '') || proof.securityReviewRequired === true ||
      proof.suspectedInteractions !== false || proof.nonmonotonic !== false || proof.patchIdentityVerified !== true ||
      !Array.isArray(proof.checks) || proof.checks.length !== 4)
    return { verified: false, reason: 'attribution-stopped' };
  const signature = evidence.failing[0].signature;
  const expected = [
    [evidence.testedSha, 'with-change', 'product-failure'],
    [evidence.testedSha, 'without-change', 'pass'],
    [evidence.passingSha, 'with-change', 'product-failure'],
    [evidence.passingSha, 'without-change', 'pass'],
  ];
  const verified = expected.every(([sha, change, outcome]) => {
    const matches = proof.checks.filter(c => c.sha === sha && c.change === change);
    return matches.length === 1 && matches[0].outcome === outcome &&
      (outcome !== 'product-failure' || matches[0].signature === signature);
  });
  return { verified, reason: verified ? 'both-snapshots-counterfactually-verified' : 'counterfactuals-incomplete' };
}

/** Charge BEFORE work, never refund failed attempts; the host's cost/tool limits remain required. */
export class InvestigationBudget {
  constructor({ clock = () => performance.now(), startedAt } = {}) {
    this.clock = clock; this.startedAt = startedAt ?? clock();
    this.counts = { reproduction: 0, comparison: 0, bisection: 0, counterfactual: 0, ciDispatch: 0 };
  }
  charge(kind, { bisectAllowed = false } = {}) {
    const maximum = { reproduction: 2, comparison: 2, bisection: 6, counterfactual: 4, ciDispatch: 0 }[kind];
    const remainingMs = LIMITS.elapsedMs - (this.clock() - this.startedAt);
    if (!Number.isFinite(remainingMs) || remainingMs <= 0 || remainingMs > LIMITS.elapsedMs) fail('elapsed-budget-exhausted');
    if (maximum === undefined || this.counts[kind] >= maximum) fail('attempt-budget-exhausted');
    if ((kind === 'bisection' || kind === 'counterfactual') && !bisectAllowed) fail('reproduction-required');
    this.counts[kind]++;
    return { remainingMs, counts: { ...this.counts }, maxOutputBytes: LIMITS.evidenceBytes };
  }
}

/** Retain a content-free receipt, never interpolate diagnostics into task text or GitHub comments. */
export function diagnosticReceipt(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > LIMITS.evidenceBytes) fail('diagnostic-budget-exhausted');
  return { sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), trusted: false };
}

// Fixture mode never executes a command or contacts a service. It proves policy, not reproduction.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] !== '--fixture' || process.argv.length !== 4) fail('usage: --fixture <bounded-synthetic-json>');
  const bytes = readFileSync(process.argv[3]);
  diagnosticReceipt(bytes);
  const evidence = JSON.parse(bytes.toString('utf8'));
  console.log(JSON.stringify({ synthetic: true, ...classify(evidence),
    ...(evidence.proof ? { culprit: verifyCulprit(evidence, evidence.proof) } : {}) }));
}
