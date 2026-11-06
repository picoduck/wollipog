# Decision Model

The Decision Model answers bounded, typed questions for the control plane (#4101), such as whether
an owner's first message asks for an issue or only cites it. It replaces text classifiers as the
primary mechanism; deterministic checks stay as floors that run first. The Full Control callers are
#4102 (scope grant), #4103 (scope review) and #4104 (first-message intent, the question and
credential screen, follow-up relatedness and closure-reason choice).

## Setting

`/api/decision-model` holds one organization-level target, modelled on the session-naming harness
target: Machine, Agent Harness, Model and Effort. Every organization member can read it. Only owners
and administrators can change it (`PUT`), return it to Automatic (`DELETE`) or run **Test Decision
Model** (`POST /api/decision-model/test`).

- **Automatic** (the default, no stored row) uses the campaign runner's own harness, with the first
  model it advertises from the fixed family list `DECISION_MODEL_AUTOMATIC_PREFERENCE` and the first
  effort from `DECISION_MODEL_AUTOMATIC_EFFORTS`. It never substitutes another harness. Without a
  campaign (the Test), it uses the first capable harness that has an Automatic model.
- **An explicit target** always wins. When it becomes unavailable (offline, outdated runner, model
  withdrawn, billing source changed), calls fail non-transiently; it is never silently replaced.

A harness qualifies when its runner speaks protocol v285 and discovery advertises `decisionCalls`:
Claude Code with the session-naming lockdown flags plus `--json-schema`, or Codex App Server at the
session-naming floor.

## Calls

A call runs on the runner, with credentials that stay on the runner, through `run_decision`. The
runner runs the harness in a neutral directory with no tools, no MCP servers, no settings, no file
access and no persistence, and returns only the structured output and usage. Claude Code's
`structured_output` and Codex's schema-constrained final message are the only answers; free text is
never parsed.

Each kind lives in `apps/control-plane/src/decision-kinds.ts`: a fixed `promptVersion`, fixed
instructions, its verdicts (always including `uncertain`) and any extra fields. Untrusted inputs
(issue titles, bodies and labels, Orchestrator rationale, child questions) are passed as JSON-quoted
strings inside `<untrusted_data>` elements with markup escaped, so no content can close its element.
Only the owner's own message appears as `<owner_message>`. The server validates the output strictly
against the kind's schema; properties outside it are ignored and never stored.

## Runtime

`DecisionRuntime.decide()` in `apps/control-plane/src/decision-runtime.ts` is the only entry point.

```ts
// A kind with untrusted data, such as #4103's scope review, passes it as quoted `data` fields.
const outcome = await decisionRuntime.decide({
  organizationId,
  kind: "scope_review",
  campaignSessionId: rootId,
  occurrenceKey: `scope_review:${rootId}:${proposalId}`,
  automaticHarness: { runnerId, agentId, driver },
  inputs: { ownerMessage, data: { candidates: JSON.stringify(facts) } },
  routeToHuman: (occurrence) => createTypedRequest(occurrence.occurrenceId),
});
```

### Scope Grant

