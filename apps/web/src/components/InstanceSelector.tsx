import React, { Fragment, useState } from "react";
import { instanceAvailabilityMeta, useInstances } from "../instances-context.js";
import { ChevronDownIcon, ConnectionsIcon } from "./Icons.js";
import { useAccessibleMenu } from "./interactions.js";
import { MenuItem, MenuSeparator, MenuSurface } from "./Menu.js";

export function InstanceSelector({ compact = false }: { compact?: boolean }) {
  const instances = useInstances();
  const [open, setOpen] = useState(false);
  const menu = useAccessibleMenu(open, setOpen, "instance-selector-menu");
  if (!instances.desktopMultiInstance) return null;

  const activeStatus = instances.statusByProfile[instances.activeProfile.id]?.availability
    ?? (instances.phase === "opening" ? "connecting" : "saved");
  const select = (profileId: string) => {
    menu.close(true);
    if (profileId !== instances.activeProfile.id) void instances.switchInstance(profileId);
  };
  const manage = () => {
    menu.close(true);
    instances.manageInstances();
  };

  return (
    <div className={`instance-selector${compact ? " compact" : ""}`}>
      <button
        ref={menu.triggerRef}
        type="button"
        className="instance-selector-trigger"
        onClick={menu.toggle}
        onKeyDown={menu.onTriggerKeyDown}
        aria-label={`Switch Instance, Current ${instances.activeProfile.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menu.menuId}
        title={`Switch Instance: ${instances.activeProfile.label}`}
      >
        <span className={`instance-status-dot status-${activeStatus}`} aria-hidden="true" />
        <span className="instance-selector-label">{instances.activeProfile.label}</span>
        {activeStatus === "connecting" && <span className="sr-only">Connecting</span>}
        <ChevronDownIcon className="instance-selector-chevron" />
      </button>
      {open && (
        <MenuSurface
          surfaceRef={menu.menuRef}
          anchor={{ trigger: menu.triggerRef }}
          id={menu.menuId}
          label="Switch Instance"
          width={compact ? 260 : "trigger"}
          onDismiss={() => menu.close(false)}
          onKeyDown={menu.onMenuKeyDown}
        >
          {instances.registry.profiles.map((profile, index) => {
            const active = profile.id === instances.activeProfile.id;
            const status = instances.statusByProfile[profile.id]?.availability ?? "saved";
            return (
              <Fragment key={profile.id}>
                {index === 1 && <MenuSeparator />}
                <MenuItem
                  role="menuitemradio"
                  checked={active}
                  icon={<span className={`instance-status-dot status-${status}`} />}
                  description={profile.kind === "local" ? "Local Control Plane" : profile.origin}
                  data-menu-label={profile.label}
                  onClick={() => select(profile.id)}
                >
                  {profile.label}
                  <span className="sr-only">, {instanceAvailabilityMeta(status).label}</span>
                </MenuItem>
              </Fragment>
            );
          })}
          <MenuSeparator />
          <MenuItem icon={<ConnectionsIcon />} data-menu-label="Manage Instances" onClick={manage}>
            Manage Instances
          </MenuItem>
        </MenuSurface>
      )}
    </div>
  );
}
