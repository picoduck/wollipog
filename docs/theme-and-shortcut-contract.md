# Theme and Shortcut Contract

Roadmap item 13.5 gives the dashboard a persisted light/dark/system appearance and one discoverable
source of truth for active keyboard shortcuts. Appearance is a client preference; it never changes
session, runner, or control-plane state.

## Theme lifecycle

1. `index.html` reads the bounded `wollipog.theme` value (`system`, `light`, or `dark`) and resolves
   the system media query before CSS and React paint. It also restores `wollipog.scheme` and
   `wollipog.density` in the same pre-paint bootstrap. The three legacy `mam.*` appearance keys are
   copied forward new-first during the rollback window. Invalid or inaccessible storage falls back
   to system mode, and an unavailable media query falls back to dark. This prevents a light-theme
   reload from flashing the default dark palette.
2. `ThemeProvider` owns the persisted preference and resolved palette after React starts. It updates
   the root `data-theme`, CSS `color-scheme`, and browser/PWA `theme-color` together. In system mode,
   a live `prefers-color-scheme` change updates the mounted app without a reload.
3. CSS components consume semantic palette variables. The light palette overrides surfaces,
   borders, text, semantic colors, shadows, syntax tokens, modal overlay, and terminal background;
   the dark palette remains the default for old/static clients.
4. `ShellTerminal` receives the resolved palette and mutates the existing xterm theme in place.
   Theme changes do not recreate a shell, replay scrollback, discard selection, or alter PTY input.
5. The isolated public transcript is wrapped by the same provider, so system changes and installed
   browser chrome stay consistent even when the authenticated dashboard is not mounted.

## Shortcut registry

`apps/web/src/shortcuts.ts` is authoritative for every application command chord shown by the UI.
App handlers, topbar tooltips, the right-panel launcher, terminal dock, and shortcut reference
derive their matching or display copy from the registry. Platform formatting uses Command glyphs
on Apple platforms and `Ctrl`/`Alt` labels elsewhere without changing the underlying binding.

The reference opens from Settings or `?`. The punctuation binding is ignored while focus is in an
input, textarea, select, editable region, or xterm, and it will not open over another modal. The
reference uses the shared modal focus trap and Escape behavior, then restores focus to its invoking
control when closed. Session-scoped bindings only act while a session is selected, and `Ctrl/Cmd+K`
continues to preserve xterm's native control sequence.

## Verification contract

- Pure tests cover preference parsing/resolution, DOM/meta application, terminal palettes, unique
  registry ids, exact modifier matching, and platform labels.
- Happy DOM mounts the provider and proves explicit persistence plus live system-mode changes.
- Web typecheck and production build verify the settings, dialog, dock, and terminal integration.
- The complete repository suite, monorepo checks, independent audits, immutable-head Claude review,
  platform CI, exact merge identity, and post-merge health remain required before this slice may be
  recorded as merged. The pre-review baseline is 1,596 total tests (1,593 passed, 3 platform skips),
  all 16 Codex schemas, and no actionable P0-P2 independent-audit findings.
