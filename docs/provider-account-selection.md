# Provider Account Selection

Provider Accounts on each machine groups compact account rows by provider inside one surface. With
more than one account, each provider's heading chooses **Default Account** or **Priority Order**.

Under Default Account, choose **Set as Default** in an account’s menu; its **Default** badge updates immediately. There is
no separate picker or full-screen default editor. **Clear Default** in the default account’s menu
restores the agent’s configured account or the existing fallback. One **Add Account…** action opens
the existing dialog with its provider choice. The default applies to new
sessions in the execution contexts already supported by the machine-default API. Choosing an
account explicitly for a session still overrides it. Editing a default does not move existing
sessions.

An unset default preserves each agent's configured account and the existing implicit fallback.
A missing saved account remains visible until the person replaces or clears it. The existing API's
global authorization requires an owner/admin of the personal control-plane organization who can
manage the machine. Profile grants, account-email masking, and conditional writes retain their existing
boundaries. A conflicting action displays the server’s current choice, even when the machine stream is
behind, and requires another explicit menu action rather than retrying or overwriting silently. Offline preferences save immediately; the runner applies
them when it reconnects. Sign-in and other machine-executed actions still require a connection.

Usage in the overview is informational. It comes from the existing permission-scoped cached usage
endpoint, matched by machine, provider, and account. Expand **Usage Details** to see the reported
windows and their reset times. Stale readings are marked **Last Known**; an unavailable reading
does not imply zero allowance or prevent account management. If a refresh fails, as during a
reconnect, the section keeps the last reading for that machine and lets it age into **Last Known**. It
drops a reading for an account whose server access has changed since. No credential probe runs when
this section opens.

**Switch Accounts at a Usage Limit** is one inline switch, independent of provider defaults. It
controls the existing machine-wide handoff. Enabling it retains the provider-terms confirmation;
turning it off saves directly. Conditional writes, offline saving, handoff validation and cooldowns
are unchanged. A conflict displays the saved value and requires another explicit action.

**Account Access…** in the account menu explains which Wollipog servers may use the account. A
content-height dialog offers **Limit Access to This Server…** for an unrestricted account,
**Give This Server Access…** for one without a local grant, **Retry Access…** for a pending grant,
and **Remove This Server’s Access…** where granted or pending. These actions retain their consent
and active-session checks. They do not set the default account. Recovery actions remain directly
available in the account menu when needed.

Under Priority Order, each ranked row shows its place, **Move Up** and **Move Down** buttons that work
by keyboard and touch, and why it would be skipped. The group says which account new sessions are
expected to use and why, and marks it **Next Session**. **Add to Priority Order** and **Remove from
Priority Order** are in the account's menu. An account that isn't ranked reads **Not Ranked**, and one
that left the machine keeps its place until removed. Turning Priority Order on starts from the saved
default, then the listed accounts this server may use; returning to Default Account restores the
default. New Session and New Multi-Agent Run show the expected account and its reason. Choosing a
different account in New Session overrides the policy for that session. When no account is eligible,
New Session asks for one before it can start, and New Multi-Agent Run asks for each member that needs
one, under either Run Type. A member whose account is fine stays with its expected account.

## Selection Policy

Each provider on a machine has one versioned policy, stored by the control plane as account
references and policy metadata only, never credentials. It survives restarts. Every write names the
revision it replaces, and a stale write is refused with what is saved now.

- **Default Account** (`fixed`) uses the chosen account. A saved default that is missing or unusable
  stays visible and requires an explicit replacement; another account is never substituted. With no
  default, sessions keep the existing fallback: the agent's configured account, then the first
  account this server may use. Each session records which of these applied.
- **Priority Order** (`priority`) uses the first eligible account in a saved order. An account that
  isn't ranked is never chosen automatically. An account that left the machine stays ranked, and
  reported as missing, until someone removes it.

Under Priority Order an account is passed over, with a readable reason, when it:

- lacks this server's access (not granted, still being confirmed, or revoked);
- needs sign-in, or its sign-in can't be confirmed;
- can't run in the agent's execution context;
- would spend API credits, or its billing can't be verified as a subscription. An agent configured
  with its own key or cloud route passes over every account, because it bills that route;
