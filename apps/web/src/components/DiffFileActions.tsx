import { useEffect, useRef, useState } from "react";
import { writeClipboardText } from "../clipboard.js";
import { useFeedback } from "./FeedbackProvider.js";
import { MoreHorizontalIcon } from "./Icons.js";
import { useAccessibleMenu } from "./interactions.js";
import { MenuItem, MenuSeparator, MenuSurface } from "./Menu.js";

/** One file action. Unavailable actions stay listed, with their reason as the second line (§9.1). */
export interface DiffFileAction {
  label: string;
  run: () => void;
  unavailableReason?: string;
}

/**
 * A changed file's actions (#2848; docs/design-system.md §9.1): one `⋯` button in the file's sticky
 * head that opens the shared menu, a bottom sheet on phones. Open in Files, Attach File to Prompt
 * and Copy Path, then the one destructive action, last and after a separator, when the file can be
 * discarded here. It replaced the head's "↗" and its red Discard button.
 */
export function DiffFileActions({ path, openInFiles, attach, discard }: {
  path: string;
  /** Absent when no Files tool can open it. */
  openInFiles?: DiffFileAction;
  /** Absent when the runner cannot attach workspace references. */
  attach?: DiffFileAction;
  /** Discard Changes… or Discard New File…; absent when this view cannot discard. */
  discard?: DiffFileAction;
}) {
  const [open, setOpen] = useState(false);
  // Unavailable items are aria-disabled rather than disabled, so a keyboard or screen-reader user
  // reaches each one and hears why; `choose` refuses to run one.
  const menu = useAccessibleMenu(open, setOpen, "diff-file-actions", "item", { reachUnavailable: true });
  const { showToast } = useFeedback();
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const label = `${path} Actions`;

  const copyPath = async () => {
    // The menu closes now, not when the write settles. A refused write falls back only while focus is
    // still where the copy left it (see TranscriptActionMenu).
    const trigger = menu.triggerRef.current;
    trigger?.focus();
    menu.close(false);
    const current = () => mountedRef.current && (document.activeElement === null ||
      document.activeElement === document.body || document.activeElement === trigger);
    const result = await writeClipboardText(path, current);
    if (result === null) return;
    if (document.activeElement === document.body || document.activeElement === null) trigger?.focus();
    if (result) showToast("Copied the path.", { tone: "success" });
    else showToast("Couldn't copy the path.", { tone: "error" });
  };

  const choose = (action: DiffFileAction) => {
    if (action.unavailableReason !== undefined) return;
    // Focus the trigger before the action runs, so a confirmation it opens returns focus there.
    menu.triggerRef.current?.focus();
    menu.close(false);
    action.run();
  };

  const item = (action: DiffFileAction, danger = false) => (
    <MenuItem
      danger={danger}
      data-menu-label={action.label}
      aria-disabled={action.unavailableReason === undefined ? undefined : true}
      description={action.unavailableReason}
      onClick={() => choose(action)}
    >
      {action.label}
    </MenuItem>
  );

  return (
    <>
      <button
        ref={menu.triggerRef}
        type="button"
        className="icon-btn sm dfile-actions"
        onClick={menu.toggle}
        onKeyDown={menu.onTriggerKeyDown}
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menu.menuId : undefined}
      >
        <MoreHorizontalIcon size={16} aria-hidden="true" />
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
          {openInFiles && item(openInFiles)}
          {attach && item(attach)}
          <MenuItem data-menu-label="Copy Path" onClick={() => void copyPath()}>Copy Path</MenuItem>
          {discard && (
            <>
              <MenuSeparator />
              {item(discard, true)}
            </>
          )}
        </MenuSurface>
      )}
    </>
  );
}
