import { useRef, useState } from "react";
import { useApi } from "../api-context.js";
import { useStoreSelector } from "../store.js";
import { useAccessibleMenu } from "./interactions.js";
import { CodeIcon } from "./Icons.js";
import { loadBrowserStorageValue, saveBrowserStorageValue } from "../instance-storage.js";

const LAUNCH_IN_PROGRESS_NOTE = "An editor launch is already in progress.";

/**
 * Codex-style "Open in …" split button for the topbar: the main click opens the session's
 * working directory in the last-used editor; the chevron lists every editor discovery found
 * on the runner host. Hidden for box (remote) runners — the editors live on the wrong
 * machine — and when discovery found none.
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
      return loadBrowserStorageValue("wollipog.editor.lastUsed");
    } catch {
      return null;
    }
  });
  const menu = useAccessibleMenu(open, setOpen, "editor-menu");

  const session = sessions.get(sessionId);
  if (!session) return null;
  const runner = runners.get(session.runnerId);
  const editors = runner?.editors ?? [];
  const isRemote = [...boxes.values()].some((b) => b.runnerId === session.runnerId);
  if (isRemote || editors.length === 0 || runner?.status !== "online") return null;

  const chosen = editors.find((e) => e.id === lastUsed) ?? editors[0]!;

  const selectEditor = (editorId: string) => {
    saveBrowserStorageValue("wollipog.editor.lastUsed", editorId);
    setLastUsed(editorId);
    setNote(null);
    menu.close(true);
  };

  const openInChosenEditor = async () => {
    if (busyRef.current) {
      setNote(LAUNCH_IN_PROGRESS_NOTE);
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setNote(null);
    try {
      await api.hostAction(session.id, { kind: "open_editor", editorId: chosen.id });
    } catch (e) {
      setNote((e as Error).message);
      setTimeout(() => setNote(null), 6000);
    } finally {
      busyRef.current = false;
      setBusy(false);
      setNote((current) => current === LAUNCH_IN_PROGRESS_NOTE ? null : current);
    }
  };

  return (
    <div className="editor-select">
      {note && <span className="editor-note" role="status">{note}</span>}
      <button
        type="button"
        className="icon-btn editor-main"
        aria-disabled={busy}
        onClick={() => void openInChosenEditor()}
        title={`Open in ${chosen.name}`}
        aria-label={`Open in ${chosen.name}`}
      >
        <CodeIcon size={15} />
      </button>
      <button
        ref={menu.triggerRef}
        type="button"
        className="icon-btn editor-caret"
        onClick={menu.toggle}
        onKeyDown={menu.onTriggerKeyDown}
        title="Choose Editor"
        aria-label="Choose Editor"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menu.menuId}
      >
        ▾
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={() => menu.close(true)} />
          <div className="menu-pop editor-pop" role="menu" id={menu.menuId} ref={menu.menuRef} onKeyDown={menu.onMenuKeyDown}>
            {editors.map((e) => (
              <button
                key={e.id}
                type="button"
                className="menu-item"
                role="menuitemradio"
                aria-checked={e.id === chosen.id}
                onClick={() => selectEditor(e.id)}
              >
                {e.name}
                {e.id === chosen.id && <span className="editor-current" aria-hidden="true">✓</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
