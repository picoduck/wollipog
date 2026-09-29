# Confirmation, Undo, and Runner Onboarding Contract

This contract defines the safety and presentation boundary for roadmap slice 13.6. It applies to
dashboard confirmations, transient feedback, reversible session archiving, and the Add a Runner
health checklist.

## Confirmation safety

- Product code uses the shared asynchronous confirmation service, never `window.confirm`. Requests
  are serialized so two actions cannot create stacked or competing dialogs. Identical pending
  confirmation fingerprints fail closed, so a same-frame double activation cannot queue or execute
  one destructive action twice.
- Cancel is the initial focus target. Escape, backdrop dismissal and the phone sheet's Back resolve
  `false`; the explicit action alone resolves `true`. Focus returns to the connected invoking control.
- **Exception: type-to-confirm dialogs focus the name field.** A dialog that makes the user type the
  affected resource's name (Delete Project) opens with focus in that field, not on Cancel. The user
  must type before anything else can happen, and the confirm button stays disabled until the name
  matches, so focus there cannot confirm by accident (docs/design-system.md §7.4).
- A confirmation's title is the action in Title Case with no question mark ("Stop Session"), its
  body says what happens to which named resource and whether it can be undone, and its required
  confirm label repeats the title's verb. There is no generic "Continue" default. Destructive
  confirmations show the warning icon and the solid danger button and have no close button.
- Destructive copy names the affected resource and consequence. Security credentials, deletion,
  runner removal, file discard, rewind, pod close, sign-out, and third-party Registry execution
  remain confirmation-gated and are never described as reversible.
- Any action whose safety predicate can change while its modal is open rechecks a live predicate
  after the await; pod close, for example, cannot cross a newly-started reconciliation.
- A missing provider fails closed: confirmation resolves `false`. Provider teardown resolves every
  active or queued request `false` and clears feedback timers.
- **A desktop update held for running work is one confirmation.** Installing an update restarts
  Wollipog, which stops agent turns, so the shell holds an unconfirmed install while work is in flight
  and answers with the working sessions' ids. The update toast and Settings › About then open the same
  dialog through one helper (`confirmHeldUpdate`): the danger-toned title "Restart to Install
  Update", a body naming the version and how many sessions stop (or, with no count, that any turn in
  progress stops), the sessions the loaded local instance can name as detail rows with the rest
  counted, and Install Later (the cancel and initial focus) beside Restart Anyway. Restart Anyway
  sends the one confirmed install with the dialog open and the button busy; it cannot be withdrawn
  once sent, a failure stays in the dialog, and a shell that holds the confirmed install again is
  asked about again with its new answer. Install Later, Escape and the scrim send nothing, and
  Settings › About keeps offering Install and Restart. There is no held-update toast, notice or
  banner.

## Toast and undo lifecycle

- Toasts use a polite live region, remain keyboard actionable, and can be dismissed explicitly with
  an icon button named "Dismiss Notification". Errors use alert semantics. Each toast carries a
  tone icon (info, success, warning, error), so its tone never depends on colour alone
  (docs/design-system.md §13.1).
- At most three toasts are visible on desktop and one on a phone, newest on top. Older toasts
  collapse into a "+N More" control whose list opens upward; nothing is evicted, so a persistent
  recovery action stays reachable until it is dismissed or completed, and no repair path is lost.
- Info and success toasts dismiss themselves after five seconds (ten when they carry an action such
  as Undo); hovering or focusing the stack pauses every timer. Warnings and errors persist until
  dismissed.
- Toasts sit at the bottom and never cover the app bar: bottom right on desktop, bottom centre with
  8px insets on a phone. They sit above whatever is docked at the bottom of the view — the phone tab
  bar, a session's composer, a sheet's footer — and above the software keyboard.
- Undo is offered only when the product has a reliable inverse operation. In this slice that means
  single-session archive/unarchive and a successfully completed bulk archive.
- Bulk undo captures the exact session ids and prior project-pin state. It restores only those ids
  and restores a pin removed by the original operation without toggling unrelated current state.
- An undo action is synchronously fenced and disabled while running, so even a same-frame double
  click cannot execute it twice. Success dismisses the toast;
  failure stays visible with the concrete error instead of claiming the original action was undone.
- Permanent deletion, credential rotation/revocation, approvals, transcript-share revocation,
  rewinds, discards, and pod/runner removal never expose a cosmetic or best-effort Undo.

## Live runner health checklist

The Add a Runner dialog derives health from the existing store snapshot; it does not invent backend
state or probe credentials from the browser.

1. **Control plane** passes only after onboarding metadata loads.
2. **Runner credential** passes only after the control plane generates the one-time credential bound
   to the exact chosen runner id. The reusable config remains token-free; the plaintext is shown
   once and must be saved separately in `.agent-manager/runner.token` with runner-account-only access.
3. **Runner connection** matches the exact configured runner id and distinguishes waiting, live, and
   offline states. Its recovery command is the same command shown in the setup steps.
4. **Workspace** matches the exact configured workspace id. Offline advertisements are explicitly
   last-known, not current readiness.
5. **Agent readiness** remains pending until live discovery verifies an agent. Known unavailable,
   unauthenticated, or unsupported agents fail with a copyable provider-specific recovery command.
   Offline capability data is labeled last-known.

The checklist updates from the normal WebSocket-backed runner map while the dialog remains open.
Raw protocol driver ids stay internal; setup config, runner cards, external-session status, session
labels, and capability descriptions use the shared Claude Code native, Codex interactive, Codex
batch compatibility, or ACP adapter presentation language.

## Verification boundary

Focused tests must cover queued confirmation behavior, Cancel/Escape/focus restoration, successful
and failed Undo, strict cleanup, config generation, runner waiting/online/offline states, workspace
matching, agent verification, friendly driver labels, and recovery commands. Full repository tests,
monorepo typecheck/build, schema verification, diff hygiene, independent audits, immutable-head
Claude review, CI, exact merge identity, and post-merge verification remain required before this
slice can be marked `MERGED`.
