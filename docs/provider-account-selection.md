# Provider Account Selection

Provider Accounts on each machine groups compact account rows by provider inside one surface.
Choose **Set as Default** in an account’s menu; its **Default** badge updates immediately. There is
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
does not imply zero allowance or prevent account management. No credential probe runs when this
section opens.

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
Selection never crosses providers. Provider model catalogs are reported per agent, not per account,
so a model is validated against the agent; an account whose plan refuses it fails at the provider.

Explicit choices win. A session, child, run or workflow that names an account uses it, whatever the
policy says or would skip. All of them resolve through one function
(`launchProviderAccount`), and multi-agent runs and workflows now bind the same account a session
would, including a fixed default. WSL agents keep their context-local account, because a POSIX path
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
Code.

### When No Account Is Eligible

A launch without an explicit account is refused with HTTP 409 and
`code: PROVIDER_ACCOUNT_CHOICE_REQUIRED`. Beside the sentence, `providerAccountSelection` gives the
provider, mode, policy revision, `refusal`, each candidate and why it was passed over, the `actions`
available (`choose_account`, `sign_in`, `wait`, `review_provider_accounts`, `update_runner`), and
`retryAt` when a limit is known to clear. Nothing is created: a run with one such member starts none
of them. Unattended callers can act on this result; interactive ones offer the same account choice.

### Compatibility

`PUT /api/runners/:id/provider-account-policies/:provider` writes `{ mode, fixedAccountId?,
priorityAccountIds?, expectedRevision }` and keeps any field it omits, so a mode change loses neither
the saved default nor the saved order. `GET /api/runners/:id/provider-account-selection?agentId=` (or
`?provider=`, with an optional `projectId`) previews what a launch would do now, resolved by the
launch's own code, with an `enforcement` of `enforced`, `machine_offline` or
`runner_update_required`. A preview promises nothing: every launch resolves again.

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
mode, policy revision and skip counts by reason) name no account. Only `candidates`, returned to a
caller who can already read the machine's account inventory, carries account ids.

## Remaining Work in #4353

Reset-aware **Automatic Balance** is not implemented, and neither the API nor the stored policy offers
it. It needs fresh usage for idle accounts and a rule validated across multiple windows and unequal
plans. The stored policy already has room for it: `mode` is unconstrained text with a `mode_settings`
column beside it, so adding a mode needs no migration, and until then a value this release doesn't
know fails closed. Candidates pass the shared eligibility checks in `providerAccountIneligibility`
first; a mode only chooses among what remains, in `chooseEligibleCandidate`. Neither mode may spend
API credits implicitly.
