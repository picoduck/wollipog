import { runnerSupportsProtocol, type EditorInfo, type OS } from "@wollipog/protocol";
import { useId, useRef, useState, type ComponentType } from "react";
import { useApi } from "../api-context.js";
import { titleCaseLabel } from "../format.js";
import { runnerDisplay } from "../runners.js";
import { useStoreSelector } from "../store.js";
import { useFeedback } from "./FeedbackProvider.js";
import { useAccessibleMenu } from "./interactions.js";
import { MenuItem, MenuLabel, MenuNote, MenuSeparator, MenuSurface } from "./Menu.js";
import {
  ChevronDownIcon,
  CodeIcon,
  CursorEditorIcon,
  DevinDesktopIcon,
  FolderIcon,
  VisualStudioCodeIcon,
  ZedEditorIcon,
  type IconProps,
} from "./Icons.js";
import { loadBrowserStorageValue, saveBrowserStorageValue } from "../instance-storage.js";

const EDITOR_STORAGE_KEY = "wollipog.editor.lastUsed";
const DESTINATION_STORAGE_KEY = "wollipog.openDestination.lastUsed";
const REVEAL_DESTINATION_KEY = "reveal";
export const CHOOSE_DESTINATION_LABEL = "Choose Where to Open";
export const DESTINATION_MENU_LABEL = "Open In";

type OpenDestination =
  | { kind: "editor"; key: string; editorId: string; name: string }
  | { kind: "reveal"; key: typeof REVEAL_DESTINATION_KEY; name: string };

const EDITOR_ICONS: Record<string, ComponentType<IconProps>> = {
  code: VisualStudioCodeIcon,
  "code-insiders": VisualStudioCodeIcon,
  cursor: CursorEditorIcon,
  windsurf: DevinDesktopIcon,
  zed: ZedEditorIcon,
};
const EDITOR_DISPLAY_NAMES: Record<string, string> = {
  // Older connected runners still advertise the pre-rebrand name for this stable integration id.
  windsurf: "Devin Desktop",
};

export function fileManagerLabel(os: OS): "Explorer" | "Finder" | "File Manager" {
  if (os === "windows") return "Explorer";
  if (os === "macos") return "Finder";
  return "File Manager";
}

/** The menu note of an offline machine, which the disabled Open also names as its description. */
export function offlineDestinationNote(machine: string): string {
  return `${machine} is offline. You can open the folder again when it reconnects.`;
}

/** The Open control's name: the folder on its own, or the destination it opens in. */
export function openDestinationLabel(destination: { kind: "editor" | "reveal"; name: string }, only: boolean): string {
  return only && destination.kind === "reveal" ? "Open Folder" : `Open in ${destination.name}`;
}

function editorDestination(editor: EditorInfo): OpenDestination {
  const normalizedId = editor.id.toLocaleLowerCase();
  const advertisedName = Object.hasOwn(EDITOR_DISPLAY_NAMES, normalizedId)
    ? EDITOR_DISPLAY_NAMES[normalizedId]!
    : editor.name;
  const preservesIntentionalCasing = /[a-z]/.test(advertisedName) && /[A-Z]/.test(advertisedName.slice(1));
  return {
    kind: "editor",
    key: `editor:${editor.id}`,
    editorId: editor.id,
    name: preservesIntentionalCasing ? advertisedName : titleCaseLabel(advertisedName),
  };
}

function DestinationIcon({ destination, size = 16 }: { destination: OpenDestination; size?: number }) {
  if (destination.kind === "reveal") {
    return <span className="editor-destination-icon" data-destination-icon="file-manager"><FolderIcon size={size} /></span>;
  }
  const normalizedId = destination.editorId.toLocaleLowerCase();
  const hasKnownIcon = Object.hasOwn(EDITOR_ICONS, normalizedId);
  const Icon = hasKnownIcon ? EDITOR_ICONS[normalizedId]! : CodeIcon;
  const iconName = hasKnownIcon ? normalizedId : "generic-editor";
  return <span className="editor-destination-icon" data-destination-icon={iconName}><Icon size={size} /></span>;
}

/**
 * Session-root destination split button (docs/design-system.md §3.2). The server resolves the root
 * from the session ID; the browser can choose only a discovered editor ID or the fixed file-manager
 * reveal action. It is a quiet control: two ghost segments on a hairline, because opening the folder
 * is never the page's primary action. With one destination it is a single button with no menu.
 */
