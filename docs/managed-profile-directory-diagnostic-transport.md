# Managed Profile Directory Diagnostic Transport

This is the #4437 backend transport contract for the separately assigned UI integration. It is
independent of unmerged creation work in #4456 and bootstrap work in #4444. It does not change
creation, repair, sign-in admission, credential handling, account persistence or readiness.

## Wire Contract

Protocol 362 adds optional `directoryDiagnostic?: ManagedProfileDirectoryDiagnostic` to
`ProviderLoginResultMessage`. The new module
`packages/protocol/src/managed-profile-directory-diagnostic.ts` exports the DTO,
`ManagedProfileDiagnosticComponent`, `ManagedProfileDiagnosticFailureReason`,
`normalizeManagedProfileDirectoryDiagnostic`, the fixed failure/uncertainty sentences and
`safeProviderLoginStartError` (an exact allowlist of existing business-validation sentences).
Older peers may omit or ignore the optional field. Its presence grants no authority.

The normalized DTO has only these properties:

| Property | Accepted Values |
| --- | --- |
| `code` | `managed_profile_directory` |
| `component` | `os_home`, `manager_root`, `profiles_root`, `profile_home` |
| `reason` | `symlink`, `not_directory`, `wrong_owner`, `group_or_other_write`, `unavailable`, `unsupported_layout`, `unsupported_acl`, `unsupported_platform`, `unsupported_helper`, `already_exists`, `identity_changed`, `may_have_changed` |
| `failureReason` | Optional only when `reason` is `may_have_changed`; any accepted failure reason except `may_have_changed` |

`already_exists`, `unsupported_platform` and `unsupported_helper` require `profile_home`, including
when used as an uncertainty's `failureReason`. Unknown variants and inconsistent combinations are
rejected, including `failureReason` on a non-uncertain observation. Success/repair variants are
never diagnostics. Paths, error messages, raw causes, credentials and arbitrary extra fields are
discarded. Accessors and inherited properties cannot supply the fixed fields.

## Current Producer Limits

Only a genuine `ManagedProfileDirectoryError` instance from the already-landed #4451 class emits
an observation. The current runner projector explicitly accepts only that class's three owned
components (`manager_root`, `profiles_root`, `profile_home`) and five reasons (`symlink`,
`not_directory`, `wrong_owner`, `group_or_other_write`, `unavailable`). It copies those fields
directly; it never invokes exception serialization, follows causes, recognizes lookalike objects
or infers diagnostics from message strings. Source `message`, `path`, `cause`, `failureReason`
and other fields are omitted.

The other schema variants are reserved compatibility vocabulary, exercised by pure wire tests.
This branch does not produce them or establish safe descriptor-relative creation, OS-home ACL
classification, no-write certainty, repair success or retry safety. Integrating a future producer
requires its own reviewed change after that producer lands. Existing pathname-based creation on
main remains unchanged.

## HTTP and UI Handoff

Authorized `POST /api/runners/:id/provider-logins` failures keep HTTP 409 and return:

```json
{
  "error": "Provider sign-in could not be started. Preserve any existing profile directories and ask the Machine operator for guidance.",
  "directoryDiagnostic": {
    "code": "managed_profile_directory",
    "component": "profiles_root",
    "reason": "group_or_other_write"
  }
}
```

The control plane validates the observation again at its trust boundary. A valid uncertain
observation instead receives the fixed sentence: “Managed profile directories may have changed.
Preserve them and ask the Machine operator for guidance. Do not retry automatically.” Only its
allowlisted optional `failureReason` survives.

Malformed, unknown or missing diagnostics receive the generic fixed guidance above and no DTO.
Exact existing business-validation sentences (label conflict, account limit, unavailable agent,
fixed launcher/plugin-inheritance guidance, managed-profile identity/path/platform refusals,
and other enumerated start errors) remain useful through a narrow explicit mapping. Unknown
runner text, appended text and raw filesystem messages never pass through. Receiving diagnostics
does not authorize login or repair and must never trigger automatic retry. The UI should validate
the DTO again, render fixed local component/reason copy and use generic guidance on omission or
rejection. It must not display peer error causes or synthesize an “already repaired” state.

Owner/admin authorization, 403/404/offline/capability behavior, request shape, profile-grant
dispatch/settlement and 201 success behavior are unchanged. This slice touches only the runner
start-result catch and control-plane start-409 projection, alongside the protocol and their tests.
Submit-code/cancel/import responses, web API/dialogs, readiness and persistence regions are out
of scope. #4437 stays open until the original criteria and actual UI delivery are complete.

## Verification

Focused protocol/property tests check closed values, component/reason consistency, uncertainty,
serialization and arbitrary extra-field removal. Runner tests distinguish genuine errors from
lookalikes/wrapped causes and omit source fields; control-plane tests cover old/malformed peers.
The real route integration sends secret-bearing stub runner responses through authorized HTTP
requests, checks exact sanitized 409 bodies and confirms an unauthorized request dispatches no
runner command. All fixtures are inert; no provider sign-in or real credential/permission change
is used.
