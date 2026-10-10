import { useState } from "react";
import type { GitDiffScope } from "@wollipog/protocol";
import type { DiffLayout, DiffPane } from "./GitDiffViewer.js";
import { TuningIcon } from "./Icons.js";
import { useAccessibleMenu } from "./interactions.js";
import { MenuItem, MenuLabel, MenuSurface } from "./Menu.js";
import { SegmentedControl } from "./ui/ChoiceControls.js";

const PANE_OPTIONS: readonly { value: DiffPane; label: string }[] = [
  { value: "combined", label: "All Changes" },
  { value: "unstaged", label: "Unstaged Only" },
  { value: "staged", label: "Staged Only" },
];

const LAYOUT_OPTIONS: readonly { value: DiffLayout; label: string }[] = [
  { value: "unified", label: "Unified" },
  { value: "split", label: "Side by Side" },
];

/**
 * Review's one toolbar row (#2846; docs/design-system.md §4.7): the Scope segmented control (§10.2)
 * and the View Options menu button (§9.1), which holds every choice about how the same diff is
 * shown. It sits in the panel's fixed `.rpanel-toolbar` slot, above the scroller.
 *
 * The viewer gate (#1870) is rendered under the row as the toolbar's disabled reason: the Git
 * actions further down point at it with `aria-describedby`.
 */
export function ReviewToolbar({
  scope,
  onScopeChange,
  branchScopes,
  unavailableReason,
  pane,
  onPaneChange,
  layout,
  onLayoutChange,
  refusal,
}: {
  scope: GitDiffScope;
  onScopeChange: (scope: GitDiffScope) => void;
  /** Branch and Last Turn exist only for a worktree session. */
  branchScopes: boolean;
  /** Why no scope can load (an older runner), or null. */
  unavailableReason: string | null;
  /** The Show choice, offered only while the Uncommitted diff has staged and unstaged panes. */
  pane: DiffPane | null;
  onPaneChange: (pane: DiffPane) => void;
  layout: DiffLayout;
  onLayoutChange: (layout: DiffLayout) => void;
  refusal: { reason: string; id: string } | null;
}) {
  const disabled = unavailableReason !== null;
  return (
    <>
      <div className="toolbar review-toolbar">
        <SegmentedControl<GitDiffScope>
          className="sm"
          label="Scope"
          value={scope}
          options={[
            { value: "uncommitted", label: "Uncommitted", disabled, disabledReason: unavailableReason ?? undefined },
            ...(branchScopes ? [
              { value: "all_branch" as const, label: "Branch", disabled, disabledReason: unavailableReason ?? undefined },
              { value: "last_turn" as const, label: "Last Turn", disabled, disabledReason: unavailableReason ?? undefined },
            ] : []),
          ]}
          onChange={onScopeChange}
        />
        <ViewOptionsMenu pane={pane} onPaneChange={onPaneChange} layout={layout} onLayoutChange={onLayoutChange} />
      </div>
      {refusal && <p id={refusal.id} className="review-toolbar-reason">{refusal.reason}</p>}
    </>
  );
}

/** Show and Layout as `menuitemradio` groups with trailing checks (§9.1). */
function ViewOptionsMenu({ pane, onPaneChange, layout, onLayoutChange }: {
  pane: DiffPane | null;
  onPaneChange: (pane: DiffPane) => void;
  layout: DiffLayout;
  onLayoutChange: (layout: DiffLayout) => void;
}) {
  const [open, setOpen] = useState(false);
  const menu = useAccessibleMenu(open, setOpen, "review-view-options");
  const choose = (apply: () => void) => {
    menu.close(true);
    apply();
  };
  return (
    <>
      <button
        ref={menu.triggerRef}
        type="button"
        className="icon-btn sm review-view-options"
        aria-label="View Options"
        title="View Options"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menu.menuId : undefined}
        onClick={menu.toggle}
        onKeyDown={menu.onTriggerKeyDown}
      >
        <TuningIcon size={16} aria-hidden="true" />
      </button>
      {open && (
        <MenuSurface
          surfaceRef={menu.menuRef}
          anchor={{ trigger: menu.triggerRef }}
          id={menu.menuId}
          label="View Options"
          align="end"
          onDismiss={() => menu.close(true)}
          onKeyDown={menu.onMenuKeyDown}
        >
          {pane !== null && (
            <div role="group" aria-label="Show">
              <MenuLabel>Show</MenuLabel>
              {PANE_OPTIONS.map((option) => (
                <MenuItem
                  key={option.value}
                  role="menuitemradio"
                  checked={pane === option.value}
                  data-menu-label={option.label}
                  onClick={() => choose(() => onPaneChange(option.value))}
                >
                  {option.label}
                </MenuItem>
              ))}
            </div>
          )}
          <div role="group" aria-label="Layout">
            <MenuLabel>Layout</MenuLabel>
            {LAYOUT_OPTIONS.map((option) => (
              <MenuItem
                key={option.value}
                role="menuitemradio"
                checked={layout === option.value}
                data-menu-label={option.label}
                onClick={() => choose(() => onLayoutChange(option.value))}
              >
                {option.label}
              </MenuItem>
            ))}
          </div>
        </MenuSurface>
      )}
    </>
  );
}
