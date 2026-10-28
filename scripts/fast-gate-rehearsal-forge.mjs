import { createHash } from "node:crypto";
import { REQUIRED, WORKER } from "./main-rolling-validation.mjs";

/** Inert in-process forge for the fast-gate cutover rehearsal (#3637). It is a
 * fixture transport, never a decision maker: delivered modules read it as they
 * would read GitHub. Every endpoint is local memory on a virtual clock; state
 * refs, statuses and dispatches never leave the process and no network exists.
 */
export const REPOSITORY = "fixture/fast-gate-rehearsal";
export const START = Date.parse("2026-11-02T09:00:00.000Z");
// Matches the #3633 rehearsal's explicit per-request virtual latency.
export const CALL_MS = 100;
// Fixed inert quota header: above the 60% REST floor; no quota is consumed.
export const QUOTA = Object.freeze({ limit: 5000, remaining: 4900 });
const ROOT = `/repos/${REPOSITORY}`;
const MINUTE = 60_000;
export const sha = label => createHash("sha1").update(`fast-gate-rehearsal:${label}`).digest("hex");
const blobSha = text => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0${text}`).digest("hex");
const iso = ms => new Date(ms).toISOString();
const notFound = () => Object.assign(new Error("Inert fixture resource absent"), { status: 404 });
const WORKFLOWS = {
  "main-rolling-validation.yml": "# Inert fixture worker; not live workflow source\nrun-name: Rolling ${{ inputs.target_sha }} ${{ inputs.claim_id }}\n" +
    "uses: ./.github/workflows/ci.yml\ntarget_sha: ${{ inputs.target_sha }}\n",
  "ci.yml": "# Inert fixture full suite\nref: ${{ inputs.target_sha }}\nEXPECTED_SHA: ${{ inputs.target_sha }}\nexpected_sha: ${{ inputs.target_sha }}\n" +
    'run: test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"\n',
  "settings-rows-win32.yml": "# Inert fixture win32 suite\nref: ${{ inputs.ref }}\nEXPECTED_SHA: ${{ inputs.expected_sha }}\n" +
    'run: test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"\n',
};
const workflowText = (file, edition) => WORKFLOWS[file] + (edition && file === "ci.yml" ? `# suite edition ${edition}\n` : "");
const CORE = ["Typecheck", "Unit Tests", "Verify Node 22 Engine Boundary", "Verify Excluded Node Engine Boundary",
  "Verify Node 23 Engine Boundary", "Verify Recommended Node Engine Boundary", "Verify Delegated Linux Provider Containment",
  "Validate Web Production Build", "Validate Runner Bundle", "Validate Control-Plane Bundle"];
const STEPS = [CORE, ["Remote-Instance Browser End-to-End Tests", "Rendered Production Browser Smoke"],
  ...[2, 3, 4, 5].map(() => ["Remote-Instance Browser End-to-End Tests"]), ["WebKit Browser End-to-End Tests"],
  ["Compare the Diff Against the Settings-Rows Paths"], ["Compare Against the Committed win32 Baselines"],
  ["Require Every Job to Have Succeeded"]];

function jobs(run) {
  if (run.status === "queued") return [];
  return REQUIRED.map((name, index) => {
    const done = run.status === "completed", red = done && run.conclusion === "failure" && (index === 0 || index === REQUIRED.length - 1);
    return { id: run.id * 100 + index, name, status: done ? "completed" : "in_progress", conclusion: done ? red ? "failure" : "success" : null,
      started_at: run.run_started_at, steps: ["Verify Rolling Checkout", ...(done ? STEPS[index] : [])].map(step => ({ name: step,
        conclusion: red && (step === "Unit Tests" || step === "Require Every Job to Have Succeeded") ? "failure" : "success",
        started_at: run.run_started_at })) };
  });
}