export function EditorSelect({ sessionId }: { sessionId: string }) {
  const api = useApi();
  const { showToast } = useFeedback();
  const sessions = useStoreSelector((s) => s.sessions);
  const runners = useStoreSelector((s) => s.runners);
  const boxes = useStoreSelector((s) => s.boxes);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const noteId = `${useId().replace(/:/g, "")}-offline`;
  const [lastUsed, setLastUsed] = useState<string | null>(() => {
    try {
      const destination = loadBrowserStorageValue(DESTINATION_STORAGE_KEY);
      if (destination) return destination;
      const editor = loadBrowserStorageValue(EDITOR_STORAGE_KEY);
      return editor ? `editor:${editor}` : null;
    } catch {
      return null;
    }
  });
  const menu = useAccessibleMenu(open, setOpen, "editor-menu");

  const session = sessions.get(sessionId);
  const runner = session ? runners.get(session.runnerId) : undefined;
  if (!session) return null;
  const isRemote = [...boxes.values()].some((b) => b.runnerId === session.runnerId);
  if (!runner || isRemote || !runnerSupportsProtocol(runner.protocolVersion, "hostActions")) return null;

  const offline = runner.status !== "online";
  const offlineNote = offlineDestinationNote(runnerDisplay(runner, undefined, runner.runnerId).name);
  const editors = (runner.editors ?? []).map(editorDestination);
  const reveal: OpenDestination = { kind: "reveal", key: REVEAL_DESTINATION_KEY, name: fileManagerLabel(runner.os) };
  const destinations: OpenDestination[] = [...editors, reveal];
  const only = destinations.length === 1;
  const chosen = destinations.find((destination) => destination.key === lastUsed) ?? destinations[0]!;
  const mainLabel = openDestinationLabel(chosen, only);

  const rememberDestination = (destination: OpenDestination) => {
    saveBrowserStorageValue(DESTINATION_STORAGE_KEY, destination.key);
    if (destination.kind === "editor") saveBrowserStorageValue(EDITOR_STORAGE_KEY, destination.editorId);
    setLastUsed(destination.key);
  };

  const launch = async (destination: OpenDestination) => {
    if (offline || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await api.hostAction(session.id, destination.kind === "editor"
        ? { kind: "open_editor", editorId: destination.editorId }
        : { kind: "reveal" });
    } catch (e) {
      showToast(`Couldn't open the folder in ${destination.name}.`, { tone: "error", detail: (e as Error).message });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const chooseAndLaunch = (destination: OpenDestination) => {
    // An offline menu stays open on its note; its destinations do nothing.
    if (offline) return;
    menu.close(true);
    if (busyRef.current) return;
    rememberDestination(destination);
    void launch(destination);
  };

  // `aria-disabled` rather than `disabled`: a destination that has focus when the machine drops
  // keeps it, instead of losing it to the page.
  const destinationItem = (destination: OpenDestination) => (
    <MenuItem
      key={destination.key}
      role="menuitemradio"
      checked={destination.key === chosen.key}
      aria-disabled={offline || undefined}
      icon={<DestinationIcon destination={destination} />}
      data-menu-label={destination.name}
      onClick={() => chooseAndLaunch(destination)}
    >
      {destination.name}
    </MenuItem>
  );

  return (
    <div className={only ? "editor-select" : "editor-select split"}>
      <button
        type="button"
        className="btn ghost editor-main"
        aria-disabled={offline || busy}
        aria-describedby={offline ? noteId : undefined}
        onClick={() => void launch(chosen)}
        title={mainLabel}
        aria-label={mainLabel}
      >
        <DestinationIcon destination={chosen} size={16} />
        <span className="editor-main-label">{only ? mainLabel : "Open"}</span>
      </button>
      {!only && (
        <button
          ref={menu.triggerRef}
          type="button"
          className="btn ghost"
          aria-disabled={busy}
          onClick={() => { if (!busy) menu.toggle(); }}
          onKeyDown={(event) => { if (!busy) menu.onTriggerKeyDown(event); }}
          title={CHOOSE_DESTINATION_LABEL}
          aria-label={CHOOSE_DESTINATION_LABEL}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={menu.menuId}
        >
          <ChevronDownIcon size={14} />
        </button>
      )}
      {/* The note the disabled Open points to while the menu that shows it is closed. */}
      {offline && !open && <span id={noteId} hidden>{offlineNote}</span>}
      {open && (
        <MenuSurface
          surfaceRef={menu.menuRef}
          anchor={{ trigger: menu.triggerRef }}
          id={menu.menuId}
          label={DESTINATION_MENU_LABEL}
          align="end"
          // With every destination disabled, the menu itself takes focus so Escape and the note reach it.
          tabIndex={-1}
          onDismiss={() => menu.close(true)}
          onKeyDown={menu.onMenuKeyDown}
        >
          <MenuLabel>{DESTINATION_MENU_LABEL}</MenuLabel>
          {editors.map(destinationItem)}
          {editors.length > 0 && <MenuSeparator />}
          {destinationItem(reveal)}
          {offline && <MenuNote id={noteId}>{offlineNote}</MenuNote>}
        </MenuSurface>
      )}
    </div>
  );
}
