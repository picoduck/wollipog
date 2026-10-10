import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Notice } from "./Notice.js";
import { SegmentedControl } from "./ui/ChoiceControls.js";
import {
  parseSourceLocation,
  runnerCapabilityRequirement,
  runnerSupportsProtocol,
  type EditorSourceLocation,
  type CreateWorkspaceReferenceRequest,
  type SessionFileEntry,
  type SessionView,
  type SourceLocation,
  type WorkspaceReferenceCandidate,
} from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import {
  GIT_MARKER_LABEL,
  baseName,
  crumbsFor,
  editorSupportsSourceLocation,
  fileIconKind,
  formatBytes,
  gitMarkers,
  isMarkdownPath,
  parentPath,
  rankGoToFileResults,
  resolveSourceTarget,
  workspaceFolderName,
  type GitMarker,
  type GoToFileMatch,
  type ResolvedSourceTarget,
} from "../files-panel.js";
import { relativeTime } from "../format.js";
import { absoluteViewUrl } from "../navigation.js";
import { instancePublicOrigin, useInstances } from "../instances-context.js";
import { runnerDisplay } from "../runners.js";
import { shortcutDisplay } from "../shortcuts.js";
import { useOptionalStoreSelector, useStoreSelector } from "../store.js";
import { Markdown } from "./Markdown.js";
import { Spinner } from "./common.js";
import { CloseIcon, FileCodeIcon, FileIcon, FolderIcon, FolderUpIcon, ImageIcon, RefreshIcon, SearchIcon, SearchOffIcon } from "./Icons.js";
import { PanelToolLayout } from "./PanelToolLayout.js";
import { PanelHeaderActions } from "./RightPanel.js";
import { StaleContent } from "./StaleContent.js";
import { State } from "./State.js";
import type { GitStatus } from "./useGitStatus.js";
import { loadBrowserStorageValue, saveBrowserStorageValue } from "../instance-storage.js";
import { usePanelScratchScope, usePanelScratchText } from "../right-panel-scratch.js";

interface FileView {
  path: string;
  content?: string;
  size?: number;
  truncated?: boolean;
  binary?: boolean;
}

/** How long Go to File waits after the last keystroke before it asks the runner. */
export const GO_TO_FILE_DEBOUNCE_MS = 150;
const RECENT_FILES_LIMIT = 20;

/**
 * Files opened in this visit, most recent first, per session: Go to File ranks them with the changed
 * files (#2852). Kept in memory only, so "earlier in this session" means this page's visit.
 */
const recentFiles = new Map<string, string[]>();

/** "4m ago", or "a moment ago" where `relativeTime` would say "just now". */
function shownAge(at: number): string {
  const age = relativeTime(at);
  return age === "just now" ? "a moment ago" : age;
}

function rememberOpened(sessionId: string, path: string): void {
  const recent = (recentFiles.get(sessionId) ?? []).filter((candidate) => candidate !== path);
  recentFiles.set(sessionId, [path, ...recent].slice(0, RECENT_FILES_LIMIT));
}

/**
 * Ctrl/⌘+P and a keyboard choice of Files in the tool switcher put focus in Go to File (#2852).
 * The field is focused now when it is on screen; otherwise the next Files body to mount takes it,
 * provided it mounts within a second, so a request can never surface on an unrelated later visit.
 */
const goToFileFields = new Set<HTMLInputElement>();
let goToFileFocusRequestedAt: number | null = null;
const GO_TO_FILE_FOCUS_WINDOW_MS = 1000;

export function requestGoToFileFocus(): void {
  const field = [...goToFileFields].find((candidate) => candidate.isConnected);
  if (field) {
    goToFileFocusRequestedAt = null;
    field.focus();
    return;
  }
  goToFileFocusRequestedAt = Date.now();
}

function takeGoToFileFocusRequest(): boolean {
  const requestedAt = goToFileFocusRequestedAt;
  goToFileFocusRequestedAt = null;
  return requestedAt !== null && Date.now() - requestedAt <= GO_TO_FILE_FOCUS_WINDOW_MS;
}

function SourceLine({ text, line, target }: { text: string; line: number; target: ResolvedSourceTarget | null }) {
  const selected = !target?.error && target?.line === line;
  if (!selected || target.column === undefined || target.matchLength === undefined) {
    return <span className={`files-source-line${selected ? " is-target" : ""}`} data-source-line={line} data-line-number={line}>{text || "​"}</span>;
  }
  const start = Math.max(0, Math.min(text.length, target.column - 1));
  const end = Math.max(start, Math.min(text.length, start + target.matchLength));
  return (
    <span className="files-source-line is-target" data-source-line={line} data-line-number={line}>
      {text.slice(0, start)}<mark>{text.slice(start, end) || "​"}</mark>{text.slice(end)}
    </span>
  );
}

