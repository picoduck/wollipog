import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  parseSourceLocation,
  runnerSupportsProtocol,
  type EditorSourceLocation,
  type SessionFileEntry,
  type SessionView,
  type SourceLocation,
} from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { crumbsFor, editorSupportsSourceLocation, formatBytes, isMarkdownPath, resolveSourceTarget, type ResolvedSourceTarget } from "../files-panel.js";
import { absoluteViewUrl } from "../navigation.js";
import { instancePublicOrigin, useInstances } from "../instances-context.js";
import { useStoreSelector } from "../store.js";
import { Markdown } from "./Markdown.js";
import { handleRovingChoiceKeyDown } from "./interactions.js";
import { Spinner } from "./common.js";
import { loadBrowserStorageValue, saveBrowserStorageValue } from "../instance-storage.js";

interface FileView {
  path: string;
  content?: string;
  size?: number;
  truncated?: boolean;
  binary?: boolean;
}

function SourceLine({ text, line, target }: { text: string; line: number; target: ResolvedSourceTarget | null }) {
  const selected = !target?.error && target?.line === line;
  if (!selected || target.column === undefined || target.matchLength === undefined) {
    return <span className={`files-source-line${selected ? " is-target" : ""}`} data-source-line={line} data-line-number={line}>{text || "\u200b"}</span>;
  }
  const start = Math.max(0, Math.min(text.length, target.column - 1));
  const end = Math.max(start, Math.min(text.length, start + target.matchLength));
  return (
    <span className="files-source-line is-target" data-source-line={line} data-line-number={line}>
      {text.slice(0, start)}<mark>{text.slice(start, end) || "\u200b"}</mark>{text.slice(end)}
    </span>
  );
}

/**
 * Files browser: browse the session's working directory (worktree or repo — the runner resolves
 * the root from box meta) and view files in place; markdown renders formatted, everything else
 * as plain text. Hosted by the right side panel's "Files" mode (Ctrl+P); lists the root on
 * mount. Read-only — the Git/Review panel owns the change/commit story.
 */
