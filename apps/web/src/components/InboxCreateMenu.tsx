import React, { useState } from "react";
import { PlusIcon } from "./Icons.js";
import { useAccessibleMenu } from "./interactions.js";
import { MenuItem, MenuSurface } from "./Menu.js";

export function InboxCreateMenu({
  onNewSession,
  onNewProject,
}: {
  onNewSession: () => void;
  onNewProject?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menu = useAccessibleMenu(open, setOpen, "inbox-create-menu");
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
        <MenuSurface
          surfaceRef={menu.menuRef}
          anchor={{ trigger: menu.triggerRef }}
          id={menu.menuId}
          label="Create"
          align="end"
          onDismiss={() => menu.close(true)}
          onKeyDown={menu.onMenuKeyDown}
        >
          <MenuItem onClick={() => choose(onNewSession)}>New Session</MenuItem>
          <MenuItem
            disabled={!onNewProject}
            description={onNewProject ? undefined : "New Project is unavailable on this connection."}
            onClick={() => { if (onNewProject) choose(onNewProject); }}
          >
            New Project
          </MenuItem>
        </MenuSurface>
      )}
    </div>
  );
}
