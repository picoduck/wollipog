import { runnerSupportsProtocol, type EditorInfo, type OS } from "@wollipog/protocol";
import { useEffect, useRef, useState, type ComponentType } from "react";
import { useApi } from "../api-context.js";
import { titleCaseLabel } from "../format.js";
import { useStoreSelector } from "../store.js";
import { useAccessibleMenu, useAnchoredMenuStyle } from "./interactions.js";
import {
  ChevronDownIcon,
  CodeIcon,
  CursorEditorIcon,
  FolderIcon,
  VisualStudioCodeIcon,
  WindsurfEditorIcon,
  ZedEditorIcon,
  type IconProps,
} from "./Icons.js";
import { loadBrowserStorageValue, saveBrowserStorageValue } from "../instance-storage.js";

const EDITOR_STORAGE_KEY = "wollipog.editor.lastUsed";
const DESTINATION_STORAGE_KEY = "wollipog.openDestination.lastUsed";
const REVEAL_DESTINATION_KEY = "reveal";
const LAUNCH_IN_PROGRESS_NOTE = "A destination launch is already in progress.";
const RUNNER_OFFLINE_NOTE = "Runner is offline.";

type OpenDestination =
  | { kind: "editor"; key: string; editorId: string; name: string }
  | { kind: "reveal"; key: typeof REVEAL_DESTINATION_KEY; name: string };

const EDITOR_ICONS: Record<string, ComponentType<IconProps>> = {
  code: VisualStudioCodeIcon,
  "code-insiders": VisualStudioCodeIcon,
  cursor: CursorEditorIcon,
  windsurf: WindsurfEditorIcon,
  zed: ZedEditorIcon,
};

export function fileManagerLabel(os: OS): "Explorer" | "Finder" | "File Manager" {
  if (os === "windows") return "Explorer";
  if (os === "macos") return "Finder";
  return "File Manager";
}

function editorDestination(editor: EditorInfo): OpenDestination {
  return {
    kind: "editor",
    key: `editor:${editor.id}`,
    editorId: editor.id,
    name: titleCaseLabel(editor.name),
  };
}

function DestinationIcon({ destination, size = 16 }: { destination: OpenDestination; size?: number }) {
  if (destination.kind === "reveal") {
    return <span className="editor-destination-icon" data-destination-icon="file-manager"><FolderIcon size={size} /></span>;
  }
  const normalizedId = destination.editorId.toLocaleLowerCase();
  const Icon = EDITOR_ICONS[normalizedId] ?? CodeIcon;
  const iconName = EDITOR_ICONS[normalizedId] ? normalizedId : "generic-editor";
  return <span className="editor-destination-icon" data-destination-icon={iconName}><Icon size={size} /></span>;
}

/**
 * Session-root destination split button. The server resolves the root from the session ID; the
 * browser can choose only a discovered editor ID or the fixed file-manager reveal action.
 */
export function EditorSelect({ sessionId }: { sessionId: string }) {
  const api = useApi();
  const sessions = useStoreSelector((s) => s.sessions);
  const runners = useStoreSelector((s) => s.runners);
  const boxes = useStoreSelector((s) => s.boxes);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const busyRef = useRef(false);
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
  const menuStyle = useAnchoredMenuStyle(open, menu.triggerRef, {
    desiredWidth: 220,
    desiredHeight: 260,
    align: "end",
  });

  const session = sessions.get(sessionId);
  const runner = session ? runners.get(session.runnerId) : undefined;
  const offline = runner?.status !== "online";
  useEffect(() => {
    if (!offline) setNote((current) => current === RUNNER_OFFLINE_NOTE ? null : current);
  }, [offline]);
  if (!session) return null;
  const isRemote = [...boxes.values()].some((b) => b.runnerId === session.runnerId);
  if (!runner || isRemote || !runnerSupportsProtocol(runner.protocolVersion, "hostActions")) return null;

  const destinations: OpenDestination[] = [
    ...(runner.editors ?? []).map(editorDestination),
    { kind: "reveal", key: REVEAL_DESTINATION_KEY, name: fileManagerLabel(runner.os) },
  ];
  const chosen = destinations.find((destination) => destination.key === lastUsed) ?? destinations[0]!;
  const unavailable = offline || busy;

  const rememberDestination = (destination: OpenDestination) => {
    saveBrowserStorageValue(DESTINATION_STORAGE_KEY, destination.key);
    if (destination.kind === "editor") saveBrowserStorageValue(EDITOR_STORAGE_KEY, destination.editorId);
    setLastUsed(destination.key);
  };

  const launch = async (destination: OpenDestination) => {
    if (offline) {
      setNote(RUNNER_OFFLINE_NOTE);
      return;
    }
    if (busyRef.current) {
      setNote(LAUNCH_IN_PROGRESS_NOTE);
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setNote(null);
    try {
      await api.hostAction(session.id, destination.kind === "editor"
        ? { kind: "open_editor", editorId: destination.editorId }
        : { kind: "reveal" });
    } catch (e) {
      const message = (e as Error).message;
      setNote(message);
      window.setTimeout(() => setNote((current) => current === message ? null : current), 6000);
    } finally {
      busyRef.current = false;
      setBusy(false);
      setNote((current) => current === LAUNCH_IN_PROGRESS_NOTE ? null : current);
    }
  };

  const chooseAndLaunch = (destination: OpenDestination) => {
    if (unavailable) return void launch(destination);
    rememberDestination(destination);
    menu.close(true);
    void launch(destination);
  };

  const availabilityLabel = offline ? "Open Unavailable: Runner Offline" : `Open in ${chosen.name}`;

  return (
    <div className="editor-select">
      {note && <span className="editor-note" role="status">{note}</span>}
      <button
        type="button"
        className="editor-split-segment editor-main"
        aria-disabled={unavailable}
        onClick={() => void launch(chosen)}
        title={offline ? "Runner is offline." : availabilityLabel}
        aria-label={availabilityLabel}
      >
        <DestinationIcon destination={chosen} size={15} />
        <span className="editor-main-label">Open</span>
      </button>
      <button
        ref={menu.triggerRef}
        type="button"
        className="editor-split-segment editor-caret"
        aria-disabled={unavailable}
        onClick={() => { if (!unavailable) menu.toggle(); }}
        onKeyDown={(event) => { if (!unavailable) menu.onTriggerKeyDown(event); }}
        title={offline ? "Runner is offline." : "Choose Destination"}
        aria-label={offline ? "Choose Destination Unavailable: Runner Offline" : "Choose Destination"}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menu.menuId}
      >
        <ChevronDownIcon size={13} />
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={() => menu.close(true)} />
          <div
            className="menu-pop editor-pop"
            role="menu"
            id={menu.menuId}
            ref={menu.menuRef}
            style={menuStyle}
            onKeyDown={menu.onMenuKeyDown}
          >
            {destinations.map((destination) => (
              <button
                key={destination.key}
                type="button"
                className="menu-item editor-destination-item"
                role="menuitemradio"
                aria-checked={destination.key === chosen.key}
                data-menu-label={destination.name}
                onClick={() => chooseAndLaunch(destination)}
              >
                <DestinationIcon destination={destination} />
                <span>{destination.name}</span>
                {destination.key === chosen.key && <span className="editor-current" aria-hidden="true">✓</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
