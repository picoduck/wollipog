import React, { useId, useRef, useState } from "react";
import type { InstanceProfile } from "../desktop-instances.js";
import {
  instanceAvailabilityMeta,
  instanceMonogram,
  instanceStatus,
  useActiveInstanceConnection,
  useInstances,
} from "../instances-context.js";
import { statusMeta, type StatusMeta } from "../status-meta.js";
import { ListIcon, PlusIcon } from "./Icons.js";
import { useAccessibleMenu } from "./interactions.js";
import { MenuItem, MenuLabel, MenuSeparator, MenuSurface } from "./Menu.js";
import { StatusBadge, statusToneClass } from "./StatusBadge.js";

/** The instance menu is a 300px flyout beside the rail (§9.1, #1970). */
export const INSTANCE_MENU_WIDTH = 300;

/** The ancestor the flyout opens beside: the desktop rail, the recovery screen's too (#3004). */
const INSTANCE_MENU_BESIDE = ".app-rail";

/** A status label as tooltip text, which is sentence case (§9.3): "Pairing Required" → "Pairing required". */
function sentenceCase(label: string): string {
  return label.charAt(0) + label.slice(1).toLowerCase();
}

/**
 * The current instance as a monogram tile (docs/design-system.md §4.1), and the menu that switches
 * it (§9.1). Desktop app only: in the browser build it renders nothing and the rail keeps its brand.
 *
 * What the shell's banner says about the active instance (`useActiveInstanceConnection`) wins over
 * the status the instance manager last recorded, which can still read Online for a moment after the
 * socket drops. `labelled` shows the name and status beside the tile, for the labelled rail, which
 * is wide enough to hold them (#1968).
 */
export function InstanceSelector({ labelled = false }: { labelled?: boolean }) {
  const instances = useInstances();
  const connection = useActiveInstanceConnection();
  const [open, setOpen] = useState(false);
  const menu = useAccessibleMenu(open, setOpen, "instance-selector-menu");
  const tileRef = useRef<HTMLSpanElement>(null);
  const idPrefix = useId().replace(/:/g, "");
  if (!instances.desktopMultiInstance) return null;

  const active = instances.activeProfile;
  /** The status a row shows as text: only one that is known and is not Online. */
  const rowStatus = (profile: InstanceProfile): StatusMeta | null => {
    const { availability } = instanceStatus(instances, connection, profile.id);
    return availability === "online" ? null : instanceAvailabilityMeta(availability);
  };
  // The tile always has a dot. An active instance with nothing recorded is opening (Connecting) or
  // was lost from the registry; the latter is not known to be current, so it reads hollow Offline.
  const tileStatus = instanceAvailabilityMeta(instanceStatus(instances, connection, active.id).availability)
    ?? statusMeta("machine", "offline");
  const statusId = `${idPrefix}-status`;

  const select = (profileId: string) => {
    menu.close(true);
    if (profileId !== active.id) void instances.switchInstance(profileId);
  };
  const add = () => {
    // Focus the tile now rather than through close(true), which restores it a frame later; the row
    // unmounts with the menu, so the dialog returns focus to the tile.
    menu.triggerRef.current?.focus();
    menu.close(false);
    instances.openInstanceDialog({ mode: "add", returnFocus: menu.triggerRef.current });
  };
  const manage = () => {
    menu.close(true);
    instances.manageInstances();
  };

  const row = (profile: InstanceProfile) => {
    const status = rowStatus(profile);
    const rowStatusId = `${idPrefix}-${profile.id.replace(/[^\w-]/g, "_")}-status`;
    return (
      <MenuItem
        key={profile.id}
        role="menuitemradio"
        checked={profile.id === active.id}
        icon={<span className="instance-monogram">{instanceMonogram(profile.label)}</span>}
        // The origin is a fact about the row; "Local Control Plane" named an implementation.
        description={profile.kind === "local" ? "On this machine" : profile.origin}
        trail={status ? <span id={rowStatusId}><StatusBadge meta={status} inline /></span> : undefined}
        aria-describedby={status ? rowStatusId : undefined}
        data-menu-label={profile.label}
        onClick={() => select(profile.id)}
      >
        {profile.label}
      </MenuItem>
    );
  };
  const local = instances.registry.profiles.filter((profile) => profile.kind === "local");
  const remote = instances.registry.profiles.filter((profile) => profile.kind !== "local");

  return (
    <div className={`instance-selector${labelled ? " labelled" : ""}`}>
      <button
        ref={menu.triggerRef}
        type="button"
        className="instance-tile-trigger"
        onClick={menu.toggle}
        onKeyDown={menu.onTriggerKeyDown}
        aria-label={`Switch Instance: ${active.label}`}
        aria-describedby={statusId}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menu.menuId}
        // The rail's tooltip (§9.3): the name, then the status. A labelled navigation shows both.
        data-rail-tip={labelled ? undefined : active.label}
        data-rail-detail={labelled ? undefined : sentenceCase(tileStatus.label)}
      >
        <span ref={tileRef} className="instance-monogram tile" aria-hidden="true">
          {instanceMonogram(active.label)}
          <span className={`instance-tile-dot ${statusToneClass(tileStatus.tone)}${tileStatus.hollow ? " hollow" : ""}`} />
        </span>
        {labelled ? (
          <span className="instance-tile-text">
            <span className="instance-tile-name">{active.label}</span>
            <span id={statusId} className="instance-tile-status">{tileStatus.label}</span>
          </span>
        ) : (
          <span id={statusId} className="sr-only">{tileStatus.label}</span>
        )}
      </button>
      {open && (
        <MenuSurface
          surfaceRef={menu.menuRef}
          anchor={{ trigger: tileRef }}
          beside={INSTANCE_MENU_BESIDE}
          id={menu.menuId}
          label="Switch Instance"
          className="instance-menu"
          width={INSTANCE_MENU_WIDTH}
          onDismiss={() => menu.close(true)}
          onKeyDown={menu.onMenuKeyDown}
        >
          {local.map(row)}
          {remote.length > 0 && <MenuLabel>Remote</MenuLabel>}
          {remote.map(row)}
          <MenuSeparator />
          <MenuItem icon={<PlusIcon />} data-menu-label="Add Remote Instance…" onClick={add}>
            Add Remote Instance…
          </MenuItem>
          <MenuItem icon={<ListIcon />} data-menu-label="Manage Instances" onClick={manage}>
            Manage Instances
          </MenuItem>
        </MenuSurface>
      )}
    </div>
  );
}