/** A row's 16px icon (§18), in `--text-dim` through `.row-icon`. */
function EntryIcon({ name, isDir }: { name: string; isDir: boolean }) {
  const kind = fileIconKind(name, isDir);
  const Icon = kind === "folder" ? FolderIcon : kind === "code" ? FileCodeIcon : kind === "image" ? ImageIcon : FileIcon;
  return <span className="row-icon" aria-hidden="true"><Icon /></span>;
}

/** The quiet A, M or U after a changed file's name; its word is what a screen reader hears. */
function GitMarkerBadge({ marker }: { marker: GitMarker }) {
  return (
    <span className="files-git-marker" data-marker={marker} title={GIT_MARKER_LABEL[marker]}>
      <span aria-hidden="true">{marker}</span>
      <span className="sr-only">{GIT_MARKER_LABEL[marker]}</span>
    </span>
  );
}

/** The matched letters of a Go to File result, underlined. */
function Highlighted({ text, range }: { text: string; range?: { start: number; end: number } }) {
  if (!range) return <>{text}</>;
  return <>{text.slice(0, range.start)}<span className="files-goto-match">{text.slice(range.start, range.end)}</span>{text.slice(range.end)}</>;
}

/** Dense skeleton rows while a folder's first listing loads (§12.3). */
function FilesSkeleton({ status }: { status: string }) {
  return (
    <div className="skeleton files-skeleton" role="status" aria-live="polite">
      <span className="sr-only">{status}</span>
      {[0, 1, 2, 3, 4].map((index) => (
        <div className="row dense" key={index} aria-hidden="true">
          <span className="skeleton-bar title" />
          <span className="skeleton-bar" />
        </div>
      ))}
    </div>
  );
}

/**
 * Files browser: browse the session's working directory (worktree or repo — the runner resolves
 * the root from box meta) and view files in place; markdown renders formatted, everything else
 * as plain text. Hosted by the right side panel's "Files" mode; lists the root on mount. Read-only —
 * the Git/Review panel owns the change/commit story.
 *
 * Laid out on the panel's slots (#2852, §4.9): Go to File is the toolbar, fixed above the one
 * scroller that holds the path row, the folder's dense rows (§5.2) or the viewer, and, while the
 * field has text, the matching files instead. Refresh is the header's one action.
 */
