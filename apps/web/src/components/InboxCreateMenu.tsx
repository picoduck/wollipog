import React, { useState } from "react";
import { PlusIcon } from "./Icons.js";
import { useAccessibleMenu, useAnchoredMenuStyle } from "./interactions.js";

export function InboxCreateMenu({
  onNewSession,
  onNewProject,
}: {
  onNewSession: () => void;
  onNewProject?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menu = useAccessibleMenu(open, setOpen, "inbox-create-menu");
  const menuStyle = useAnchoredMenuStyle(open, menu.triggerRef, {
    desiredWidth: 180,
    desiredHeight: 104,
    align: "end",
  });
  const choose = (action: () => void) => {
    menu.close(false);
    menu.triggerRef.current?.focus();
    action();
  };

  return (
    <div className="inbox-create-menu">
      <button
        ref={menu.triggerRef}
        type="button"
        className="inbox-create-control"
        onClick={menu.toggle}
        onKeyDown={menu.onTriggerKeyDown}
        aria-label="Create"
        title="Create"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menu.menuId}
      >
        <PlusIcon size={16} />
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={() => menu.close(true)} aria-hidden="true" />
          <div
            className="menu-pop inbox-create-menu-pop"
            id={menu.menuId}
            ref={menu.menuRef}
            role="menu"
            aria-label="Create"
            style={menuStyle}
            onKeyDown={menu.onMenuKeyDown}
          >
            <button type="button" className="menu-item" role="menuitem" onClick={() => choose(onNewSession)}>
              New Session
            </button>
            <button
              type="button"
              className="menu-item"
              role="menuitem"
              disabled={!onNewProject}
              title={onNewProject ? undefined : "New Project is unavailable on this connection."}
              onClick={() => { if (onNewProject) choose(onNewProject); }}
            >
              New Project
            </button>
          </div>
        </>
      )}
    </div>
  );
}