export function inertForge({ start = START } = {}) {
  const genesis = { sha: sha("genesis"), parent: sha("pre-genesis"), tree: sha("tree:genesis"), landedAt: start - 7 * 24 * 60 * MINUTE, edition: 0, pull: null };
  // History may be seeded up to one day before the scenario epoch.
  const f = { clock: start - 24 * 60 * MINUTE, chain: [genesis], pulls: new Map(), groups: new Map(), runs: [], statuses: [], refs: new Map(),
    objects: new Map(), dispatches: [], calls: 0, graphqlQueries: 0, stateWrites: 0, outage: false, nextRun: 7001, nextStatus: 1, sequence: 0 };
  const tip = () => f.chain.at(-1);
  const position = value => f.chain.findIndex(c => c.sha === value);
  const commitOf = value => f.chain.find(c => c.sha === value);
  const snapshot = run => { const { plan: _plan, ...visible } = run; return structuredClone(visible); };
  const blob = text => ({ type: "file", sha: blobSha(text), encoding: "base64", size: Buffer.byteLength(text),
    content: Buffer.from(text).toString("base64") });
  const ancestry = (a, b) => {
    const i = position(a), j = position(b);
    if (j < 0) throw notFound();
    // Off-main commits (PR heads, queue groups) diverge from main at an older commit.
    if (i < 0) return { merge_base_commit: { sha: f.chain[0].sha }, status: "diverged", ahead_by: 0, total_commits: 0, commits: [] };
    const commits = i <= j ? f.chain.slice(i + 1, j + 1) : [];
    return { merge_base_commit: { sha: i <= j ? a : b }, status: i <= j ? "ahead" : "behind", ahead_by: commits.length,
      total_commits: commits.length, commits: commits.map(c => ({ sha: c.sha, parents: [{ sha: c.parent }],
        commit: { committer: { date: iso(c.landedAt) } } })) };
  };
  const census = () => ({ data: { repository: { defaultBranchRef: { name: "main", target: { oid: tip().sha } },
    pullRequests: { pageInfo: { hasNextPage: false }, nodes: [...f.pulls.values()].filter(p => p.state === "open").map(p => {
      const group = p.group && f.groups.get(p.group);
      return { number: p.number, isDraft: p.draft, headRefOid: p.head, baseRefOid: p.base,
        mergeQueueEntry: group ? { state: group.state, position: group.position, headCommit: { oid: group.sha },
          baseCommit: { oid: group.base } } : null };
    }) } } } });
  const read = (path, query) => {
    if (path === "/rate_limit") return {};
    if (path === ROOT) return { node_id: "inert-fixture-repository" };
    if (!path.startsWith(ROOT + "/")) throw new Error("Inert forge serves only its fixture repository");
    const rest = path.slice(ROOT.length + 1);
    let m;
    if (rest === "git/ref/heads/main") return { object: { sha: tip().sha } };
    if ((m = /^git\/ref\/heads\/(ci\/.+)$/.exec(rest))) { const ref = f.refs.get(`refs/heads/${m[1]}`); if (!ref) throw notFound(); return { object: { sha: ref } }; }
    if ((m = /^git\/commits\/([a-f0-9]{40})$/.exec(rest))) {
      const object = f.objects.get(m[1]), commit = commitOf(m[1]), group = [...f.groups.values()].find(g => g.sha === m[1]);
      if (object?.kind === "commit") return { sha: m[1], tree: { sha: object.tree }, parents: object.parents.map(p => ({ sha: p })) };
      if (commit) return { sha: commit.sha, tree: { sha: commit.tree }, parents: [{ sha: commit.parent }] };
      if (group) return { sha: group.sha, tree: { sha: group.tree }, parents: [{ sha: group.base }] };
      throw notFound();
    }
    if ((m = /^git\/trees\/([a-f0-9]{40})$/.exec(rest))) {
      const tree = f.objects.get(m[1]); if (tree?.kind !== "tree") throw notFound();
      return { sha: m[1], tree: [{ path: "state.json", type: "blob", sha: tree.blob }] };
    }
    if ((m = /^git\/blobs\/([a-f0-9]{40})$/.exec(rest))) {
      const stored = f.objects.get(m[1]); if (stored?.kind !== "blob") throw notFound();
      return { encoding: "base64", size: Buffer.byteLength(stored.content), content: Buffer.from(stored.content).toString("base64") };
    }
    if (rest === "contents/state.json") {
      const commit = f.objects.get(query.get("ref")), tree = commit && f.objects.get(commit.tree), stored = tree && f.objects.get(tree.blob);
      if (!stored) throw notFound();
      return blob(stored.content);
    }
    if ((m = /^contents\/\.github\/workflows\/([a-z0-9.-]+)$/.exec(rest)) && WORKFLOWS[m[1]] !== undefined) {
      const commit = commitOf(query.get("ref")); if (!commit) throw notFound();
      return blob(workflowText(m[1], commit.edition));
    }
    if ((m = /^compare\/([a-f0-9]{40})\.\.\.([a-f0-9]{40}|main)$/.exec(rest))) {
      const result = ancestry(m[1], m[2] === "main" ? tip().sha : m[2]);
      return Number(query.get("page") ?? 1) > 1 ? { ...result, commits: [] } : result;
    }
    if ((m = /^commits\/([a-f0-9]{40})\/pulls$/.exec(rest))) {
      const pull = [...f.pulls.values()].find(p => p.mergeCommit === m[1]);
      return pull ? [{ number: pull.number, merged_at: iso(pull.mergedAt), merge_commit_sha: pull.mergeCommit,
        base: { ref: "main", repo: { full_name: REPOSITORY } } }] : [];
    }
    if ((m = /^commits\/([a-f0-9]{40})$/.exec(rest))) {
      const commit = commitOf(m[1]); if (!commit) throw notFound();
      return { sha: commit.sha, commit: { committer: { date: iso(commit.landedAt) } }, author: null };
    }
    if ((m = /^pulls\/(\d+)$/.exec(rest))) {
      const p = f.pulls.get(Number(m[1])); if (!p) throw notFound();
      return { number: p.number, state: p.state, merged: p.state === "merged", head: { sha: p.head },
        base: { ref: "main", sha: p.base, repo: { full_name: REPOSITORY } }, merge_commit_sha: p.mergeCommit ?? null,
        merged_at: p.mergedAt ? iso(p.mergedAt) : null };
    }
    if (rest === "issues") return [];
    if (rest === "actions/workflows/main-rolling-validation.yml") return { path: WORKER, created_at: iso(start - 30 * 24 * 60 * MINUTE) };
    if ((m = /^actions\/workflows\/([a-z0-9.-]+)\/runs$/.exec(rest))) {
      if (m[1] !== "main-rolling-validation.yml") return { workflow_runs: [], total_count: 0 };
      const created = query.get("created");
      const selected = f.runs.filter(run => (!query.get("status") || run.status === query.get("status")) &&
        (!query.get("head_sha") || run.head_sha === query.get("head_sha")) &&
        (!query.get("event") || run.event === query.get("event")) && (!query.get("branch") || run.head_branch === query.get("branch")) &&
        (!created || Date.parse(run.created_at) >= Date.parse(created.slice(2)))).sort((a, b) => b.id - a.id);
      const size = Number(query.get("per_page") ?? 30), page = Number(query.get("page") ?? 1);
      return { total_count: selected.length, workflow_runs: selected.slice((page - 1) * size, page * size).map(snapshot) };
    }
    if ((m = /^actions\/runs\/(\d+)(?:\/attempts\/(\d+)(\/jobs)?)?$/.exec(rest))) {
      const run = f.runs.find(r => r.id === Number(m[1]));
      if (!run || m[2] && Number(m[2]) !== run.run_attempt) throw notFound();
      if (!m[3]) return snapshot(run);
      const listed = jobs(run);
      return { total_count: listed.length, jobs: listed };
    }
    throw new Error("Inert forge has no such endpoint");
  };
  const write = (path, body) => {
    if (path === "/graphql") {
      if (body.query.includes("AdmissionWorkflowEvidence")) {
        f.graphqlQueries++;
        const commit = commitOf(body.variables.revision);
        if (!commit) return { data: { repository: { nameWithOwner: REPOSITORY, revision: null } } };
        const files = Object.fromEntries(Object.keys(WORKFLOWS).map((file, i) => {
          const text = workflowText(file, commit.edition);
          return [`file${i}`, { __typename: "Blob", oid: blobSha(text), text, isBinary: false, byteSize: Buffer.byteLength(text) }];
        }));
        return { data: { repository: { nameWithOwner: REPOSITORY, revision: { __typename: "Commit", oid: commit.sha }, ...files } } };
      }
      if (body.query.includes("pullRequests(")) { f.graphqlQueries++; return census(); }
      if (body.query.includes("updateRefs")) {
        const update = body.variables.input.refUpdates[0];
        if ((f.refs.get(update.name) ?? "0".repeat(40)) !== update.beforeOid) return { errors: [{ message: "inert ref changed" }] };
        f.refs.set(update.name, update.afterOid); f.stateWrites++;
        return { data: { updateRefs: { clientMutationId: null } } };
      }
      throw new Error("Inert forge has no such query");
    }
    if (path === `${ROOT}/git/trees`) {
      const content = body.tree[0].content, blobOid = blobSha(content), tree = sha(`tree:${blobOid}`);
      f.objects.set(blobOid, { kind: "blob", content }); f.objects.set(tree, { kind: "tree", blob: blobOid });
      return { sha: tree };
    }
    if (path === `${ROOT}/git/commits`) {
      const oid = sha(`state-commit:${++f.sequence}:${body.tree}`);
      f.objects.set(oid, { kind: "commit", tree: body.tree, parents: body.parents });
      return { sha: oid };
    }
    if (path === `${ROOT}/actions/workflows/main-rolling-validation.yml/dispatches`) {
      // Records a virtual dispatch only; scenarios start and finish it explicitly.
      f.dispatches.push({ at: iso(f.clock), targetSha: body.inputs.target_sha });
      createRun(body.inputs.target_sha, body.inputs.claim_id, f.clock);
      return null;
    }
    const status = /^\/repos\/[^/]+\/[^/]+\/statuses\/([a-f0-9]{40})$/.exec(path);
    if (status) {
      const record = { id: f.nextStatus++, targetSha: status[1], state: body.state, context: body.context, at: iso(f.clock) };
      f.statuses.push(record);
      return { id: record.id, state: record.state, context: record.context };
    }
    throw new Error("Inert forge refuses this mutation");
  };
  const api = async (path, { method = "GET", body } = {}) => {
    f.clock += CALL_MS; f.calls++;
    api.rateLimit = { ...QUOTA };
    if (f.outage) throw Object.assign(new Error("Inert forge outage"), { status: 503 });
    const url = new URL("https://inert.invalid" + path);
    return method === "GET" ? structuredClone(read(url.pathname, url.searchParams)) : write(url.pathname, body);
  };
  function createRun(targetSha, claimId, at, dispatcher = tip().sha) {
    const run = { id: f.nextRun++, run_number: f.runs.length + 1, run_attempt: 1, display_title: `Rolling ${targetSha} ${claimId}`,
      path: WORKER, head_sha: dispatcher, head_branch: "main", event: "workflow_dispatch", status: "queued", conclusion: null,
      created_at: iso(at), run_started_at: iso(at), updated_at: iso(at), html_url: `https://inert.invalid/runs/${f.nextRun}`,
      repository: { full_name: REPOSITORY }, head_repository: { full_name: REPOSITORY } };
    f.runs.push(run);
    return run;
  }
  return {
    api, state: f,
    get now() { return f.clock; }, tip: () => tip().sha,
    /** Scenario time only moves forward; API calls add CALL_MS each. */
    at(ms) { if (ms < f.clock) throw new Error("Virtual clock cannot move backwards"); f.clock = ms; return iso(ms); },
    iso: () => iso(f.clock),
    land(label, { pull, edition, tree } = {}) {
      const parent = tip(), commit = { sha: sha(`commit:${label}`), parent: parent.sha, tree: tree ?? sha(`tree:${label}`),
        landedAt: f.clock, edition: edition ?? parent.edition, pull: pull ?? null };
      f.chain.push(commit);
      if (pull !== undefined) {
        const p = f.pulls.get(pull) ?? this.open(pull, { head: sha(`head:${label}`) });
        Object.assign(p, { state: "merged", mergeCommit: commit.sha, mergedAt: f.clock, group: null });
      }
      return commit.sha;
    },
    open(number, { head = sha(`head:${number}`), base = tip().sha, draft = false } = {}) {
      const p = { number, head, base, draft, state: "open", group: null, mergeCommit: null, mergedAt: null };
      f.pulls.set(number, p);
      return p;
    },
    /** A queue group SHA is not on main; its tree is the would-be squash result. */
    enqueue(label, members, { base = tip().sha, tree = sha(`tree:${label}`), state = "AWAITING_CHECKS", position = 1 } = {}) {
      const group = { sha: sha(`group:${label}`), base, tree, state, position, members };
      f.groups.set(label, group);
      for (const number of members) f.pulls.get(number).group = label;
      return group;
    },
    rebase(number, base = tip().sha) { f.pulls.get(number).base = base; },
    seedRun(targetSha, { createdAt, startedAt, finishedAt, conclusion, claim = "00000000-0000-4000-8000-000000000000" }) {
      const run = createRun(targetSha, claim, createdAt);
      this.startRun(run, startedAt);
      if (finishedAt !== undefined) this.finishRun(run, conclusion, finishedAt);
      return run;
    },
    startRun(run, at) { Object.assign(run, { status: "in_progress", run_started_at: iso(at), updated_at: iso(at) }); },
    finishRun(run, conclusion, at) { Object.assign(run, { status: "completed", conclusion, updated_at: iso(at) }); },
    latestRun: () => f.runs.at(-1),
    latestStatus: target => f.statuses.filter(s => s.targetSha === target).at(-1) ?? null,
  };
}
