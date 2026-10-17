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
| `pending` | An Owner or Admin authorized the grant; the runner has not confirmed the profile id it wrote. One per runner account. |
| `active` | The runner recorded the grant in the marker and reported the profile id. One per profile and control-plane instance. |
| `revoked` | Revoked by an Owner or Admin, by account removal, by a coded runner refusal, or superseded by a newer grant of the same control plane to the same profile. |

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
profile id (see [Sessions](#sessions)). Automatic grants for accounts created through Add Account and
managed profile paths are a later part of #3239.

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

Whether the HOME is kept is decided at deletion time, under the HOME's lease: the runner takes the
lease without the grant check, drops every grant of this control plane from the marker, and keeps
the HOME when the marker still grants another control plane (or cannot be read), so a grant another
runner recorded while the removal waited is never deleted with the directory. The runner re-reads
the marker once more immediately before deleting, after the lease is released, because the lease
journal lives inside the HOME. When no other control plane is granted, the existing deletion rules
apply unchanged: a runner-created HOME is deleted only when nothing on the Machine still uses it.

## Mixed Versions

| Peer | Behavior |
| --- | --- |
| Runner below v225 | Every profile route returns 409 "This machine needs a newer runner for provider profiles. Update and restart the runner." Session creation with an account this control plane holds an active grant for returns the same sentence. The web hides the profile actions. |
| Control plane below v225 | The runner never reports a profile-bearing account to it, and a HOME holding a marker is refused as `profile_unsupported_control_plane`. Marker-less homes behave as before. Session snapshots omit `providerProfileId`. |
| Revoked or never-granted control plane | The runner refuses the HOME as `profile_not_granted`. Session creation with a revoked account returns 409 "Access to this provider profile was revoked for this control plane." |

## Authorization and Audit

Both routes require a human Owner or Admin who can access the runner; they are not member-scoped, so
the central gate also confines them to the personal control-plane organization like other Machine
credential routes. Agent credentials are refused. Grant rows record `granted_by`/`granted_role` and
`revoked_by`/`revoked_role`, and both routes are recorded in the content-free mutation audit.

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