export function FilesBrowser({
  session,
  runnerOnline,
  runnerProtocolVersion,
  location,
  git,
  onOpenLocation,
  onClearLocation,
  onAttachWorkspaceReference,
}: {
  session: SessionView;
  runnerOnline: boolean;
  runnerProtocolVersion: number | null | undefined;
  location?: SourceLocation;
  /** The session's shared git status read: changed files carry a marker and rank first. */
  git?: GitStatus;
  onOpenLocation: (location: SourceLocation) => void;
  onClearLocation: () => void;
  onAttachWorkspaceReference?: (target: CreateWorkspaceReferenceRequest) => Promise<void>;
}) {
  const api = useApi();
  const instances = useInstances();
  // Current directory, root-relative ("" = root). Remembered per session so switching the panel to
  // another mode and back resumes where the browsing left off instead of at the root (#1202).
  const panelScratch = usePanelScratchScope(session.id);
  const [path, setPath] = usePanelScratchText(panelScratch, "files.directory");
  const [entries, setEntries] = useState<SessionFileEntry[] | null>(null);
  // When the rows on screen were listed and the open file was read, for the offline line's
  // "This list is from 4m ago".
  const [listedAt, setListedAt] = useState<number | null>(null);
  const [readAt, setReadAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<FileView | null>(null);
  const [fileBusy, setFileBusy] = useState<string | null>(null);
  const [rendered, setRendered] = useState(true); // markdown: rendered vs source
  const [symbolDraft, setSymbolDraft] = useState(location?.symbol ?? "");
  const [note, setNote] = useState<string | null>(null);
  const [editorBusy, setEditorBusy] = useState(false);
  const [attachBusy, setAttachBusy] = useState(false);
  const [selectedEditor, setSelectedEditor] = useState<string | null>(() => {
    return loadBrowserStorageValue("wollipog.editor.lastUsed");
  });
  const symbolInputId = `source-symbol-${useId().replace(/:/g, "")}`;
  const goToFileId = `go-to-file-${useId().replace(/:/g, "")}`;
  // Monotonic token: fast navigation fires overlapping loads; only the latest writes state
  // (same race stance as GitPanel's diff loader).
  const reqRef = useRef(0);
  const viewerRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLInputElement>(null);
  const pendingDirectoryRef = useRef<string | null>(null);
  // The directory this mount resumes into, retired by the first listing that actually resolves —
  // NOT by the first pass of the effect below, which React runs twice under StrictMode. Once a
  // listing has happened, later ones — clearing a source location, arriving from Back/Forward —
  // keep their established meaning of returning to the root.
  const resumeDirectoryRef = useRef<string | null>(path || null);
  const runner = useStoreSelector((state) => state.runners.get(session.runnerId));
  const isRemote = useStoreSelector((state) => [...state.boxes.values()].some((box) => box.runnerId === session.runnerId));
  const machineName = useOptionalStoreSelector((state) => runnerDisplay(
    state.runners.get(session.runnerId),
    [...state.boxes.values()].find((box) => box.runnerId === session.runnerId),
    session.runnerId,
  ).name) || "The machine";
  const rootName = workspaceFolderName(session.worktreePath, session.workspaceName);

  // Go to File (#2852): the query, the runner's last answer for it, and the active result.
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<{ query: string; results: WorkspaceReferenceCandidate[]; truncated: boolean } | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  // Enter pressed before the answer for what is typed arrived: open its first match when it does.
  const [openOnAnswer, setOpenOnAnswer] = useState(false);
  const searchRef = useRef(0);
  const searchSupported = runnerSupportsProtocol(runnerProtocolVersion, "workspaceReferences");
  const trimmedQuery = query.trim();
  const searching = trimmedQuery !== "";
  // The rows on screen answer what is typed. Until the next answer lands, the previous rows stay
  // (§12.3), but nothing can be opened from them: they may not match the query any more.
  const answered = search !== null && search.query === trimmedQuery;

  /** Reports the outcome so a caller can react to a listing that failed rather than one it lost. */
  const loadDir = useCallback(async (dir: string): Promise<"listed" | "failed" | "superseded"> => {
    const reqId = ++reqRef.current;
    setBusy(true);
    setError(null);
    try {
      const d = await api.listSessionFiles(session.id, dir);
      if (reqRef.current !== reqId) return "superseded";
      setPath(d.path);
      setEntries(d.entries);
      setListedAt(Date.now());
      return "listed";
    } catch (e) {
      if (reqRef.current !== reqId) return "superseded";
      setError((e as Error).message);
      return "failed";
    } finally {
      // Only the listing that is still current retires the resume. One superseded by an opened file
      // or a newer listing did not land, so the directory it was resuming into is still owed.
      if (reqRef.current === reqId) {
        resumeDirectoryRef.current = null;
        setBusy(false);
      }
    }
  }, [api, session.id, setPath]);

  const openFile = useCallback(async (p: string, requested?: SourceLocation) => {
    const reqId = ++reqRef.current;
    // A listing this read supersedes (Go to File can open a file while the folder still loads) will
    // never clear its own busy state; nothing is listing any more.
    setBusy(false);
    setFileBusy(p);
    setError(null);
    try {
      const d = await api.readSessionFile(session.id, p);
      if (reqRef.current !== reqId) return;
      setFile({ ...d, path: d.path || p });
      setReadAt(Date.now());
      rememberOpened(session.id, d.path || p);
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
    const resumeDirectory = resumeDirectoryRef.current;
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
      const nextDirectory = pendingDirectoryRef.current ?? resumeDirectory ?? "";
      pendingDirectoryRef.current = null;
      const resumed = nextDirectory !== "" && nextDirectory === resumeDirectory;
      void loadDir(nextDirectory).then((outcome) => {
        // A remembered directory can be gone by the time the panel reopens (a branch switch, the
        // agent deleting it). Fall back to the root listing rather than stranding the browser on
        // an error with nothing to navigate from.
        if (resumed && outcome === "failed") void loadDir("");
      });
    }
  }, [file?.path, loadDir, location, openFile]);

  // The field registers itself so Ctrl/⌘+P can focus it, and takes a focus request made before this
  // body mounted. A passive effect, so the panel has already recorded the control that opened it.
  useEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    goToFileFields.add(field);
    if (takeGoToFileFocusRequest()) field.focus();
    return () => {
      goToFileFields.delete(field);
    };
  }, []);

  // Ask the runner's bounded search once typing pauses. Only the latest query's answer lands.
  useEffect(() => {
    const id = ++searchRef.current;
    setSearchError(null);
    if (!trimmedQuery || !searchSupported) {
      setSearch(null);
      return;
    }
    const timer = window.setTimeout(() => {
      api.searchWorkspaceReferences(session.id, trimmedQuery).then((result) => {
        if (searchRef.current !== id) return;
        setSearch({ query: trimmedQuery, results: result.results, truncated: result.truncated });
        setActive(0);
      }, (cause: unknown) => {
        if (searchRef.current !== id) return;
        // No rows outlive a failed search, so none can be opened or named as active.
        setSearch(null);
        setSearchError((cause as Error).message);
        setOpenOnAnswer(false);
      });
    }, GO_TO_FILE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [api, searchSupported, session.id, trimmedQuery]);

  const markers = useMemo(() => gitMarkers(git?.status?.files), [git?.status?.files]);
  const matches = useMemo<GoToFileMatch[]>(() => {
    if (!search) return [];
    const recent = new Set(recentFiles.get(session.id) ?? []);
    return rankGoToFileResults(search.results, search.query, (candidate) => markers.has(candidate) || recent.has(candidate));
  }, [markers, search, session.id]);
  const activeIndex = answered && matches.length ? Math.min(active, matches.length - 1) : -1;
  const listShown = searching && search !== null && searchError === null && matches.length > 0;
  const optionId = (index: number) => `${goToFileId}-option-${index}`;

  useEffect(() => {
    if (activeIndex < 0) return;
    document.getElementById(optionId(activeIndex))?.scrollIntoView?.({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex]);

  const clearQuery = () => {
    setQuery("");
    setActive(0);
    setOpenOnAnswer(false);
  };
  const openMatch = (match: GoToFileMatch) => {
    clearQuery();
    onOpenLocation({ path: match.path });
  };
  useEffect(() => {
    if (!openOnAnswer || !answered) return;
    setOpenOnAnswer(false);
    if (matches[0]) openMatch(matches[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answered, matches, openOnAnswer]);
  const onFieldKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!answered || !matches.length) return;
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((Math.max(0, activeIndex) + step + matches.length) % matches.length);
    } else if (event.key === "Enter") {
      if (!searching || searchError !== null || !searchSupported) return;
      event.preventDefault();
      if (!answered) {
        setOpenOnAnswer(true);
        return;
      }
      const match = matches[activeIndex];
      if (match) openMatch(match);
    } else if (event.key === "Escape" && query !== "") {
      // Escape clears the field first; with the field empty it falls through to the panel's own
      // ladder (§16.2, #2843): restore an expanded panel, then close it.
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      event.preventDefault();
      clearQuery();
    }
  };

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
  const attachCurrentTarget = async () => {
    if (!file || file.binary || !onAttachWorkspaceReference) return;
    const selection = viewerRef.current?.ownerDocument.getSelection();
    const selectedLines: number[] = [];
    if (selection && !selection.isCollapsed && viewerRef.current &&
        selection.anchorNode && selection.focusNode && viewerRef.current.contains(selection.anchorNode) &&
        viewerRef.current.contains(selection.focusNode)) {
      const lineFor = (node: Node): number | null => {
        const element = node instanceof Element ? node : node.parentElement;
        const line = element?.closest<HTMLElement>("[data-source-line]")?.dataset.sourceLine;
        const parsed = Number(line);
        return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
      };
      const anchor = lineFor(selection.anchorNode);
      const focus = lineFor(selection.focusNode);
      if (anchor !== null && focus !== null) selectedLines.push(anchor, focus);
    }
    setAttachBusy(true);
    try {
      await onAttachWorkspaceReference(selectedLines.length
        ? { path: file.path, kind: "lines", startLine: Math.min(...selectedLines), endLine: Math.max(...selectedLines) }
        : { path: file.path, kind: "file" });
    } finally {
      setAttachBusy(false);
    }
  };

  const folder = file ? parentPath(file.path) : path;
  const crumbs = crumbsFor(folder, rootName);
  const disabled = !runnerOnline || busy;
  const atRoot = !file && path === "";

  /** Shows a folder: from the viewer, through the route (the route owns the open file). */
  const showFolder = (dir: string) => {
    // A crumb can supersede an in-flight file read (crumbs stay enabled while fileBusy). The
    // superseded read's finally is token-guarded and will NOT clear fileBusy — clear it here or
    // every entry button stays disabled forever.
    setFileBusy(null);
    setFile(null);
    if (location) {
      pendingDirectoryRef.current = dir;
      onClearLocation();
    } else {
      void loadDir(dir);
    }
  };
  const refresh = () => {
    if (file) void openFile(file.path, location);
    else void loadDir(path);
    if (runnerOnline) void git?.refresh();
  };
  const refreshing = busy || fileBusy !== null;
  const shownAt = file ? readAt : entries !== null ? listedAt : null;

  const goToFileField = (
    <div className="toolbar">
      <div className="input-affix files-goto">
        <span className="input-affix-text" aria-hidden="true"><SearchIcon size={14} /></span>
        <input
          ref={fieldRef}
          id={goToFileId}
          type="text"
          role="combobox"
          aria-label="Go to File"
          aria-autocomplete="list"
          aria-expanded={listShown}
          aria-controls={listShown ? `${goToFileId}-results` : undefined}
          aria-activedescendant={listShown && activeIndex >= 0 ? optionId(activeIndex) : undefined}
          title="Finds files whose name or path contains the text."
          placeholder="Go to file"
          value={query}
          maxLength={256}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            setOpenOnAnswer(false);
          }}
          onKeyDown={onFieldKeyDown}
        />
        {query ? (
          <span className="input-affix-text files-goto-clear">
            <button
              type="button"
              className="icon-btn sm"
              aria-label="Clear Go to File"
              title="Clear Go to File"
              onClick={() => {
                clearQuery();
                fieldRef.current?.focus();
              }}
            >
              <CloseIcon size={14} />
            </button>
          </span>
        ) : (
          <span className="input-affix-text" aria-hidden="true"><kbd>{shortcutDisplay("open-files")}</kbd></span>
        )}
      </div>
    </div>
  );

  let results: ReactNode = null;
  if (searching) {
    const matchCount = `${matches.length} ${matches.length === 1 ? "match" : "matches"} in ${rootName}`;
    results = !searchSupported ? (
      <Notice tone="neutral" compact role="status">{runnerCapabilityRequirement(runnerProtocolVersion, "workspaceReferences", "Go to File")}</Notice>
    ) : searchError ? (
      <Notice tone="danger" compact>{searchError}</Notice>
    ) : !search ? (
      <FilesSkeleton status="Finding files…" />
    ) : matches.length === 0 && !search.truncated ? (
      <State
        compact
        variant="no-results"
        icon={<SearchOffIcon />}
        title="No Matching Files"
        actions={(
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              clearQuery();
              fieldRef.current?.focus();
            }}
          >
            Clear Filter
          </button>
        )}
      >
        Nothing in {rootName} matches that name.
      </State>
    ) : (
      <div className="files-content">
        <p className="files-goto-count" role="status">
          {search.truncated ? "Showing the first matches only. Type more to narrow them." : matchCount}
        </p>
        {/* Options are not tab stops: the field keeps focus and names the active one (§16.2). */}
        <ul className="files-list" role="listbox" id={`${goToFileId}-results`} aria-label="Matching Files" aria-busy={!answered || undefined}>
          {matches.map((match, index) => (
            <li
              key={match.path}
              id={optionId(index)}
              role="option"
              aria-selected={index === activeIndex}
              className={`row dense files-goto-option${index === activeIndex ? " is-selected" : ""}`}
              title={match.path}
              // Keep focus in the field, so the listbox stays its popup.
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => { if (index !== activeIndex) setActive(index); }}
              // Rows kept from an earlier query wait for the answer to what is typed (#2852).
              onClick={() => { if (answered) openMatch(match); }}
            >
              <EntryIcon name={match.name} isDir={false} />
              <span className="row-title files-goto-name">
                <Highlighted text={match.name} range={match.matchIn === "name" ? match.range : undefined} />
              </span>
              {match.folder && (
                <span className="files-goto-folder">
                  <Highlighted text={match.folder} range={match.matchIn === "folder" ? match.range : undefined} />
                </span>
              )}
              {markers.has(match.path) && <GitMarkerBadge marker={markers.get(match.path)!} />}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const pathRow = (
    <div className="files-path">
      <button
        type="button"
        className="icon-btn sm"
        aria-label="Up One Folder"
        title="Up One Folder"
        disabled={atRoot || (disabled && !file)}
        onClick={() => showFolder(file ? folder : parentPath(path))}
      >
        <FolderUpIcon />
      </button>
      <nav className="crumbs" aria-label="Path">
        {crumbs.map((c, i) => (
          <span key={c.path}>
            {i > 0 && <span className="crumb-sep" aria-hidden="true">/</span>}
            {!file && i === crumbs.length - 1 ? (
              <span className="crumb is-current" aria-current="location">{c.name}</span>
            ) : (
              <button className="crumb" type="button" disabled={disabled && !file} onClick={() => showFolder(c.path)}>
                {c.name}
              </button>
            )}
          </span>
        ))}
        {file && (
          <span>
            <span className="crumb-sep" aria-hidden="true">/</span>
            <span className="crumb is-current" aria-current="page">{baseName(file.path)}</span>
          </span>
        )}
      </nav>
    </div>
  );

  const folderName = crumbs[crumbs.length - 1]!.name;
  const parentCrumb = crumbs.length > 1 ? crumbs[crumbs.length - 2]! : null;
  const listing = entries === null
    ? (busy && runnerOnline ? <FilesSkeleton status="Loading files…" /> : null)
    : entries.length === 0 ? (
      <State
        compact
        icon={<FolderIcon size={24} />}
        title="Empty Folder"
        actions={parentCrumb && (
          <button type="button" className="btn sm" disabled={disabled} onClick={() => showFolder(parentCrumb.path)}>
            {`Up to ${parentCrumb.name}`}
          </button>
        )}
      >
        {folderName} has no files yet.
      </State>
    ) : (
      <ul className="files-list" aria-label={`Files in ${folderName}`}>
        {entries.map((e) => {
          const marker = e.isDir ? undefined : markers.get(e.path);
          return (
            <li key={e.path}>
              <button
                type="button"
                className="row dense"
                disabled={disabled || fileBusy !== null}
                onClick={() => (e.isDir ? void loadDir(e.path) : onOpenLocation({ path: e.path }))}
              >
                <EntryIcon name={e.name} isDir={e.isDir} />
                <span className="row-title">{e.name}</span>
                {marker && <GitMarkerBadge marker={marker} />}
                {!e.isDir && <span className="row-trail">{fileBusy === e.path ? <Spinner /> : formatBytes(e.size)}</span>}
              </button>
            </li>
          );
        })}
      </ul>
    );

  return (
    <>
      <PanelHeaderActions>
        <button
          type="button"
          className="icon-btn"
          aria-label="Refresh Files"
          title="Refresh Files"
          aria-busy={refreshing || undefined}
          disabled={refreshing || !runnerOnline}
          onClick={refresh}
        >
          {refreshing ? <Spinner decorative /> : <RefreshIcon />}
        </button>
      </PanelHeaderActions>
      <PanelToolLayout toolbar={goToFileField}>
        <div className="files-browser">
          {/* Notices first, at the top of the scroller (§13.2): each is one compact line. */}
          {!runnerOnline && (
            <Notice tone="warning" compact role="status">
              {shownAt === null
                ? `${machineName} is offline. Files load when it reconnects.`
                : `${machineName} is offline. This ${file ? "file" : "list"} is from ${shownAge(shownAt)}.`}
            </Notice>
          )}
          {error && <Notice tone="danger" compact>{error}</Notice>}

          {searching ? results : (
            // While the runner is offline the last-known folder stays readable, dimmed (§12.5).
            <StaleContent stale={!runnerOnline} className="files-content">
              {pathRow}
              {file ? (
                <div className="files-viewer" ref={viewerRef}>
                  <div className="files-viewer-bar source-location-bar">
                    {isMarkdownPath(file.path) && !file.binary && (
                      <SegmentedControl
                        className="sm"
                        label="Markdown View"
                        value={rendered ? "rendered" : "source"}
                        options={[{ value: "rendered", label: "Rendered" }, { value: "source", label: "Source" }]}
                        onChange={(view) => setRendered(view === "rendered")}
                      />
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
                    {onAttachWorkspaceReference && !file.binary && (
                      <button className="btn ghost sm" type="button" disabled={attachBusy || !runnerOnline} onClick={() => void attachCurrentTarget()}>
                        {attachBusy ? "Attaching…" : "Attach to Prompt"}
                      </button>
                    )}
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
              ) : listing}
            </StaleContent>
          )}
        </div>
      </PanelToolLayout>
    </>
  );
}