export function FilesBrowser({
  session,
  runnerOnline,
  runnerProtocolVersion,
  location,
  onOpenLocation,
  onClearLocation,
}: {
  session: SessionView;
  runnerOnline: boolean;
  runnerProtocolVersion: number | null | undefined;
  location?: SourceLocation;
  onOpenLocation: (location: SourceLocation) => void;
  onClearLocation: () => void;
}) {
  const api = useApi();
  const instances = useInstances();
  const [path, setPath] = useState(""); // current directory, root-relative ("" = root)
  const [entries, setEntries] = useState<SessionFileEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<FileView | null>(null);
  const [fileBusy, setFileBusy] = useState<string | null>(null);
  const [rendered, setRendered] = useState(true); // markdown: rendered vs source
  const [symbolDraft, setSymbolDraft] = useState(location?.symbol ?? "");
  const [note, setNote] = useState<string | null>(null);
  const [editorBusy, setEditorBusy] = useState(false);
  const [selectedEditor, setSelectedEditor] = useState<string | null>(() => {
    return loadBrowserStorageValue("wollipog.editor.lastUsed");
  });
  const symbolInputId = `source-symbol-${useId().replace(/:/g, "")}`;
  // Monotonic token: fast navigation fires overlapping loads; only the latest writes state
  // (same race stance as GitPanel's diff loader).
  const reqRef = useRef(0);
  const viewerRef = useRef<HTMLDivElement>(null);
  const pendingDirectoryRef = useRef<string | null>(null);
  const runner = useStoreSelector((state) => state.runners.get(session.runnerId));
  const isRemote = useStoreSelector((state) => [...state.boxes.values()].some((box) => box.runnerId === session.runnerId));

  const loadDir = useCallback(async (dir: string) => {
    const reqId = ++reqRef.current;
    setBusy(true);
    setError(null);
    try {
      const d = await api.listSessionFiles(session.id, dir);
      if (reqRef.current !== reqId) return;
      setPath(d.path);
      setEntries(d.entries);
    } catch (e) {
      if (reqRef.current !== reqId) return;
      setError((e as Error).message);
    } finally {
      if (reqRef.current === reqId) setBusy(false);
    }
  }, [api, session.id]);

  const openFile = useCallback(async (p: string, requested?: SourceLocation) => {
    const reqId = ++reqRef.current;
    setFileBusy(p);
    setError(null);
    try {
      const d = await api.readSessionFile(session.id, p);
      if (reqRef.current !== reqId) return;
      setFile({ ...d, path: d.path || p });
      setRendered(!(requested?.line !== undefined || requested?.symbol !== undefined));
      setSymbolDraft(requested?.symbol ?? "");
    } catch (e) {
      if (reqRef.current !== reqId) return;
      setError((e as Error).message);
    } finally {
      if (reqRef.current === reqId) setFileBusy(null);
    }
  }, [api, session.id]);

  // The canonical route owns file selection. Back/Forward therefore reloads the exact target,
  // while the plain session route returns to a root listing.
  useEffect(() => {
    if (location) {
      if (file?.path === location.path) {
        setRendered(!(location.line !== undefined || location.symbol !== undefined));
        setSymbolDraft(location.symbol ?? "");
      } else {
        void openFile(location.path, location);
      }
    }
    else {
      setFile(null);
      setSymbolDraft("");
      const nextDirectory = pendingDirectoryRef.current ?? "";
      pendingDirectoryRef.current = null;
      void loadDir(nextDirectory);
    }
  }, [file?.path, loadDir, location, openFile]);

  const target = useMemo(
    () => file && location?.path === file.path && file.content !== undefined
      ? resolveSourceTarget(file.content, location)
      : null,
    [file, location],
  );

  useEffect(() => {
    if (!target || target.error || rendered) return;
    const frame = window.requestAnimationFrame(() => {
      viewerRef.current?.querySelector<HTMLElement>(`[data-source-line="${target.line}"]`)?.scrollIntoView({ block: "center" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [file?.path, rendered, target]);

  const editorLocation = useMemo<EditorSourceLocation | null>(() => {
    if (!file) return null;
    if (!target || target.error) return { path: file.path };
    return {
      path: file.path,
      line: target.line,
      ...(target.column === undefined ? {} : { column: target.column }),
    };
  }, [file, target]);
  const locationEditors = runnerSupportsProtocol(runnerProtocolVersion, "editorLocations") && !isRemote && editorLocation
    ? (runner?.editors ?? []).filter((editor) => editorSupportsSourceLocation(editor, editorLocation))
    : [];
  const chosenEditor = locationEditors.find((editor) => editor.id === selectedEditor) ?? locationEditors[0];

  const flashNote = (message: string) => {
    setNote(message);
    window.setTimeout(() => setNote((current) => current === message ? null : current), 5000);
  };
  const copyLink = async () => {
    if (!file) return;
    const publicOrigin = instancePublicOrigin(instances);
    if (!publicOrigin) {
      flashNote("Open this dashboard through a reachable address before copying a source link.");
      return;
    }
    const targetLocation = location?.path === file.path ? location : { path: file.path };
    try {
      await navigator.clipboard.writeText(absoluteViewUrl(publicOrigin, {
        name: "session", id: session.id, location: targetLocation,
      }));
      flashNote("Source link copied.");
    } catch (cause) {
      flashNote(`Could not copy source link: ${(cause as Error).message}`);
    }
  };
  const openInEditor = async () => {
    if (!chosenEditor || !editorLocation) return;
    setEditorBusy(true);
    setSelectedEditor(chosenEditor.id);
    saveBrowserStorageValue("wollipog.editor.lastUsed", chosenEditor.id);
    saveBrowserStorageValue("wollipog.openDestination.lastUsed", `editor:${chosenEditor.id}`);
    try {
      await api.hostAction(session.id, {
        kind: "open_editor_location", editorId: chosenEditor.id, location: editorLocation,
      });
      flashNote(`Opened in ${chosenEditor.name}.`);
    } catch (cause) {
      flashNote((cause as Error).message);
    } finally {
      setEditorBusy(false);
    }
  };
  const jumpToSymbol = () => {
    if (!file) return;
    const next = parseSourceLocation({ path: file.path, symbol: symbolDraft });
    if (!next) return flashNote("Enter a symbol of 1-256 printable characters.");
    onOpenLocation(next);
  };

  const crumbs = crumbsFor(file ? file.path.split("/").slice(0, -1).join("/") : path);
  const disabled = !runnerOnline || busy;

  return (
    <div className="files-browser">
      {!runnerOnline && <div className="hint warn">Runner is offline — files are unavailable.</div>}
      {error && <div className="composer-error">{error}</div>}

      <div className="git-status-row">
        <nav className="files-crumbs" aria-label="Path">
          {crumbs.map((c, i) => (
            <span key={c.path}>
              {i > 0 && <span className="muted"> / </span>}
              <button
                className="files-crumb"
                disabled={disabled && !file}
                onClick={() => {
                  // A crumb can supersede an in-flight file read (crumbs stay enabled while
                  // fileBusy). The superseded read's finally is token-guarded and will NOT
                  // clear fileBusy — clear it here or every entry button stays disabled forever.
                  setFileBusy(null);
                  setFile(null);
                  if (location) {
                    pendingDirectoryRef.current = c.path;
                    onClearLocation();
                  } else {
                    void loadDir(c.path);
                  }
                }}
              >
                {c.name}
              </button>
            </span>
          ))}
          {file && (
            <span>
              <span className="muted"> / </span>
              <span className="files-crumb is-current">{file.path.split("/").pop()}</span>
            </span>
          )}
        </nav>
        <button
          className="btn ghost sm"
          onClick={() => (file ? void openFile(file.path, location) : void loadDir(path))}
          disabled={disabled || fileBusy !== null}
        >
          {busy || fileBusy ? "Loading…" : "↻ Refresh"}
        </button>
      </div>

      {file ? (
        <div className="files-viewer" ref={viewerRef}>
          <div className="files-viewer-bar source-location-bar">
            {isMarkdownPath(file.path) && !file.binary && (
              <div className="scope-seg" role="radiogroup" aria-label="Markdown View" onKeyDown={(event) => handleRovingChoiceKeyDown(event, "radio")}>
                <button
                  role="radio"
                  aria-checked={rendered}
                  tabIndex={rendered ? 0 : -1}
                  className={`scope-opt${rendered ? " is-active" : ""}`}
                  onClick={() => setRendered(true)}
                >
                  Rendered
                </button>
                <button
                  role="radio"
                  aria-checked={!rendered}
                  tabIndex={!rendered ? 0 : -1}
                  className={`scope-opt${!rendered ? " is-active" : ""}`}
                  onClick={() => setRendered(false)}
                >
                  Source
                </button>
              </div>
            )}
            {!file.binary && (
              <form className="source-symbol-form" onSubmit={(event) => { event.preventDefault(); jumpToSymbol(); }}>
                <label className="sr-only" htmlFor={symbolInputId}>Symbol</label>
                <input
                  id={symbolInputId}
                  value={symbolDraft}
                  maxLength={256}
                  onChange={(event) => setSymbolDraft(event.target.value)}
                  placeholder="Symbol"
                  aria-label="Symbol to Locate"
                />
                <button className="btn ghost sm" type="submit" disabled={!symbolDraft.trim()}>Go</button>
              </form>
            )}
            {location?.path === file.path && (location.line !== undefined || location.symbol !== undefined) && (
              <button className="btn ghost sm" type="button" onClick={() => onOpenLocation({ path: file.path })}>Clear Target</button>
            )}
            {locationEditors.length > 1 && (
              <select
                className="source-editor-select"
                aria-label="Editor for Source Location"
                value={chosenEditor?.id ?? ""}
                onChange={(event) => setSelectedEditor(event.target.value)}
              >
                {locationEditors.map((editor) => <option key={editor.id} value={editor.id}>{editor.name}</option>)}
              </select>
            )}
            {chosenEditor && (
              <button className="btn ghost sm" type="button" disabled={editorBusy || !runnerOnline} onClick={() => void openInEditor()}>
                {editorBusy ? "Opening…" : `Open in ${chosenEditor.name}`}
              </button>
            )}
            <button className="btn ghost sm" type="button" onClick={() => void copyLink()}>Copy Link</button>
            <span className="muted source-file-size">{formatBytes(file.size)}</span>
          </div>
          {note && <div className="hint" role="status">{note}</div>}
          {target?.error && <div className="hint warn" role="status">{target.error}</div>}
          {file.binary ? (
            <div className="hint">Binary file ({formatBytes(file.size)}) — no preview.</div>
          ) : isMarkdownPath(file.path) && rendered ? (
            <div className="files-md">
              <Markdown>{file.content ?? ""}</Markdown>
            </div>
          ) : (
            <pre className="files-text">
              <code>{(file.content ?? "").split("\n").map((line, index) => (
                <SourceLine key={index} text={line.endsWith("\r") ? line.slice(0, -1) : line} line={index + 1} target={target} />
              ))}</code>
            </pre>
          )}
          {file.truncated && (
            <div className="hint warn">Truncated preview — showing the first 512 KB of {formatBytes(file.size)}.</div>
          )}
        </div>
      ) : (
        <ul className="git-files files-list">
          {entries?.map((e) => (
            <li key={e.path}>
              <button
                className="files-entry"
                disabled={disabled || fileBusy !== null}
                onClick={() => (e.isDir ? void loadDir(e.path) : onOpenLocation({ path: e.path }))}
              >
                <span className="files-icon">{e.isDir ? "📁" : "📄"}</span>
                <span className="files-name">{e.name}</span>
                {!e.isDir && <span className="muted files-size">{fileBusy === e.path ? <Spinner /> : formatBytes(e.size)}</span>}
              </button>
            </li>
          ))}
          {entries !== null && entries.length === 0 && <li className="muted">Empty directory.</li>}
          {entries === null && busy && <li className="muted">Loading…</li>}
        </ul>
      )}
    </div>
  );
}