Since #4282 a Full Control first message gets no call of this kind: the Orchestrator reads the
owner's first message and proposes the scope, and the server's deterministic floors bind that
proposal to the message (`docs/full-control-launch-preparation.md`). Full Control grants stored
before then still read as below. Since #4282's third slice a Custom campaign's epic seed gets no call
of this kind either: it is the constraint check of the Custom Orchestrator's first-message proposal
(see [Custom Epic Seed](#custom-epic-seed-issue_scope_seed-4104)). Seed readings recorded before then
still show in Campaign Status.

`scope_grant` (#4102) reads a Full Control owner's exact first message and nothing else: no data
fields, no tools, no repository or issue content. Its fields are `explicit`, `ranges` and `context`
(each repository-qualified, with an empty repository meaning the campaign's own), the selection
(`selectionRequested`, `selectionRepository`, `selectionCount` with 0 for none stated,
`selectionCriteria`, `selectionConstraints`) and `narrowsOperations` with `operations`. Array items
may be objects of scalars; every property is required and nothing outside the schema is kept.

`apps/control-plane/src/scope-grant.ts` holds the floors that run on the verdict, and
`docs/full-control-launch-preparation.md` describes how the grant establishes the boundary. Its
routing creates no request at the time of the call: the one typed request is the owner's approval
of the Orchestrator's first scope proposal, which `linkDecisionHumanRequest` then records on the
occurrence.

- The occurrence is created before the first attempt. An `occurrenceKey` makes the call idempotent:
  a repeated or concurrent call joins the same occurrence.
- At most `DECISION_MAX_ATTEMPTS` (3) attempts inside `DECISION_TOTAL_BOUND_MS` (90 s), transport
  margins included. An answer that arrives after the bound is discarded as `timed_out`. Transient
  classes (`DECISION_TRANSIENT_ERROR_CLASSES`: timeout, transport, rate limit, overload, invalid
  output and unclassified provider failure) are retried with exponential backoff and equal jitter. A
  provider `Retry-After` replaces a shorter backoff, and retries stop when it would leave no room for
  another attempt.
- Authentication, configuration, missing model, harness or runner capability, and refusal are not
  retried.
- The occurrence accepts one outcome by compare-and-set. A late or duplicate answer is discarded.
- `uncertain` is an answer, not a failure: it is never retried.

### The Failure Rule

An `uncertain` or failed occurrence calls `routeToHuman` exactly once, guarded by a compare-and-set
claim. The caller creates its one typed, person-owned request there. For scope, that is approval of
the Orchestrator's proposal. If the callback throws, the claim is released so a later call can
create the request. A claim that a restart interrupted before routing finished is routed again, so
the callback must be idempotent per occurrence ID: return the request it already created instead of
creating a second one. Nothing ever falls back to text parsing.

Only `outcome: "verdict"` may be acted on, and only to narrow or confirm. No verdict can raise a
ceiling, change a repository or grant an operation; callers enforce that before acting, for example
with `narrowToProposal`. Write a repository floor as "a repository in the campaign's boundary" so it
holds for single- and multi-repository boundaries.

## Typed Questions (#4283)

A kind may set `typed` instead of returning a verdict. It then lists fixed questions
(`apps/control-plane/src/decision-questions.ts`), each with:

- a stable `questionId`, a short Title Case `label` and fixed text, which never contains caller data;
- an answer type: `boolean`, `choice` with allowed values, or an integer `score` with a range;
- a rule saying which values satisfy the question, which violate it, and which (such as
  `cannot_tell`) settle nothing;
- optionally a per-item `subject` ("for each proposed issue") and `parameterized`, which asks the
  question once per caller parameter (such as each constraint the owner stated, quoted as data).

The caller passes `inputs.questions`: each subject's items (a schema-safe `id` and a display `label`)
and each parameterized question's parameters. Malformed, missing, unused or oversized question inputs
throw `DecisionInputError`; a typed decision never asks a partial set. Zero parameters simply ask
nothing for that question, so a caller with nothing checkable should not call at all.

All of a decision's questions go in one call with one output schema (`typedOutputSchema`): exactly
one property per question, each answer exactly `value`, `confidence` (0 to 1) and `evidence` (at
most 160 characters), and a per-item question exactly one entry per listed item. There is no verdict
property. The same schema goes to Claude Code's `--json-schema` and Codex's `outputSchema`. Output
with an added or missing question, an extra field, a verdict, a value outside the allowed answers,
or a missing or repeated item is `invalid_output`, retried like any other, and never read leniently.

The server derives the verdict (`deriveTypedVerdict`) with the kind's fixed `confidenceThreshold`:

- **refuse** when any answer is a violation at or above the threshold, naming the first such
  question and item, for example "Issue 4120 violates 'Skip Security'.";
- **admit** when every answer is satisfied at or above the threshold;
- otherwise **uncertain**, naming the first answer that could not admit, which takes the failure
  rule's one person-owned request.

The reason is the server's sentence, never the model's prose. The occurrence's `typed_answers`
column records the threshold, each question as asked (with its items, and a parameterized question's
complete parameter, since its display label may be shortened), each answer with its
confidence, evidence and assessment, and the deciding answer; `DecisionOccurrenceView.typedAnswers`
projects it, and Campaign Status shows it as a checklist. Records from before typed questions keep
their single-verdict form. Item labels and parameters are stored there for display, like
`campaign_selection_proposals`; the other inputs are still kept only as digests.

A typed call goes only to a v307 runner (`typedDecisionQuestions`), which accepts its larger schema
(`DECISION_SCHEMA_MAX_CHARS`) and output (`DECISION_OUTPUT_MAX_BYTES`). With an older runner the
occurrence records one non-transient `runner_incapable` attempt and takes the person route.

The credential screen, follow-up relatedness and closure-reason kinds are typed (prompt version
`v2`, each with a fixed confidence threshold of 0.8; see their sections below). The scope constraint
check (#4282) comes next. Their verdict names are unchanged, so every caller, and every record from
before typed questions, keeps its meaning: a replay of a `v1` occurrence joins its recorded
single-verdict outcome and is never asked again. The optional dedicated decisions provider is
deferred, and #4283 closes without it.

## The Question and Credential Screen (`credential_screen`, #4104)

`apps/control-plane/src/credential-screen.ts` screens Full Control question and tool text that the
deterministic floor in `@wollipog/protocol` (`campaign-authority.ts`) left open. The `request`
data field is one JSON document: the `surface` (`implementation_question`, `provider_question`,
`tool_request` or `owner_decision`) and the request's own text, quoted. The occurrence key names the
session, the request occurrence and a digest of that text, so a replay joins the recorded outcome.

It asks three typed yes-or-no questions about what answering or approving the request would do. Each
one excludes a request that only names its subject as part of a design or the code:
**No Credential Handed Over** (`hands_over_credential`), **No Sign-In Performed**
(`performs_sign_in`) and **No Access Granted** (`grants_access`). The server derives:

- `ask` from a confident yes to any of them, which declines the request;
- `discusses` from a confident no to all three, which leaves it to the Orchestrator;
- `uncertain` from anything else, including a yes below the threshold, which holds the request for
  the owner to classify.

The screen's authority is unchanged. A low-confidence yes holds the request rather than declining it,
and nobody may answer a held request.

- The typed route screens an implementation question before it is admitted and passes the fact to
  the evaluation. A re-evaluation of a stored occurrence never re-screens it.
- A provider question or tool request is stored first and screened asynchronously. Every
  evaluation reads its fact from the audit (`campaignPolicyRequest`), so a runner can never supply
  one; until it settles the request is `credential_screen_pending` and nobody may answer it.
- The person-owned request for an uncertain or failed screen is the affected request itself, held
  as `credential_screen_review`. Its owner classifies it with
  `POST /api/sessions/:id/campaign/decisions/:occurrenceId/classify` (`decline` or
  `orchestrator`), once. `campaign_decision_subjects` records what each occurrence affected and the
  classification, so `GET /api/sessions/:id/campaign/decisions` lists each verdict beside its request.

## Follow-Up Relatedness and Closure-Reason Choice (#4104)

`apps/control-plane/src/campaign-decision-checks.ts` runs both checks through `runCampaignCheck`:
- one occurrence per request and inputs, so a replay or a concurrent request joins its outcome;
- the subject (`follow_up_publication` or `issue_closure`) recorded for Campaign Status;
- inputs too large for one call, or a runtime that cannot finish, recorded as a failed occurrence
  rather than judged in part.

Both are typed:

- Follow-up relatedness asks one choice, **Related to the Requested Work** (`relation`).
  `completes_requested_work` or `gap_found_in_requested_work` satisfy it, `separate_work` violates it,
  and `cannot_tell` settles nothing.
- Closure-reason choice asks **Evidence Supports the Reason** (`supports`, `does_not_support`,
  `cannot_tell`) and **Explanation Matches the Evidence** (`consistent`, `contradicts_evidence`,
  `cannot_tell`).

The confirming verdict (`related`, `fits`) leaves the request as its floor admitted it. The refusing
one (`unrelated`, `does_not_fit`) returns it to the Orchestrator with the server's sentence naming the
deciding question, followed by that answer's evidence. An uncertain
or failed check makes the affected publication or closure the person's: that request is the one
typed, person-owned request, so no second one is created. `follow_up_relatedness` is the only kind
besides `scope_grant` that reads the owner's message (the boundary objective). See
`docs/campaign-issue-scope.md` for where each check sits.

## First-Message Intent (#4104)

No verb list decides what a first message asks for. The `DIRECTIVE`, `BACKGROUND` and `NEGATION`
classification (#3920) is removed. Under Full Control, the scope grant above is the only source of
scope and context references. `issueReferenceSpans` remains only as the exact-reference fast path
and the reference bounds; the digit-string floor is `writtenAsDigits` in `scope-grant.ts`. The #3920
and #4061 regression cases run through `scopeGrantCandidates` in `scope-grant.test.ts`.

### Custom Epic Seed (`issue_scope_seed`, #4104)

A Custom campaign's epic seed and first-message issues (#4104, #4259) come from propose-then-check
since #4282, with the authority the server reading had and no new person step. The server reads
nothing from the message. When the first message writes a digit string (`needsCampaignIssueScopeSeed`)
the seed is `pending`, awaiting the Custom Orchestrator's proposal (`proposal: true`), and records who
wrote the message (`author`: the owner's create request, the owner's first prompt, someone else, or a
transcript with no author). Delegation is held meanwhile: `create_session` refuses with
`seed_proposal_required` and tells the Orchestrator to propose. The seed starts once the session is
created, or once the person's first prompt is admitted when the campaign was launched without one. A
campaign whose first message was recorded before the seed existed gets the same pending seed the
first time it tries to delegate, its issue scope is read (#4258), or it is restarted. A restart
leaves a pending proposal seed waiting; only a pre-#4282 reading interrupted mid-flight becomes the
owner's.

The Orchestrator calls `request_campaign_issue_scope_change` with the issues the message asks for as
additions (or none) and a structured `proposal`, every issue `owner_named`. `proposeCampaignSeedScope`
in `apps/control-plane/src/sessions.ts` then runs:

1. Deterministic floors, with no model call and no runner read of an unwritten number: additions only;
   every issue in the campaign repository; every number written in the person's exact message as
   digits, inside a `#`-written range, or inside a bare-digit range written right after "issue" or
   "issues" (`digitRangeMembers`), and not only as another repository's; an issue the Orchestrator
   chose is refused (`seed_owner_named_only`). One proposed issue is read for its members; every
   issue must be one the runner reads as an issue of the campaign repository.
2. The typed constraint check (`scope_check`, below) against the person's message, always, as the
   server reading always ran: an empty proposal and one that adds every referenced issue are checked
   too, so the Orchestrator alone never decides that a number is only background or that no epic is
   named. At most three distinct checks per seed whatever each proposes, and one proposal is checked
   at a time (`seed_proposal_in_flight`).
3. An admit grants exactly what the reading did. One issue with sub-issues or checklist members is the
   seeded epic, which still waits for the person's scope approval or **Continue Without an Epic**.
   Otherwise the issues become the campaign's `issueNumbers` with no person step, when the owner wrote
   the message (only the owner's create request carries `issueNumbersSource: "human_launch_request"`),
   and a v302 runner receives them for the live Orchestrator without a relaunch (#4269, see
   `docs/campaign-issue-scope.md`). An admitted empty proposal seeds nothing and holds nothing.

A refusal (a floor's or the check's) names why, and the seed stays pending while the Orchestrator
revises. An uncertain or failed check, the fourth distinct check, an unstructured proposal, a root
runner older than structured proposals or typed questions, a message the server can't confirm, or
issues from a message the owner didn't write leave the seed with the owner: today's Custom human scope
approval with no seed. It never falls back to parsing the text. That is the typed, person-owned
request: the owner approves a scope, or chooses **Continue Without an Epic**. Every check is recorded
with the `issue_scope_seed` subject, so Campaign Status shows it under Decision Model Checks as
**Epic Seed**, with the seed's state. See `docs/campaign-issue-scope.md` for the states.

## Scope Review (`scope_review`, #4103)

When the owner's first message asked the campaign to choose issues, the Orchestrator proposes the
issues it chose with selection lineage. Deterministic floors run first: a repository in the
campaign's boundary, an open issue, not already in scope, held by no other active campaign, within
the selection's count and Maximum Issues, and no Human Required label rule. Only a proposal that
passes all of them is reviewed. `proposeSelectionScope` in `apps/control-plane/src/sessions.ts` calls
the runtime; `apps/control-plane/src/scope-selection.ts` builds the inputs and the occurrence key.

- **Inputs.** The owner's exact first message is the owner's words. The data fields are quoted and
  untrusted: `grant` (the stored grant's repositories, named issues and selection), `issues` (each
  issue's number, title, state, labels and a body excerpt that shrinks so any number of issues fits)
  and `rationale` (the Orchestrator's `explanation`).
- **Verdicts.** `admit`, `refuse` with a reason, or `uncertain`. Only `admit` can confirm, and only
  the exact proposal the floors already admitted; fields outside the schema are ignored. No verdict
  can raise the count, change a repository or grant an operation.
- **Occurrence key.** The campaign, the boundary revision, the scope revision, the grant's digest and
  the sorted additions. The rationale is left out on purpose: re-proposing the same issues returns the
  recorded outcome, so a reworded rationale is never a second review, a second owner request or a
  second admission. Any re-authorization, such as the owner changing the selection count, reviews
  afresh, and a linked request retired without a decision is replaced rather than returned.
- **Failure rule.** An uncertain or failed review creates the owner's one scope approval
  (`grantReview.cause` `selection_uncertain` or `selection_failed`, with `reviewOccurrenceId`), and
  the occurrence's `humanRequestId` names it.

`campaign_selection_proposals` keeps each reviewed proposal's issues and rationale, and the scope
change an admit created, for Campaign Status. The audit still keeps only input digests. Since #4282
this review serves only campaigns whose stored grant predates the propose-then-check flow.

## Scope Check (`scope_check`, #4282)

Under the propose-then-check flow the Orchestrator reads the owner's first message and proposes the
scope; the server reads nothing from the text. After the deterministic floors, a proposal that states
anything checkable is asked the `scope_check` kind's typed questions (#4283) in one call.
`proposeOrchestratorScope` and `scopeProposalCheck` in `apps/control-plane/src/sessions.ts` run it;
`apps/control-plane/src/scope-check.ts` builds the inputs, the key and the Campaign Status view.

- **Inputs.** The owner's exact message is the owner's words. The data fields are quoted and
  untrusted: `proposal` (each issue's origin and rationale, the count, constraints, withheld
  operations and the overall rationale), `issues` (each issue's number, title, state, labels and a
  body excerpt that shrinks to fit) and `campaign` (repository, operations, issues in scope and any
  admitted count, constraints and withheld operations).
- **Questions** (`SCOPE_CHECK_TYPED`, threshold 0.8): `count_consistent`; `named_asked_for`, one per
  owner-named issue; `constraint_met`, one per chosen issue and stated constraint, so a refusal names
  both; `constraints_complete`; `nothing_omitted`; `operations_respected`. Each is a choice with a
  `cannot_tell` answer that never admits or refuses. None asks about priority, importance, impact or
  effort. Too many questions for one call is never checked in part: the proposal is the owner's.
- **Verdicts.** The server derives `admit`, `refuse` (naming the deciding question and item) or
  `uncertain`. Admit records `constraintCheck` on an Orchestrator-owned change; refuse returns
  `constraint_check_refused`; uncertain, a failure after the runtime's retries, or inputs that can't
  fit, make the proposal the owner's one approval, presented as an Owner Question. The runtime's own
  person route creates nothing: the caller does.
- **Occurrence key.** The campaign, boundary revision, scope revision, the sorted additions (a shared
  prefix) and the structured proposal: origins, count, normalized and sorted constraints, withheld
  operations. The rationale is left out, so a repeat reads the recorded outcome. One set of additions
  gets at most three distinct checks per scope revision; past that it is the owner's. A check still
  pending with other inputs is waited for within the runtime's bound, then settled as timed out.
- **Custom seed.** A Custom campaign's first-message proposal ([Custom Epic Seed](#custom-epic-seed-issue_scope_seed-4104))
  is always checked, with no fast path, under a seed-wide key prefix
  (`scope_check:issue_scope_seed:<root>:<message digest>:`), so its three distinct checks count every
  proposal of that seed whatever issues it names, and one proposal is checked at a time.

## Audit and Usage

`decision_occurrences` records the kind, prompt version, resolved target (runner, harness, model and
effort), SHA-256 digests of every input and of the rendered request, the verdict, a reason of at most
300 characters, the failure class and the person-owned request ID. It never stores the inputs.
`decision_attempts` records each attempt's number, error class, latency and usage. Cost comes from
the rate table, and an unpriced attempt has a null cost.

Campaign decisions are attributed to the campaign root. They are read through
`GET /api/sessions/:id/campaign/decisions`, with their own usage total. That total is separate from
managed worker accounting, so an unpriced Decision call never stops a campaign.
