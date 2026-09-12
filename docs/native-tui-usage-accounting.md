# Native TUI Usage Accounting Boundary

Wollipog must not attribute Native TUI usage or enforce a budget until the provider exposes every
part of an authoritative session contract:

1. a structured usage event stream for the interactive TUI;
2. an exact provider-conversation binding established before the first turn;
3. stable event identities;
4. a durable replay watermark; and
5. explicit gap detection.

Missing any one requirement makes accounting unavailable. Terminal text, debug logs, provider
history files, process ancestry, working directories, and guessed conversation IDs are not
accounting inputs. This intentionally keeps Native TUI usage out of session totals, parent rollups,
cost checkpoints, and daily-budget mutation.

## Verified Provider Contracts

The boundary was verified on 2026-09-08 against the exact locally supported CLIs.

### Claude Code 2.1.261

`claude --help` exposes `--session-id`, so a caller can choose a conversation identifier before the
first turn. Its structured `stream-json` input/output and hook events are restricted to `--print`,
however, and are not an event channel for the interactive Native TUI. The interactive contract has
no stable accounting event identity, replay watermark, or gap marker. It therefore remains
unavailable.

### Codex CLI 0.153.4

`codex app-server generate-json-schema --experimental` exposes
`thread/tokenUsage/updated`, containing `threadId`, `turnId`, and cumulative/last token usage. That
notification belongs to the separate App Server surface. The schema has no accounting event ID,
event sequence, replay watermark, or gap marker, and the `codex --remote` Native TUI launch does not
accept a caller-selected thread binding before its first turn. Pagination cursors for list methods
are not notification replay or gap detection. It therefore remains unavailable.

## In-Repository Enforcement

Runner discovery publishes an optional, fixed-enum, content-free `nativeTuiAccounting` diagnostic.
Only live discovery may set it; configured or persisted claims are removed during agent merging.
Protocol v121 lets clients distinguish this diagnostic from an older runner that omitted it. The
diagnostic cannot enable accounting: its only current status is `unavailable`, and all existing
Native TUI cost-budget, cost-checkpoint, tool-limit, and daily-budget rejections remain in force.

When a provider adds the missing contracts, support still requires a separate implementation that
authenticates the pre-turn binding, persists idempotent events and watermarks, detects gaps, and
reconciles cumulative totals before any budget or parent usage can change.

