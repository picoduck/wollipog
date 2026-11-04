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

No contextual binding may shadow a global one. Two bindings that can be live together (a global
binding and any scope's, two in one scope, or Session with Session Reading and Sessions with the
Sessions List) never show the same keys on either platform, and a registry test enforces it. Session
Reading's Previous and Next Session are therefore `Alt+↑` and `Alt+↓` (`⌥↑` and `⌥↓` on Apple
platforms), which leaves `Ctrl/Cmd+K` to Search while someone is reading a session.

### Side panel chords

On a session page `Ctrl/Cmd+\` toggles the side panel and reopens it on its last tool, and every tool
except the Session Tools list has one chord of its own (#1260). The tool switcher's items and the
Session Tools rows show each one as a keycap on fine pointers, and the reference lists them all in
its Session group.

| Tool | Chord |
| --- | --- |
| Review | `Ctrl/Cmd+Shift+G` |
| Files (Go to File) | `Ctrl/Cmd+P` |
| Browser | `Ctrl/Cmd+Shift+X` |
| Terminal | ``Ctrl/Cmd+` `` |
| Agents | `Ctrl/Cmd+Shift+M` |
| Side Chat | `Ctrl/Cmd+;` |
| Background Work | `Ctrl/Cmd+Shift+Y` |
| Campaign Status | `Ctrl/Cmd+Shift+K` |
| Requests | `Ctrl/Cmd+'` |
| Decision History | `Ctrl/Cmd+Shift+H` |

Go to File and Side Chat only ever open their tool and put focus in its field. Terminal follows its
placement. Every other chord opens the panel on its tool, or closes the panel already showing it.
The toggle and these chords put focus on the tool switcher when they open or switch the panel, so
Escape closes it again. Escape closes the panel from any tool while focus is inside it, once no
dialog, menu, popover or tool layer takes the press first. A terminal keeps Escape for its shell.

Nearly every `Ctrl/Cmd+Shift` letter is already a browser chord, and `Ctrl+Shift+U` and
`Ctrl+Shift+F` belong to Linux and Windows input methods. `Ctrl/Cmd+Alt` is AltGr on Windows
layouts. The letters above therefore shadow, only inside the app, minor chords a page may override:
Firefox's text direction (X), responsive design mode (M), Linux downloads (Y), web console (K) and
history library (H); Edge's Collections (Y) and duplicate tab (K); and the Home page on Apple
platforms (`Cmd+Shift+H`). `Ctrl/Cmd+'` collides with nothing. The registry test keeps every panel
chord off its browser and input-method lists. Bindings are not user-configurable; only the rail's
digits follow its order.

## Verification contract

- Pure tests cover preference parsing/resolution, DOM/meta application, terminal palettes, unique
  registry ids, exact modifier matching, and platform labels.
- Happy DOM mounts the provider and proves explicit persistence plus live system-mode changes.
- Web typecheck and production build verify the settings, dialog, dock, and terminal integration.
- The complete repository suite, monorepo checks, independent audits, immutable-head Claude review,
  platform CI, exact merge identity, and post-merge health remain required before this slice may be
  recorded as merged. The pre-review baseline is 1,596 total tests (1,593 passed, 3 platform skips),
  all 16 Codex schemas, and no actionable P0-P2 independent-audit findings.
