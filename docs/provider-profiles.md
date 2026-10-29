# Provider Profiles

A provider profile gives one provider account HOME (a Claude or Codex credential and conversation
directory) a stable host-local identity, and records which control planes may use it (#3239).
Replacing a runner, or connecting the same SSH account from another control plane, used to produce a
new lease owner that could not use the HOME its predecessor configured. With a profile, access no
longer depends on a disposable Machine or runner id.

## Premise

Every runner on one OS account has the same filesystem power. Grants prevent implicit or accidental
use of a profile by a control plane that was not granted it. They are not a defense against a hostile
process on the same OS account; isolated OS accounts remain the security boundary for that case.
Credentials stay host-local and HOME directories are never copied.

## Concepts

- **Profile identity.** A versioned `profile-v1` marker inside the HOME, at
  `<home>/.agent-manager/profile-v1.json`, holds a random UUID, the provider, and the host-local list
  of granted control-plane instances. It travels with the directory. Its format and checks are in
  [Provider HOME Lease Worker](./provider-home-lease-worker.md#provider-profile-identity).
- **Grant.** The control plane's authoritative, audited row in `provider_profile_grants`: this
  control-plane instance may use this profile in one organization/owner scope (`scope =
  'provider_home'`). A grant is not bound to a runner: a replacement runner in the same scope keeps
  it. `runner_id` and `provider_account_id` record only where the grant was made.
- **Host-local record.** The marker lists one `{ controlPlaneInstanceId, grantId, grantedAt }` per
  granted instance, at most 16. A runner refuses a control plane that the marker does not list.

The lease journal is unchanged. Grants are checked before acquisition, and the journal keeps its
runner and control-plane owner and per-process holder.

## Grant Lifecycle

| Status | Meaning |
| --- | --- |
| `pending` | An Owner or Admin authorized the grant (adoption), or the account's creator did (Add Account, `origin = 'created'`); the runner has not confirmed the profile id it wrote. One per runner account. |
| `active` | The runner recorded the grant in the marker and reported the profile id. One per profile and control-plane instance. |
| `revoked` | Revoked by an Owner or Admin, by account removal, by a coded runner refusal, spent by an Add Account sign-in that recorded no profile-bearing account, or superseded by a newer grant of the same control plane to the same profile. |

The marker holds one grant per control-plane instance, so a newer grant of the same control plane to
the same profile (for example from a second runner on the same OS account) supersedes the older row
in the same transaction.

## Adoption

Migration is explicit. Existing accounts and sessions are left alone until an Owner or Admin adopts
an account:

`POST /api/runners/:id/provider-accounts/:accountId/adopt-profile` with
`{ "acknowledgeProfileAdoption": true }`.

1. The control plane records a pending grant attributed to the caller and role, then sends
   `adopt_provider_profile { requestId, accountId, grantId }`.
2. The runner refuses Windows hosts and non-POSIX (WSL) account homes as `UNSUPPORTED_HOME`, since a
   marker there cannot be verified. Otherwise its lease worker takes the HOME's lease, creates the
   identity if the HOME has none, and records this control plane's grant. A HOME that another control
   plane already adopted keeps its identity and gains this grant. A HOME another owner holds is
   `HOME_IN_USE`; a marker that cannot accept the grant (unreadable, the other provider's, or full) is
   `PROFILE_EXISTS`.
3. The runner persists `profileId` on the account in its configuration, starts using the grant, and
   replies `adopt_provider_profile_result { ok, profileId }`. The control plane activates the grant.

Adoption is atomic from the runner's point of view: the grant becomes usable only after the
configuration write succeeds. If anything fails after the marker write, the runner takes this grant
back out of the marker under the HOME's lease, never records it, and only then replies with the
error (without a code). The HOME keeps the identity the adoption created, so the account is not usable
through this control plane until an adoption succeeds; a retry reuses the pending grant.

A retry while the grant is pending reuses it, so the runner sees the same grant id; once active, a
repeat returns the active grant. A coded refusal happens before the marker changes and spends the
pending grant. A failure without a code leaves it pending. A lost reply (a timeout) also leaves it
pending; the runner's next account report shows the profile as `granted` or `pending`, and the
control plane completes the grant from it. The runner treats a pending grant its marker already
records as usable, because an Owner or Admin authorized it.

A pending grant can be revoked while the runner is writing it. Its row names no profile yet, so the
revocation cannot reach the runner then. If the adoption still succeeds, the grant cannot be
activated; the control plane returns 409 `PROVIDER_PROFILE_GRANT_REVOKED` and at once sends that
runner `revoke_provider_profile_grant` with the profile id it returned, so the runner stops using
the grant and drops it from the marker without waiting for its next registration.

When the reply never reaches the adoption route (it arrives after the request timeout), the account
report closes the gap instead. Whenever a runner reports an account whose profile it may use here
(`granted` or `pending`) but no live (pending or active) grant of this control plane covers that
runner account or that profile, the control plane sends `revoke_provider_profile_grant` with the
reported profile id and the most recently revoked grant for that runner account (else the latest one
naming the profile). Each (runner, account, grant) is sent at most once per five minutes, so repeated
account reports do not repeat it. No reconnect is needed.

Adoption is strict. After adoption only explicitly granted control planes may use the HOME; grants are
never reconstructed from lease-journal owners. Other control planes that share the Machine's OS
account lose the implicit access they had to the HOME. Sessions created after adoption record the
profile id (see [Sessions](#sessions)). Accounts created through Add Account are profiles from the
start; see [Managed Profiles](#managed-profiles).

## Managed Profiles

An account created through Add Account on a v225 runner connected to a v225 control plane is a
managed profile. Its HOME is `~/.agent-manager/profiles/<profileId>`: one root per SSH account,
outside every runner's owner-namespaced data directory, named by a fresh random profile id. Existing
account homes keep their paths, and an older control plane (or runner) still creates new homes at
`<dataDir>/provider-accounts/<accountId>` without a marker.

The control plane that creates the account is granted it automatically:

1. `POST /api/runners/:id/provider-logins` without `accountId` (anyone who can manage the Machine)
   records a pending grant with `origin = 'created'`, `granted_by` the caller and `granted_role` the
   caller's organization role, and sends its id as `start_provider_login.profileGrantId`. A non-human
   caller, or a runner without a recorded scope, gets no grant and today's HOME. Adoption and
   revocation stay Owner/Admin only.
2. The runner creates `.agent-manager` and `profiles` (0700 when missing) and refuses either one
   when it is a link, owned by another user, or writable by group or others. It creates
   `<profileId>` 0700 and refuses one that already exists. Its lease worker then writes the first
   marker, holding the HOME's lease (`profile_create`), with this identity and only this control
   plane's grant. Only then does the sign-in take the HOME's lease and start the provider.
3. The start reply names the new account id; the control plane binds the pending grant to it (until
   then the row's account key is a placeholder that matches no account). When the sign-in succeeds,
   the runner records the account with its `profileId`, counts the grant as active, and reports the
   account with `profile.access = 'granted'`; the account report completes the pending grant, as a
   lost adoption reply does.

Windows runners (including their WSL account homes) cannot verify a marker, so they ignore the grant
and create today's HOME; the control plane spends the grant when the account is reported without a
profile.

A sign-in that does not record the account spends the grant on both sides:

| Outcome | Runner | Control Plane |
| --- | --- | --- |
| The start is refused (no agent, the profile cannot be created, the lease is unavailable) | Retains any created HOME and ownership evidence; settles any created grant | Revokes the grant from the start reply |
| Cancelled, failed or timed out | Forgets the grant and retains the HOME, including scratch files and credentials; drops the grant from the marker under the lease when possible | Revokes the grant when the sign-in inventory reports the settled sign-in |
| A duplicate of an account already on the Machine | Retains the new HOME and credentials; drops the grant from its marker when possible | Same as failed |

A lost start reply leaves the grant pending and unbound. The runner still uses it, and the account
reports `pending` access; adopting the account replaces the grant in the marker.

Labels are reserved the same way as before: a second Add Account with the same provider and an
equal label (trimmed, case-insensitive) is refused while the first is running. A managed start
reserves its label before it creates the HOME, so an overlapping request is refused without creating
a HOME or starting a process; the reservation ends when the sign-in settles or its start fails.

## Replacement Runners

A grant is bound to a profile, a control-plane instance and an organization/owner scope, never to a
runner. A replacement runner (a new runner id, so a new owner hash and data directory) for the same
control-plane instance and the same `~/runner.config.json` reports the same profile ids at
registration and is listed the same active grants. After the old runner released the HOME's lease in
an orderly shutdown, the replacement acquires it, binds new sessions to the same profile, and keeps
resumable conversations, without any filesystem change. Because a managed HOME is outside the
owner-namespaced data directory, the replacement may also retire it when the account is removed.

A runner connected to another control-plane instance is refused at the lease as
`profile_not_granted`, and its account reports show `not_granted`, until an Owner or Admin there
adopts the profile.

A stale lease left by a crashed predecessor on the same host is recovered when the profile grants the
replacement's control plane and the predecessor's lifecycle evidence proves nothing it launched
survives: the host rebooted, or a same-boot process scan finds no survivor (#3241; see
[the lease worker](provider-home-lease-worker.md#recovering-an-abandoned-lease)). The recovery is an
explicit journal record; the old lease is kept, never released on its behalf.

A lease without evidence (from an older runner, or on macOS), or any lease on a HOME without a
profile grant for this control plane, needs an Owner or Admin's one-time authorization. The Accounts
list on a v229 Machine shows **Recovery Needed** for such an account. **Recover Account** is offered only
when the runner reports that a recovery would proceed: the record has evidence that proves it
abandoned, or the Machine has restarted since the record was written. Otherwise the badge's tooltip
explains why in plain language. An Owner or Admin can open **View Recovery Details** for the
structured recovery code and safe blocking-process metadata. For an unreadable process, the primary
guidance offers another account or saving work and restarting the machine; restarting Wollipog alone
does not supply the missing proof for a historical lease. No action stops unrelated processes or
changes the account's recovery records to bypass that check. The authorization names the exact record that was inspected and is used once; see
[Owner/Admin Recovery Authorization](provider-home-lease-worker.md#owneradmin-recovery-authorization).

## Web Actions

The Accounts list on a Machine shows each account's profile state from `profile.access`: **Profile**
(`granted`), **Grant Pending** (`pending`) or **Not Granted** (`not_granted`); a legacy HOME has no
badge. An Owner or Admin of the personal control-plane organization sees two actions on a v225
runner, and nobody sees them on an older runner. A member who can manage the Machine, and an Owner or
Admin of any other organization (whom the routes refuse; see
[Authorization and Audit](#authorization-and-audit)), see only the badges:

- **Adopt as Profile**, for an account without a profile, `not_granted`, or `pending` (a retry), while
  the Machine is online. The confirmation says that after adoption only control planes granted the
  profile can use the HOME, so other control planes sharing the Machine's account lose access, and
  that existing sessions keep working while new sessions record the profile. Coded refusals, the
  capability refusal and a 504 (the Machine did not confirm in time; the grant completes when it
  reports the account again) are shown in the section.
- **Revoke Access**, for `granted` or `pending`, also while the Machine is offline (the control plane
  records the revocation; the runner drops the grant at its next registration). The confirmation
  says sessions that use the profile cannot restart until access is granted again and that other
  control planes are not affected. A `PROVIDER_PROFILE_HAS_ACTIVE_SESSIONS` refusal opens a second
  confirmation, **Revoke Access from Active Sessions**, listing the sessions, which retries with
  `force: true`.

On a Windows Machine, **Adopt as Profile** is shown disabled with the reason: a Windows runner cannot
verify a profile marker and refuses every adoption as `UNSUPPORTED_HOME`.

## Session Launch Refusals

When a session's launch is refused at a provider HOME's lease (the driver launch, or launch
preparation for an account HOME), a v233 runner records the refusal's code on the session and
reports it in session snapshots as `providerHomeRefusal`: the code, the provider, the bound account's
id and label (absent for the runner's own provider HOME), and the time. It never carries a path. The
control plane stores it in `sessions.provider_home_refusal`, drops a malformed one, and projects it
as `SessionView.providerHomeRefusal`; the session's next launch clears it (`null`). Cancellations,
deadlines and recovery codes are not states of the HOME, so they stay text only. A refusal during
launch preparation is reported as `provider account unavailable`, no longer as an isolation failure.

A failed or stopped session from a runner without a specific recovery cause shows one notice for
the code, with the recovery it needs:

| Code | Notice | Actions |
| --- | --- | --- |
| `busy` | **Account in Use** | Restart Session, Switch Account… |
| `foreign_owner` | **Account Locked by Another Runner** | Recover Existing Profile…, Switch Account… |
| `foreign_host` | **Account in Use on Another Host** | Switch Account…, Set Up Managed Profile… |
| `unavailable` | **Lease Helper Unavailable** | Restart Session |
| `unverifiable` | **Lease Can't Be Verified** | Switch Account… |
| `profile_not_granted` | **Profile Not Granted** | Recover Existing Profile…, Switch Account… |
| `profile_changed` | **Profile Changed** | Switch Account…, Open Machine Accounts |
| `profile_unverifiable` | **Profile Can't Be Read** | Open Machine Accounts, Switch Account… |

A refusal of the runner's own provider HOME (no account bound) names it as "this Machine's Claude
sign-in" (or Codex) and offers no account switch: the way out is a managed profile of this control
plane, so a busy, locked or foreign-host refusal of that HOME offers **Set Up Managed Profile…**
(after **Restart Session** when it is only busy). The profile serves new sessions: a session bound
to no account can't be switched onto an account, so the refused session itself keeps the Machine's
own HOME. Older runners report only text; the session's **Turn Failed**
notice says that the runner couldn't use the session's provider account, with the runner's message
under its details.

When the v235 structured recovery cause is available, the notice instead uses plain-language
guidance for that cause. A live runner or surviving session offers **Restart Session** after its work
finishes, then **Switch Account…**; other causes prioritize **Switch Account…**, followed by **Open
Machine Accounts**. The transcript keeps the established `provider account unavailable:` prefix on
both launch paths so older clients still recognize the account-specific error; its explanation no
longer includes process-boundary or journal instructions. Technical recovery codes and process
metadata stay in the authorized account details rather than the badge tooltip.

### Waiting for a Busy Account

A busy account frees itself once the other holder finishes, so with a v248 runner a **busy** refusal
(including its live-runner and surviving-session causes) offers **Wait for Account** in place of
**Restart Session**: its launch starts at once when the account is already free, so a plain restart
would only risk a second refusal. It restarts the session with `waitForProviderHome` (`POST /api/sessions/:id/restart` with
`{ "waitForProviderHome": true }`); the control plane refuses the request for an older runner rather
than letting it fail the launch again.

The runner waits, not the browser. Only that launch waits: every provider-HOME acquisition it makes
(launch preparation's account HOME and the driver's) retries a `busy` lease with backoff from 2
seconds up to 30 seconds between attempts. Nothing is held between attempts, and the provider
starts only after an acquisition is granted. While it waits the session stays **starting** and
reports `providerHomeWait` in its snapshots: the provider, the busy cause, the bound account and
when the wait started and ends, never a path. The control plane stores it in
`sessions.provider_home_wait` and projects it only while the session is starting. The session shows
**Waiting for Account** (an info notice, not a failure) with **Stop Waiting**, and lists show a
**Waiting for Account** condition.

- **Stop** (or **Stop Waiting**), a restart, deletion or runner shutdown ends the wait; nothing
  started, so nothing needs to be stopped, and no refusal is recorded.
- Any other refusal ends the wait with that refusal, exactly as a launch that didn't wait.
- After 8 hours the wait gives up and the launch fails with the ordinary **Account in Use**
  refusal, so a forgotten wait doesn't hold its runner slot indefinitely. A waiting launch keeps
  the runner capacity it was admitted with, as any starting launch does.
- The wait is in the runner's memory only and does not survive a runner restart, which ends the
  launch it belonged to. A later launch of the session, including an account switch or an ordinary
  restart, doesn't wait unless it is asked to.

### Refused Forks

A conversation fork (including Recover Conversation and Edit in Fork) launches its own provider
under the source session's account, so its lease can refuse it too. A v248 runner returns the same
typed `providerHomeRefusal` in `fork_result` for a v248 control plane, which passes it on in the
fork's 409 response. The fork's failure notice then has the same title as a refused session launch
and the same guidance, worded for a fork ("so the fork didn't start. Try again once it's free."),
with the runner's message under its details. A fork is never waited for. The source session is
unaffected. Older peers keep the text-only failure.

## Set Up and Recover Onboarding

Two control planes connected to the same SSH account share the runner user's own provider HOME,
so the second one's sessions are refused at its lease. The refusal notice leads to the Machine's
accounts with one of two actions (#3240):

- **Set Up Managed Profile…** opens **Add Account** with the session's provider selected. The
  sign-in creates a managed profile granted to this control plane only (see
  [Managed Profiles](#managed-profiles)). Once it records the account, the section offers
  **Use for New Sessions**, which saves it as the Machine's default account for that provider, so new
  sessions that don't choose an account use it.
- **Recover Existing Profile…** is for a configured account. One confirmation covers what the
  account needs before this control plane can use it again: **Adopt as Profile** when its profile
  isn't granted here, then, after inspecting the lock again, **Recover Account** when an earlier
  runner left it locked. Each step keeps its own checks; a lock the runner still refuses to recover
  (for example one without reboot proof) is explained in the section and left alone.

The actions follow the routes' authority. Set Up Managed Profile needs manage rights on the
Machine and a v225 runner; Use for New Sessions and Recover Existing Profile need an Owner or Admin
of the personal organization as well. A viewer who can't complete one gets **Open Machine
Accounts** instead, where the section says why. Recover Existing Profile is not offered for the
runner's own HOME, which has no account to adopt. Importing an existing sign-in into a managed
profile is tracked separately (#3719).

A session that doesn't choose an account never takes one whose profile only other control planes
may use (`profile.access` of `not_granted`): the control plane's implicit choice, and New Session's
displayed preselection, skip it. Such an account can't be saved as the Machine's default either
(409 `PROVIDER_PROFILE_NOT_GRANTED`); Machine Settings leaves it out of the choices unless it is the
saved one, which says why. Naming the account explicitly is still the person's decision.

## Registration and Use

A v225 runner's `register` frame carries `providerProfileIds`: the profile id of every configured
account HOME, at most 32, including accounts the frame hides from a peer whose version it does not
know yet. Every `registered` frame to a v225 runner carries `providerProfileGrants`: the complete
set of this control plane's grants, in the runner's scope, for the profiles this runner reports
(`{ profileId?, grantId, status }`). That is every active grant for a profile id in
`providerProfileIds` or on the runner's accounts, and every pending grant recorded for one of the
runner's accounts: at most one active grant per profile and one pending grant per account, so at
most 64. The list is never truncated. When the runner's scope, accounts or reported profile ids are
unknown, or the relevant grants exceed 64, the field is omitted. The runner:

- uses a profile only when this list (or its own just-completed adoption) holds a grant for it and the
  marker lists this control-plane instance;
- removes from each configured HOME's marker any grant of this instance that the list no longer
  contains, under the HOME's lease, but only for a marker whose profile id was in the
  `providerProfileIds` snapshot of the register frame this `registered` answers (a reconnect sends a
  new frame and replaces the snapshot). A profile that appeared after that frame, for example a
  marker-less shared HOME another runner adopted before the control plane answered, holds grants the
  control plane could not list, so it is left alone until the next registration;
- never treats an absent or malformed list as "revoke all"; it changes nothing.

An account's recorded `profileId` is the expected id of every acquisition of that HOME path, so a
substituted directory is refused as `profile_changed`. Discovery-time authentication probes,
subscription-usage probes and skill reconciliation skip accounts this control plane may not use,
so one refused HOME does not fail the whole pass.

Account reports to a v225 control plane carry `profile: { id, access }` where `access` is `granted`,
`pending` (this control plane's grant is recorded but not yet confirmed here) or `not_granted`.

## Sessions

A session's account binding is made once and is authoritative afterwards; a restart never re-reads
the configured account. Provider profiles add one field to it:

- A **new** binding (a session created with an account, an account switch target, or the account
  chosen in authentication recovery) records the profile id the runner has verified for the
  account's HOME as the session's `providerProfileId`: the account's configured `profileId`, or,
  when the configuration has none (a replacement runner's account pointing at a HOME another runner
  adopted), the HOME marker's identity when this control plane's access to it is `granted` or
  `pending`. A binding to an unadopted account, or to a HOME this control plane may not use, records
  none. Existing bindings are never backfilled, and the discovered id is not written back to the
  account's configuration.
- A binding made **before** the account was adopted keeps its recorded credential and conversation
  homes and gets no profile id. Its acquisitions still expect the id the configured account records
  for that HOME path, as above.
- An account handoff (manual switch, automatic switch, or the account chosen in authentication
  recovery) records the target's id as `pendingProviderProfileId` with the rest of the pending
  binding, so a handoff that resumes after a runner restart still knows it. A follow-up selected
  mid-handoff keeps its own. A fork's temporary provider uses the source session's binding.
- When the handoff runs (resuming a stopped session, or replacing an active session's provider),
  the runner re-resolves the target account, and the saved `pendingProviderProfileId` is
  authoritative. A target that now reports a different profile id (its configured id, or a usable
  marker identity) refuses the switch: nothing is bound, the pending binding is cleared, and the
  refusal is reported like any other switch failure (the **Account Switch Failed** notice and a
  transcript error for an active session; the command's failure for a stopped one). A target that
  reports no id binds the saved one, so a replaced HOME is still refused at its lease. A handoff
  saved without an id binds whatever the target reports when it runs.

The session's recorded `providerProfileId` is the expected id of every acquisition of the session's
credential HOME: the driver launch, an Agent TUI, launch preparation and provider forks. It takes
precedence over the id the configured account records for the path, so a HOME substituted under a
renamed or re-pointed account, or a replacement directory without the marker, is refused for that
session as `profile_changed` before any provider starts. An acquisition of any other HOME is not
bound by it.

Session snapshots to a v225 control plane carry `providerProfileId`: the id, or `null` for a binding
without one. It is absent for older control planes and in the register frame's pre-negotiation
snapshots, and the control plane keeps the stored value when it is absent. The control plane stores
it in `sessions.provider_profile_id` and projects it as `SessionView.providerProfileId`.

Session creation refuses, before anything is sent to the runner, an account the runner would refuse
at its lease:

| Case | Refusal |
| --- | --- |
| The runner is below v225 and this control plane holds an active grant for the account | 409 "This machine needs a newer runner for provider profiles. Update and restart the runner." |
| The account reports a profile, this control plane's grant for it was revoked, and no live grant is left | 409 "Access to this provider profile was revoked for this control plane." |

Both read grants in the runner's scope only. An account without a profile, or one with a live grant,
is unaffected.

## Revocation

`POST /api/runners/:id/provider-accounts/:accountId/revoke-profile-access` with `{ "force"?: boolean }`.

Every account on this control plane's Machines that reports the same profile loses access, so their
active sessions count: without `force`, active sessions return 409
`PROVIDER_PROFILE_HAS_ACTIVE_SESSIONS`. The control plane writes `revoked_at` before telling any
runner, then sends `revoke_provider_profile_grant { requestId, profileId, grantId }` to each online
v225 runner that reports the profile. The runner stops using the grant at once and removes it from
the marker under the HOME's lease. An offline runner removes it at its next registration, and the
marker change also stops other runners on the same host. Other control planes' grants are never
touched.

Removing an account (`DELETE /api/runners/:id/provider-accounts/:accountId`) revokes only this
control plane's grants for it, before the runner is told. For each revoked grant the control plane
sends `revoke_provider_profile_grant` (a pending grant is named by the profile the account reports)
and only then `remove_provider_account`. The runner's removal handler also stops using this control
plane's grant and drops it from the marker before it attempts the removal, so the revocation holds
even when the runner refuses the removal (an agent default names the account, a sign-in is running,
or the configuration cannot be written).

Physical HOME cleanup is disabled pending proved retirement authority (#3157). Removal forgets the
configured account and reports `credentialsRetained: true`, including for unshared managed HOMEs and
legacy `<dataDir>/provider-accounts/<accountId>` directories. It preserves credentials, scratch state
and canonical lease evidence. A matching managed path/profile, an unshared marker or a released
lease does not prove that a successor or dormant consumer cannot still depend on the HOME.

Grant retirement still takes the HOME's lease without the grant check and drops this control plane's
grants when the existing path, marker and local-use checks permit it. Its legacy boolean is not
deletion authority. A replacement runner can forget an account its predecessor created and settle
this control plane's grants, but it retains the HOME. Operator-configured and linked HOMEs remain
protected.

A managed profile HOME must still hold the identity its account recorded before grant retirement. If
`profiles/<profileId>` was replaced by another profile's HOME (or holds no readable marker), it is
not this account's HOME: the removal reports `credentialsRetained`, keeps the directory and leaves
its marker alone, so neither this control plane's grant in it nor any other control plane's is
dropped. The identity is checked when the removal handler reads the marker (only a
marker holding the recorded id loses this control plane's grant), under the HOME's lease during
retirement (`profile_retire` is sent the recorded id and keeps any other identity unchanged).
The account itself is still forgotten. Accounts at other paths are also forgotten without physical
HOME cleanup. See [Provider HOME Cleanup Status](provider-home-cleanup.md) for the current safety
boundary and the remaining retirement requirements.

## Mixed Versions

| Peer | Behavior |
| --- | --- |
| Runner below v225 | Every profile route returns 409 "This machine needs a newer runner for provider profiles. Update and restart the runner." Session creation with an account this control plane holds an active grant for returns the same sentence. The web hides the profile actions. Add Account records no grant, and the runner creates today's HOME. |
| Control plane below v225 | The runner never reports a profile-bearing account to it, and a HOME holding a marker is refused as `profile_unsupported_control_plane`. Marker-less homes behave as before. Session snapshots omit `providerProfileId`. Add Account sends no grant, so new accounts get today's HOME and no marker. |
| Revoked or never-granted control plane | The runner refuses the HOME as `profile_not_granted`. Session creation with a revoked account returns 409 "Access to this provider profile was revoked for this control plane." |

## Authorization and Audit

Both routes require a human Owner or Admin who can access the runner; they are not member-scoped, so
the central gate also confines them to the personal control-plane organization like other Machine
credential routes. Agent credentials are refused. Grant rows record `granted_by`/`granted_role` and
`revoked_by`/`revoked_role`, and both routes are recorded in the content-free mutation audit.

An Add Account grant is recorded by the sign-in route, which any person who can manage the Machine
may call; its row records that person and role with `origin = 'created'`. When the control plane
spends it automatically (a sign-in that settled without an account, or an account reported without
a profile), `revoked_by`/`revoked_role` repeat the grantor's.

## Known Limits

- Runners in different scopes of the same control plane that share one OS account and HOME share
  that control plane's single marker grant. A registration lists only its own scope's grants, so it
  would remove the other scope's grant from the marker. Use separate HOMEs per scope.
- A pending grant is listed only to the runner that recorded it. Another runner of the same control
  plane that shares the HOME before the grant is confirmed removes it from the marker at its
  registration; the adoption then has to be repeated.
- The snapshot rule protects only profiles a registration did not report. When another runner
  replaces this control plane's grant on a profile the registering runner did report, after the
  control plane built that runner's list and before the runner applied it, the new grant is removed
  from the marker; the adoption then has to be repeated.
- A grant activated on one runner reaches another online runner sharing the profile at its next
  registration.
- A managed profile's HOME is shared by every runner on the SSH account, by design. A runner of
  another control plane cannot use it without a grant, but grants do not stop a hostile process on
  the same OS account (see [Premise](#premise)).
- When the start reply of an Add Account sign-in is lost, the grant stays pending without an
  account and is never completed; the account shows **Grant Pending** until an Owner or Admin adopts
  it.
- A sign-in whose runner stopped before it settled leaves its pending grant bound to an account that
  never appears (the row is listed to that runner but grants nothing), and leaves its new HOME in the
  managed root, as an interrupted sign-in leaves its directory today.
