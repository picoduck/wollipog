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

## Remaining Work in #4353

This is the first slice of the approved progressive-disclosure design. Priority ordering and
reset-aware automatic balancing are not enabled or presented as working controls in this slice.
They require versioned selection policies, consistent launch resolution and retry semantics,
verified billing classification, memory/context compatibility rules, and migration for older
clients/runners. Automatic balancing additionally needs fresh usage for idle accounts and a
selection rule validated across multiple windows and unequal plans. Neither mode should spend API
credits implicitly. Projects with account-specific memory need an explicit account rather than
silently switching memory between launches.
