import React, { useEffect, useRef, useState } from "react";
import { useInstances, type InstanceAvailability } from "../instances-context.js";
import { CheckIcon, ChevronDownIcon, ConnectionsIcon } from "./Icons.js";
import { useAccessibleMenu, useAnchoredMenuStyle } from "./interactions.js";

const STATUS_LABELS: Record<InstanceAvailability, string> = {
  saved: "Saved",
  connecting: "Connecting",
  online: "Online",
  offline: "Offline",
  "authentication-required": "Authentication Required",
  incompatible: "Incompatible",
  "missing-credential": "Authentication Required",
};

function desiredInstanceMenuHeight(profileCount: number): number {
  const profiles = Math.max(1, profileCount);
  const separators = profiles > 1 ? 2 : 1;
  // Profile rows contain a title and description; Manage Instances is one line. This is a maximum
  // as well as the CSS max-height, so every allowance must cover Segoe UI's normal line box.
  // Large registries still scroll without making a 1-2 profile menu pretend it is 336px tall.
  const profileRows = profiles * 52;
  const manageRow = 36;
  const separatorRows = separators * 11;
  const menuChrome = 14; // 6px padding plus a 1px border on both edges.
  return Math.min(336, profileRows + manageRow + separatorRows + menuChrome);
}

export function InstanceSelector({ compact = false }: { compact?: boolean }) {
  const instances = useInstances();
  const [open, setOpen] = useState(false);
  const menu = useAccessibleMenu(open, setOpen, "instance-selector-menu");
  const menuStyle = useAnchoredMenuStyle(open, menu.triggerRef, {
    desiredHeight: desiredInstanceMenuHeight(instances.registry.profiles.length),
    ...(compact ? { desiredWidth: 260 } : { matchTriggerWidth: true }),
  });
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) menu.close(false);
    };
    document.addEventListener("pointerdown", closeOutside, true);
    return () => document.removeEventListener("pointerdown", closeOutside, true);
  }, [menu, open]);

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
    <div ref={rootRef} className={`plus-menu instance-selector${compact ? " compact" : ""}`}>
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
        <div
          id={menu.menuId}
          ref={menu.menuRef}
          className="plus-pop instance-selector-pop"
          role="menu"
          aria-label="Switch Instance"
          onKeyDown={menu.onMenuKeyDown}
          style={menuStyle}
        >
          {instances.registry.profiles.map((profile, index) => {
            const active = profile.id === instances.activeProfile.id;
            const status = instances.statusByProfile[profile.id]?.availability ?? "saved";
            return (
              <div key={profile.id}>
                {index === 1 && <div className="instance-menu-separator" role="separator" />}
                <button
                  type="button"
                  className={`plus-item instance-selector-item${active ? " on" : ""}`}
                  role="menuitemradio"
                  aria-checked={active}
                  data-menu-label={profile.label}
                  onClick={() => select(profile.id)}
                >
                  <span className={`instance-status-dot status-${status}`} aria-hidden="true" />
                  <span className="plus-item-body">
                    <span className="plus-item-title">{profile.label}</span>
                    <span className="plus-item-desc">
                      {profile.kind === "local" ? "Local Control Plane" : profile.origin}
                    </span>
                  </span>
                  <span className="instance-selector-check" aria-hidden="true">
                    {active && <CheckIcon />}
                  </span>
                  <span className="sr-only">{STATUS_LABELS[status]}</span>
                </button>
              </div>
            );
          })}
          <div className="instance-menu-separator" role="separator" />
          <button
            type="button"
            className="plus-item instance-selector-item"
            role="menuitem"
            data-menu-label="Manage Instances"
            onClick={manage}
          >
            <ConnectionsIcon />
            <span className="plus-item-title">Manage Instances</span>
          </button>
        </div>
      )}
    </div>
  );
}
