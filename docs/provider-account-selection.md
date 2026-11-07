# Provider Account Selection

Provider Accounts on each machine groups accounts by provider. A short sentence describes the
saved default, and **Change…** opens the editor for that provider. The default applies to new
sessions in the execution contexts already supported by the machine-default API. Choosing an
account explicitly for a session still overrides it. Editing a default does not move existing
sessions.

**No Saved Default** preserves each agent's configured account and the existing implicit fallback.
A missing saved account remains visible until the person replaces or clears it. Owner/admin
permissions, profile grants, account-email masking, and conditional writes retain their existing
boundaries. A conflicting save keeps the draft and offers **Reload Saved Choice** rather than
overwriting another editor.

Usage in the overview is informational. It comes from the existing permission-scoped cached usage
endpoint, matched by machine, provider, and account. Expand **Usage Details** to see the reported
windows and their reset times. Stale readings are marked **Last Known**; an unavailable reading
does not imply zero allowance or prevent account management. No credential probe runs when this
section opens.

**Running Sessions** is independent of the provider defaults. Its **Change…** editor controls the
existing machine-wide usage-limit handoff. Enabling it retains the provider-terms confirmation;
the existing handoff validation and cooldown rules are unchanged.

## Remaining Work in #4353

This is the first slice of the approved progressive-disclosure design. Priority ordering and
reset-aware automatic balancing are not enabled or presented as working controls in this slice.
They require versioned selection policies, consistent launch resolution and retry semantics,
verified billing classification, memory/context compatibility rules, and migration for older
clients/runners. Automatic balancing additionally needs fresh usage for idle accounts and a
selection rule validated across multiple windows and unequal plans. Neither mode should spend API
credits implicitly. Projects with account-specific memory need an explicit account rather than
silently switching memory between launches.
