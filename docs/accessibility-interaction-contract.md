# Accessible Interaction Contract

The dashboard uses a small set of shared keyboard and ARIA contracts. New controls should extend
these contracts rather than inventing another popover or segmented-control behavior.

## Menus and mixed-content popovers

- A menu trigger exposes `aria-haspopup="menu"`, `aria-expanded`, and `aria-controls`.
- Opening by click or Arrow Down focuses the first enabled item; Arrow Up focuses the last.
- Arrow Up/Down, Home, End, and typeahead move focus among enabled menu items. Escape closes one
  layer and restores the trigger; Tab closes without stealing the browser's next focus target.
- Menu items use `menuitem`, `menuitemcheckbox`, or `menuitemradio`. A panel containing inputs or
  other form controls is a labelled dialog-style popover, never a menu.
- A dialog-style popover opens onto its first enabled control, except on a coarse pointer when that
  control is an `input`, `select`, or `textarea`: focus then lands on the panel itself (a
  `tabIndex={-1}` dialog), so opening it does not summon the software keyboard.
- Async actions restore focus only after their busy state clears so focus is not returned to a
  disabled trigger.

These behaviors live in `apps/web/src/components/interactions.ts`. Collection-owned menus use the
same keyboard helper because one hook instance cannot safely own every repeated sidebar row.

## Choice groups, tabs, and comboboxes

- Mutually exclusive button choices are a labelled `radiogroup` with `radio` children,
  `aria-checked`, one tab stop, and wrapping Arrow/Home/End behavior.
- Multi-select question answers are checkboxes in a labelled group.
- True tabs use `tablist`, `tab`, and `tabpanel` with explicit id relationships and roving focus.
- Search, command, and slash suggestions use the combobox/listbox pattern with
  `aria-activedescendant`. Enter never commits during IME composition. Escape dismisses the current
  suggestion set, while Shift+Tab remains normal reverse focus navigation.

## Focus zones

F6 and Shift+F6 move focus between the zones mounted on the current page, in the order rail, list,
page (`rail`, `list` and `main` in `apps/web/src/focus-zones.ts`). The shell marks every route's
page root `main`, so F6 reaches the page on every route. Master-detail pages (Sessions, Agent
Skills, Projects) mark their list pane `list` and their detail pane `main`; the innermost mounted
zone wins, and a page without a list cycles rail and page.

- F6 into the rail focuses the current destination (the Settings control while in Settings), and
  otherwise the first destination, never the brand link. Landing targets are tried one selector at
  a time, because a comma selector returns the first match in document order.
- A list or page zone lands on its root, a `tabIndex={-1}` container with no ring, so the next Tab
  continues inside it. The Sessions list keeps its grid, empty-state and board targets, and the
  Sessions reading pane lands on its transcript scroller.
- After F6 only, the entered zone shows a 2px `--focus` line on its top edge for 1.5s that then fades
  (no fade under reduced motion). A click, a digit, a route change or programmatic focus never shows
  it, and no pane is ever framed on focus: selection keeps its own treatment.

## Session-detail ownership

Ordinary session entry and expansion land on the transcript. Orchestrator role, worker requests,
async questions, reconnects and stored Agents-open state do not open Agents. Leaving the session
resets Agents visibility while preserving panel mode, width and session-scoped drafts. Deliberate
panel controls still open it. Attention links wait for the exact request in the named session
generation, then reveal and focus its dock card or selected worker request; they do not first open
an unrelated Agents overview while the session loads.

The Inbox grid retains its active-descendant selection and project-switching Tab shortcut. A row
carries no tabbable controls of its own: F2 opens the selected session with its highest-priority
pending request focused, and a parent row's thread chevron is a pointer target whose keyboard
equivalent is T on the grid (Shift+T for every thread, P to select a child's parent, and the Left
and Right arrows as the conventional secondary path). Global palette, help, navigation, and
focus-zone shortcuts remain available without invoking Inbox row actions.

While the Inbox grid owns focus, bare Arrow Up/Down select adjacent sessions and bare Home/End
select the first/last session. Modified variants remain available to the browser or another
registered shortcut. In the reading pane, End instead jumps to the latest preview event and
resumes following; the shortcut reference describes both contexts in one End entry.

`SessionDetailLoaded` remains the coordinator for the single send/fork busy gate, composer-draft
hydration and flush, view-generation fencing, fork leasing, timeline recovery, and the one shared
git-status reader. Presentation leaves are split at stable boundaries:

- `SessionHeader` owns header actions and the transcript-share dialog.
- `RequestCard` (in `components/requests/`) owns the presentation and request-scoped decision state
  of every request other than a question, on the request dock above the composer (`RequestDock`)
  and in the Requests and Agents panels. `SessionQuestionBanner` owns questions: the same card's
  head line (`RequestCardHead`) over one question per step (`QuestionStep`), on the request dock
  too (#2205), where the transcript keeps the question's place as an `AskMarker` whose Jump to
  Question focuses the card's heading, and the card's Show Where Asked moves focus to the marker's
  row. While focus is in the card, 1–9 pick the current question's rows, Enter
  moves on, Ctrl/Cmd+Enter submits from any step and D dismisses; a field being typed in keeps its
  keys, and Session Reading's shortcuts stand aside while focus is in the card, its heading included, except
  R, which still opens Answer Mode. In Composer Response the docked card is compact and its Answer
  opens Answer Mode (#2212); while it is open the composer's answer panel is the request's region, so
  Answer hands focus to its field and Jump to Question opens a panel shrunk by Show Context and
  focuses that field. `SessionApprovalRegion` keeps the one focus and live-announcement owner for both.
- `EventTimeline` and `RightPanel` remain their existing independently testable seams.

The detail coordinator subscribes only to its owning runner and box. The shared git-status result is
memoized so unrelated store updates and composer typing do not manufacture new consumer props.

## Verification boundary

Pure keyboard movement and rendered semantics are supplemented by Happy DOM coverage for initial
menu focus, disabled-item traversal, collection-owned menus, Escape restoration, React StrictMode,
and approval A-to-B/A-to-resolved focus handoff. The normal repository test and watch scripts include
both TypeScript and TSX suites. Repository typecheck, build, schema checks, full tests, and independent
review are required for each slice. This slice does not claim a new live-browser proof; the in-app
browser harness was already finalized earlier in the execution run.