- recently hit a usage limit during an automatic switch (the switch's cooldown);
- has a usage window or spend control that a reading reports as used up, until its reset passes.

Missing or old usage readings don't disqualify an account: only a reading that says "used up" does.
Selection never crosses providers.

Explicit choices win. A session or child that names an account uses it, whatever the policy says or
would skip. A run or workflow names one per member (`providerAccountIds` by agent id,
`providerAccountBindings` by role, `orchestratorProviderAccountId`), and a member it doesn't name
follows the policy. All of them resolve through one function (`launchProviderAccount`), and multi-agent
runs and workflows bind the same account a session would, including a fixed default. Of automations,
only an Orchestrator session automation can name one; every other run resolves when it starts. The
automation editor and an agent's Create Automation approval show that resolution from the preview below
as an expectation, rechecked when each run starts, and a session automation with no eligible account still
saves (#4512). WSL agents keep their context-local account, because a POSIX path
doesn't identify its owning distribution, so a machine policy doesn't apply to them.

Resolution happens at dispatch and again at launch. The runner rechecks a Priority Order choice
before binding a new session, and refuses if the account has since stopped being usable. That launch
fails visibly and doesn't move to another account: starting again runs selection again. An accepted
launch that is retried keeps the account it first resolved to, and a restart keeps the session's
binding. Policy changes never move an existing session. **Switch Accounts at a Usage Limit** remains
a separate opt-in control with its own provider-terms warning and safety checks.

Project sessions on a Claude Code older than Wollipog's project memory keep that memory in the
account's HOME. Priority Order refuses these launches, because choosing a different account later
would silently change what the session remembers; they need an explicit account or a newer Claude
Code. This covers the project a launch would join without naming one: a child follows its parent, and
any other launch follows its workspace's Location when that workspace has exactly one and the
session's audience fits inside the project. A workflow's orchestrator is organization-scoped, so a
narrower project keeps it out and it answers only for a project it joins. No Project is a choice, and nothing is inferred for it. A
preview given the workspace reads this same rule. Without a workspace, as in Provider Accounts, it
has no project to predict.

### Model Compatibility Is Not Enforced

Selection doesn't check that an account's plan offers a model, because no reliable per-account source
exists. A model is validated against the agent's catalog only. A launch that names a model under
Priority Order records `modelCompatibility: "unknown"`, and agent tools repeat that with the result.
Nothing is said when no model is named. New Session has no model at creation, so its preview gains
no warning.

A refusal is recoverable. The provider's error reaches the caller, and nothing retries on another
account or moves the session: an automatic switch answers usage limits only. To get past it, start
the session with an explicitly chosen account.

What this rests on, from reading the code; no probe ran against real accounts, because that would
mean using other accounts' credential HOMEs:

- Discovery runs one model probe per agent, version, context and HOME, in the single account a launch
  would select (`enrichAgentModels`, `selectProviderAccountForDiscovery`). `ProviderAccountDefinition`
  has no models.
- The per-account probes return no models: `claude auth status` (`subscriptionType`, not kept for
  accounts), `codex login status`, and Codex `account/read` with its rate limits (`planType`).
- Codex `model/list` and Claude's control `initialize` are authenticated catalogs and could run in each
  account's HOME. Each run needs that HOME's lease and a provider process, a busy HOME gives no answer,
  and nothing here shows that two plans return different lists or that a listed model will run.
- A plan's refusal has no known signature. Claude 400 and 404 and Codex `badRequest` read as
  `invalid_request`, and 403 reads as `permission`; no fixture captures a real one.
- Plan names aren't used to guess, and no catalog is invented.

Either of these would change the decision: a captured real refusal, which could support skipping an
account after it refuses a model, or proof that catalogs differ by plan, which could justify probing
each account. Until then, nothing here can support choosing an account by model.

### When No Account Is Eligible

A launch without an explicit account is refused with HTTP 409 and
`code: PROVIDER_ACCOUNT_CHOICE_REQUIRED`. Beside the sentence, `providerAccountSelection` gives the
provider, mode, policy revision, `refusal`, each candidate and why it was passed over, the `actions`
available (`choose_account`, `sign_in`, `wait`, `review_provider_accounts`, `update_runner`), and
`retryAt` when a limit is known to clear. Nothing is created: a run with one such member starts none
of them. Unattended callers can act on this result; interactive ones offer the same account choice.

### Agents Naming an Account

`create_session` and `wollipog session create --provider-account` accept an optional account, and
`get_provider_account_selection` and `wollipog session accounts` list what can be named. An agent's
refusal text names this route. Both need protocol 337 on the control plane; the tools refuse before
sending anything to an older one, so a choice is never silently dropped. `create_run`
(`providerAccountIds`) and `create_workflow_run` (`providerAccountBindings`) do the same per member
and need protocol 338, for the same reason. A key that is no member is refused rather than ignored, and
a refusal of a named account starts no member and names the member it was for.

Agents see accounts only as opaque `accountRef` values, stable for one account on one Machine, because
an account's id contains its label. The server enforces this on the selection route and on a launch's
refusal: an agent's credential gets no `candidates` or `accountId` from either. The control plane
resolves a reference to the account and sends the runner the real one, and it accepts a real id too. A reference that matches none of this agent's
provider's accounts is refused like any unknown id.

A named account overrides the policy and goes through the same checks as the API. An agent is also
refused an account that lacks access, needs sign-in, can't run in the agent's environment, or would
spend API credits, because it can neither recover a sign-in nor make that billing decision; a person
choosing the same account keeps those decisions. Usage limits and cooldowns don't refuse: overriding
them is what an explicit choice is for, and `reason` still reports them. An execution target that
doesn't use this machine's accounts refuses a named account rather than ignoring it. Because a label
never reaches an agent, it can choose by eligibility but can't pick "the Work account" by name.

### Compatibility

`PUT /api/runners/:id/provider-account-policies/:provider` writes `{ mode, fixedAccountId?,
priorityAccountIds?, expectedRevision }` and keeps any field it omits, so a mode change loses neither
the saved default nor the saved order. `GET /api/runners/:id/provider-account-selection?agentId=` (or
`?provider=`) previews what a launch would do now, resolved by the launch's own code, with an
`enforcement` of `enforced`, `machine_offline` or `runner_update_required`. Pass `workspaceId`,
`projectId` or `noProject=1` to place it, and `model` to ask about a named model. A preview promises
nothing: every launch resolves again.

- A runner below protocol 334 can't recheck a choice, so Priority Order is refused for it, both when
  saving and when launching. Explicit accounts and Default Account keep working.
- An offline machine whose last-known runner supports Priority Order can save it. The preview reports
  `machine_offline` until it reconnects, and no session can start there meanwhile.
- The older `PUT .../provider-account-defaults/:provider` route writes only a fixed default. It refuses
  a non-fixed policy with `PROVIDER_ACCOUNT_POLICY_NOT_FIXED` even at the current revision, so an older
  client can't overwrite what it can't show. Those clients read `accountId: null` for such a policy.
- A stored mode this release doesn't recognize reads as `unsupported`, and launches without an
  explicit account fail closed until it's replaced.

### Privacy

Account labels are personal data and account ids are derived from them. Refusal sentences, log lines,
the runner's launch refusal and the reason stored on a session (`providerAccountSelection`: source,
mode, policy revision and skip counts by reason) name no account. Only `candidates` and a saved
default's `accountId`, returned to a person who can read the machine's account inventory, carry
account ids. A session's own fields carry them too, for a person. An agent's credential gets references
and reason codes instead. These are narrowed for it:

| Route | What an Agent's Credential Gets |
| --- | --- |
| `GET /api/runners/:id/provider-account-selection` | `choices` by `accountRef`; no `candidates` and no `accountId`. |
| A launch's `PROVIDER_ACCOUNT_CHOICE_REQUIRED` refusal | `refusal`, `actions` and `retryAt`; no `candidates`. |
| `GET /api/runners` | No accounts, saved policies or sign-in operations, and no default account or readiness on each agent. Each agent's `available` and `authStatus` stay. |
| `GET /api/sessions` and `GET /api/sessions/:id` | No `providerAccountId` or `providerAccountLabel`; `providerAccountRef` names the bound account instead. |
| Every other JSON response to that credential | No `providerAccountId` or `providerAccountLabel` anywhere in it. |

Every other JSON response covers what returns or embeds a session: launches, stop, restart,
configuration and worktree commands, `POST /api/runs`, `POST /api/workflow-runs`, and the Orchestrator's
campaign reads. It also covers a session's account-switch failure, provider-HOME refusal and wait, and
`provider_account_switched` events on `GET /api/sessions/:id/events`, which keep their other fields. A
reference an agent sent stays as it is. Account ids and labels are removed in the response serializer for
every agent principal (`withoutProviderAccountNames`). The session list's cached entry is narrowed before
it is stored. That cache is keyed by principal, so an agent's narrowed list never serves a person and a
person's full list never serves an agent.

`providerAccountRef` is the same `acct:` reference `get_provider_account_selection` lists, so an agent can
pass it to `create_session` to launch on the account a session used. `get_session` returns it. A control
plane older than #4508 sends neither the reference nor any narrowing, and an older runner's tools never
read a session's account fields, so mixed versions keep working.

Agent credentials can't reach the archive page (`GET /api/sessions/archive-page`), session lookup
(`GET /api/sessions/lookup/by-id`) or the dashboard's live session stream (`/ui`). The Orchestrator's
descendant request cards already omit both fields (#2714). People read every route as before.

## Stored Policy Shape

`machine_provider_account_defaults` holds `mode`, `priority_account_ids`, `schema_version` and an unused
`mode_settings` column. `mode` is unconstrained text, and a value this release doesn't recognize reads as
`unsupported` and fails closed. Every candidate passes `providerAccountIneligibility` before a mode chooses,
in `chooseEligibleCandidate`, and no mode spends API credits implicitly.

## Automatic Balance Was Not Built

#4353 proposed a third mode that would prefer an account whose allowance is about to reset. On 2026-11-09 the
owner decided not to build it. The API, stored policy and interface have no such mode, no refresh was added for
it, and the issue's reset-aware criterion is not delivered. Default Account and Priority Order are unaffected.
This section records why, and what would justify looking again.

### What Wollipog Can Observe

These come from reading the code. No probe ran against a real account, and no real usage was read.

- **Claude.** Readings arrived only from provider responses in a session, so an idle account had an old reading
  or none. Since protocol 342 a refresh also reads Claude without a turn, through Claude Code's experimental
  `get_usage` control request, where the installation supports it, at the same times as Codex.
- **Codex.** A no-turn probe spawns `codex app-server`, up to 8 seconds per account and one at a time, holding a
  reference to the account's provider HOME. It runs at runner start, sign-in, a harness change or a person's
  Refresh. The 5-minute discovery timer explicitly skips it.
- **Windows.** A reading had one `fetchedAt`, so a sparse event could make an older window look fresh. Since
  protocol 341 each window carries its own `observedAt`.

A reading counts as fresh for 10 minutes, so in practice only an account in active use has one. Those are the
accounts a comparison needs least.

### The Rule That Was Tested

Use the account that would lose the most to its next reset: the remaining percentage of its longest window,
discounted by the time to that window's reset, so 40% resetting in 3 hours beats 80% resetting in 5 days. A
shorter window about to reset adds a small nudge, and an account whose tightest limit is under 10% goes last.
Everything `providerAccountIneligibility` refuses still comes first. When any eligible account is unknown there
is no safe choice, because the accounts with numbers are the busy ones. Equal percentages on unequal plans tie:
percentage ranking is a heuristic, not capacity.

### What the Simulation Showed

Read these for direction, not precision. They come from a model with invented workloads, not from measurement.

| Rule | Launches Where It Could Compare Every Eligible Account | Work Not Served | Allowance Lost at Resets |
| --- | --- | --- | --- |
| Priority Order | Doesn't compare | About 12% | About 25% |
| Fresh readings only, idle accounts unknown | 0% for one person working alone; 1–43% with parallel or campaign work | About 11% | About 24% |
| Compare only the accounts with fresh numbers | Almost none | About 12% | About 24% |
| Last-known reading of any age | 93–99.6% | About 7% | About 18% |
| Perfect information | All, or about all with a Codex-only probe at each launch | About 5% | About 16% |
| Round robin, reading no usage | Doesn't compare | About 5% | About 16% |
| Highest remaining percentage, ignoring resets | Doesn't compare | About 4% | About 17% |

These are at 95% load, across all workloads and account sets. Three things follow:

- Balance on fresh readings matches Priority Order, while finding no safe choice on 85–100% of contested
  launches. That means a question at nearly every launch, and unattended launches refused.
- Most of the gain comes from spreading work, not from reset timing: round robin ties perfect information.
- Reset timing helped only when the weekly limit alone was what ran out. There, earliest reset first with perfect
  information lost about 12% of allowance against round robin's 13% at 95% load, and 7% against 9% at 120%. When
  five-hour limits bound it did worse, with about 9% of work unserved, because it concentrates work. Other urgency
  curves didn't change this.

### Assumptions

- Workloads are invented: one person's sessions in turn, three sessions at a time through a working day, and
  48-hour campaign bursts, over 2 to 4 accounts for 4 weeks, with one account set holding a plan 5 times larger.
- A five-hour window holds 20% of a week's allowance and starts at first use. At 10% and 40% every number moved,
  but Priority Order stayed worst and round robin stayed level with or ahead of perfect information.
- Weekly windows have fixed, unrelated reset times.
- 5% of each account's capacity is spent outside Wollipog, unseen until its next reading. At higher shares,
  last-known scoring more often chose an account that was really used up.
- A session cut off by a limit loses its remaining work, which overstates what any rule saves.

### What Wasn't Verified

Real workloads, how long accounts really sit idle, real window ratios, how Claude windows start, whether Codex's
rate-limit read counts against allowance, and the real shape of every provider's windows beyond existing fixtures.

### Provider Terms

**Switch Accounts at a Usage Limit** warns that automatically rotating between your own subscriptions can be a
gray area under provider terms. Every Balance rule considered here rotates accounts between new sessions. The
terms themselves weren't assessed.

### What Would Justify Reopening It

Both of these, together:

- Real measurements of how old each account's reading is at launch, in place of the assumed workloads.
- Per-window observation times, proposed in #4363, so a sparse event can't make an older window look fresh.

Even then, the evidence has to show that reset timing beats simply spreading work.
