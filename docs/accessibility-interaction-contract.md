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

## Session-detail ownership

`SessionDetailLoaded` remains the coordinator for the single send/fork busy gate, composer-draft
hydration and flush, view-generation fencing, fork leasing, timeline recovery, and the one shared
git-status reader. Presentation leaves are split at stable boundaries:

- `SessionHeader` owns header actions and the transcript-share dialog.
- `SessionApprovalBanner` and `SessionQuestionBanner` own approval/question presentation and
  request-scoped response state.
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
