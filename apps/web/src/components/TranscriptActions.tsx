import React, { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { writeClipboardText } from "../clipboard.js";
import { useFeedback } from "./FeedbackProvider.js";
import { MoreHorizontalIcon } from "./Icons.js";
import { useAccessibleMenu } from "./interactions.js";
import { MenuItem, MenuLabel, MenuSurface } from "./Menu.js";

/**
 * One message or turn action (docs/design-system.md §9.1). An action that cannot be used now stays
 * listed, disabled, with its reason as the item's visible second line; nothing is hidden because it
 * is unavailable.
 */
export interface TranscriptAction {
  key: string;
  /** Title Case, with a trailing ellipsis when it opens a dialog first (§17.2). */
  label: string;
  icon: ReactNode;
  /** Why the action cannot be used now. */
  unavailableReason?: string;
  /** Copies this text, then confirms with a toast. */
  copy?: { text: string; format?: (text: string) => string; copied: string; failed: string };
  onSelect?: () => void;
}

export interface TranscriptActionGroup {
  label: string;
  actions: readonly TranscriptAction[];
}

export const transcriptActionAvailable = (action: TranscriptAction): boolean =>
  action.unavailableReason === undefined && (action.copy !== undefined || action.onSelect !== undefined);

/**
 * A `⋯` icon button that opens the shared menu (a bottom sheet on phones) with its groups in order,
 * each under a Title Case section label. `onOpenChange` lets the cluster around it stay shown while
 * its menu is open.
 */
export function TranscriptActionMenu({ label, groups, onOpenChange }: {
  label: string;
  groups: readonly TranscriptActionGroup[];
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const menu = useAccessibleMenu(open, setOpen, "transcript-actions");
  const { showToast } = useFeedback();
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  useEffect(() => { onOpenChange?.(open); }, [onOpenChange, open]);
  const visibleGroups = groups.filter((group) => group.actions.length > 0);
  if (visibleGroups.length === 0) return null;

  const copy = async ({ text, format, copied, failed }: NonNullable<TranscriptAction["copy"]>) => {
    // The menu closes now, not when the write settles, so a slow clipboard never closes a menu opened
    // since. A refusal falls back only while focus is still where the copy left it.
    const trigger = menu.triggerRef.current;
    trigger?.focus();
    menu.close(false);
    const value = format ? format(text) : text;
    const current = () => mountedRef.current && (document.activeElement === null ||
      document.activeElement === document.body || document.activeElement === trigger);
    const result = await writeClipboardText(value, current);
    if (result === null) return;
    // The fallback's selection dropped focus; hand it back to the trigger.
    if (document.activeElement === document.body || document.activeElement === null) trigger?.focus();
    if (result) showToast(copied, { tone: "success" });
    else showToast(failed, { tone: "error" });
  };

  const select = (action: TranscriptAction) => {
    if (!transcriptActionAvailable(action)) return;
    if (action.copy) {
      void copy(action.copy);
      return;
    }
    // Focus the trigger before the action runs, so a dialog it opens returns focus there.
    menu.triggerRef.current?.focus();
    menu.close(false);
    action.onSelect?.();
  };

  return (
    <>
      <button
        ref={menu.triggerRef}
        type="button"
        className="icon-btn sm tl-more-actions"
        onClick={menu.toggle}
        onKeyDown={menu.onTriggerKeyDown}
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menu.menuId : undefined}
      >
        <MoreHorizontalIcon size={16} />
      </button>
      {open && (
        <MenuSurface
          surfaceRef={menu.menuRef}
          anchor={{ trigger: menu.triggerRef }}
          id={menu.menuId}
          label={label}
          align="end"
          tabIndex={-1}
          onDismiss={() => menu.close(true)}
          onKeyDown={menu.onMenuKeyDown}
        >
          {visibleGroups.map((group) => (
            <Fragment key={group.label}>
              <MenuLabel>{group.label}</MenuLabel>
              {group.actions.map((action) => (
                <MenuItem
                  key={action.key}
                  icon={action.icon}
                  data-menu-label={action.label}
                  disabled={!transcriptActionAvailable(action)}
                  description={action.unavailableReason}
                  onClick={() => select(action)}
                >
                  {action.label}
                </MenuItem>
              ))}
            </Fragment>
          ))}
        </MenuSurface>
      )}
    </>
  );
}
