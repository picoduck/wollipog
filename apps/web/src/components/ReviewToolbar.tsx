import { useState, type Ref, type RefObject } from "react";
import type { GitDiffScope } from "@wollipog/protocol";
import type { DiffLayout, DiffPane } from "./GitDiffViewer.js";
import { SelectLinesIcon, TuningIcon } from "./Icons.js";
import { useAccessibleMenu } from "./interactions.js";
import { MenuItem, MenuLabel, MenuSeparator, MenuSurface } from "./Menu.js";
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

/** Collapse All Files and Expand All Files: offered while the diff has files (#2848). */
export interface ReviewFileCollapse {
  /** Every file is collapsed, so the sections are the file index. */
  collapsed: boolean;
  onCollapseAll: (collapse: boolean) => void;
}

/**
 * The Select Lines toggle (#2849): offered while the diff has lines to select. An icon button in the
 * row where the panel holds it, else a View Options item.
 */
export interface ReviewSelectLines {
  on: boolean;
  onChange: (on: boolean) => void;
  placement: "toolbar" | "menu";
  /** The icon button, while it is in the row. */
  buttonRef?: RefObject<HTMLButtonElement | null>;
}

/** Points both refs at the same button. */
function bothRefs(first: RefObject<HTMLButtonElement | null>, second?: Ref<HTMLButtonElement>) {
  return (element: HTMLButtonElement | null) => {
    first.current = element;
    if (typeof second === "function") second(element);
    else if (second) second.current = element;
  };
}

/**
 * Review's one toolbar row (#2846; docs/design-system.md §4.7): the Scope segmented control (§10.2)
 * then Select Lines (#2849) and the View Options menu button (§9.1), which holds every choice about
 * how the same diff is shown. It sits in the panel's fixed `.rpanel-toolbar` slot, above the scroller.
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
  splitUnavailableReason = null,
  wrap = false,
  onWrapChange,
  files = null,
  selectLines = null,
  viewOptionsRef,
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
  /** Why Side by Side cannot be shown now (the panel is too narrow), or null (#2848). */
  splitUnavailableReason?: string | null;
  wrap?: boolean;
  onWrapChange?: (wrap: boolean) => void;
  files?: ReviewFileCollapse | null;
  selectLines?: ReviewSelectLines | null;
  /** The View Options button, which the host focuses when nothing nearer is left (#2849). */
  viewOptionsRef?: Ref<HTMLButtonElement>;
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
        {selectLines?.placement === "toolbar" && (
          <button
            ref={selectLines.buttonRef}
            type="button"
            className="icon-btn sm review-select-lines"
            aria-label="Select Lines"
            title="Select Lines"
            aria-pressed={selectLines.on}
            onClick={() => selectLines.onChange(!selectLines.on)}
          >
            <SelectLinesIcon size={16} aria-hidden="true" />
          </button>
        )}
        <ViewOptionsMenu
          pane={pane}
          onPaneChange={onPaneChange}
          layout={layout}
          onLayoutChange={onLayoutChange}
          splitUnavailableReason={splitUnavailableReason}
          wrap={wrap}
          onWrapChange={onWrapChange}
          files={files}
          selectLines={selectLines?.placement === "menu" ? selectLines : null}
          buttonRef={viewOptionsRef}
        />
      </div>
      {refusal && <p id={refusal.id} className="review-toolbar-reason">{refusal.reason}</p>}
    </>
  );
}

/**
 * Show and Layout as `menuitemradio` groups with trailing checks (§9.1), then Wrap Long Lines as a
 * checkbox item, Select Lines in a panel too narrow for its toolbar button (#2849), and Collapse All
 * Files or Expand All Files (#2848). Side by Side stays listed while
 * the panel is too narrow for it, unavailable with its reason, and Unified is checked: it is what
 * renders. The stored choice is kept, so widening the panel brings Side by Side back.
 */
function ViewOptionsMenu({ pane, onPaneChange, layout, onLayoutChange, splitUnavailableReason, wrap, onWrapChange, files, selectLines, buttonRef }: {
  pane: DiffPane | null;
  onPaneChange: (pane: DiffPane) => void;
  layout: DiffLayout;
  onLayoutChange: (layout: DiffLayout) => void;
  splitUnavailableReason: string | null;
  wrap: boolean;
  onWrapChange?: (wrap: boolean) => void;
  files: ReviewFileCollapse | null;
  selectLines: ReviewSelectLines | null;
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  const [open, setOpen] = useState(false);
  // An unavailable option is aria-disabled and still reached by the arrow keys, so its reason is heard.
  const menu = useAccessibleMenu(open, setOpen, "review-view-options", "item", { reachUnavailable: true });
  const choose = (apply: () => void) => {
    menu.close(true);
    apply();
  };
  const shownLayout: DiffLayout = splitUnavailableReason ? "unified" : layout;
  return (
    <>
      <button
        ref={bothRefs(menu.triggerRef, buttonRef)}
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
            {LAYOUT_OPTIONS.map((option) => {
              const unavailable = option.value === "split" ? splitUnavailableReason : null;
              return (
                <MenuItem
                  key={option.value}
                  role="menuitemradio"
                  checked={shownLayout === option.value}
                  data-menu-label={option.label}
                  aria-disabled={unavailable ? true : undefined}
                  description={unavailable ?? undefined}
                  onClick={() => { if (!unavailable) choose(() => onLayoutChange(option.value)); }}
                >
                  {option.label}
                </MenuItem>
              );
            })}
          </div>
          {(onWrapChange || files || selectLines) && <MenuSeparator />}
          {onWrapChange && (
            <MenuItem
              role="menuitemcheckbox"
              checked={wrap}
              data-menu-label="Wrap Long Lines"
              onClick={() => choose(() => onWrapChange(!wrap))}
            >
              Wrap Long Lines
            </MenuItem>
          )}
          {selectLines && (
            <MenuItem
              role="menuitemcheckbox"
              checked={selectLines.on}
              data-menu-label="Select Lines"
              onClick={() => choose(() => selectLines.onChange(!selectLines.on))}
            >
              Select Lines
            </MenuItem>
          )}
          {files && (
            <MenuItem
              data-menu-label={files.collapsed ? "Expand All Files" : "Collapse All Files"}
              onClick={() => choose(() => files.onCollapseAll(!files.collapsed))}
            >
              {files.collapsed ? "Expand All Files" : "Collapse All Files"}
            </MenuItem>
          )}
        </MenuSurface>
      )}
    </>
  );
}
