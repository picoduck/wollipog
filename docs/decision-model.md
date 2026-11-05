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

## The Question and Credential Screen (`credential_screen`, #4104)

`apps/control-plane/src/credential-screen.ts` screens Full Control question and tool text that the
deterministic floor in `@wollipog/protocol` (`campaign-authority.ts`) left open. The `request`
data field is one JSON document: the `surface` (`implementation_question`, `provider_question`,
`tool_request` or `owner_decision`) and the request's own text, quoted. Verdicts are `ask`,
`discusses` and `uncertain`. The occurrence key names the session, the request occurrence and a
digest of that text, so a replay joins the recorded outcome.

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

The confirming verdict (`related`, `fits`) leaves the request as its floor admitted it. The refusing
one (`unrelated`, `does_not_fit`) returns it to the Orchestrator with the model's reason. An uncertain
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

A Custom campaign's epic seed uses the same `scope_grant` reading in place of the
`initialCampaignEpic` regular expression. The reading starts once the session is created, or once the
person's first prompt is admitted when the campaign was launched without one, so neither adds a wait.

Its outcome:

- Only a reading that names exactly one issue can seed it.
- The same floors apply (`scopeGrantCandidates`, against the repository the runner reports).
- The runner must read members for that issue: sub-issues or checklist members.

A failed or uncertain reading, or one the floors or the runner cannot confirm, falls back to today's
Custom human scope approval with no seed. It never falls back to parsing the text. That is the
typed, person-owned request: the owner approves a scope, or chooses **Continue Without an Epic**.
The occurrence is recorded with the `issue_scope_seed` subject, so Campaign Status shows the reading
under Decision Model Checks as **Epic Seed**, with the seed's state. See
`docs/campaign-issue-scope.md` for the states.

## Audit and Usage

`decision_occurrences` records the kind, prompt version, resolved target (runner, harness, model and
effort), SHA-256 digests of every input and of the rendered request, the verdict, a reason of at most
300 characters, the failure class and the person-owned request ID. It never stores the inputs.
`decision_attempts` records each attempt's number, error class, latency and usage. Cost comes from
the rate table, and an unpriced attempt has a null cost.

Campaign decisions are attributed to the campaign root. They are read through
`GET /api/sessions/:id/campaign/decisions`, with their own usage total. That total is separate from
managed worker accounting, so an unpriced Decision call never stops a campaign.
