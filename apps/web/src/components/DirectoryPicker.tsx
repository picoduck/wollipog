import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { runnerSupportsProtocol, type DirectoryEntry } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { folderCrumbs } from "../folder-crumbs.js";
import { ChevronRightIcon, EditIcon, FolderIcon, FolderUpIcon } from "./Icons.js";
import { Notice } from "./Notice.js";

/** A listing that takes longer than this shows skeleton rows; a faster one keeps the previous
 * rows until it lands (§12.3). */
export const FOLDER_PICKER_SKELETON_DELAY_MS = 300;

/** True once `active` has held for `delayMs`, so a fast listing never flashes a skeleton. */
function useDelayedFlag(active: boolean, delayMs: number): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) {
      setShown(false);
      return;
    }
    const timer = window.setTimeout(() => setShown(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [active, delayMs]);
  return active && shown;
}

interface Listing {
  path: string;
  parent: string | null;
  entries: DirectoryEntry[];
}

interface DirectoryPickerProps {
  runnerId: string;
  /** The machine's name, for the description and the notices that say whose folders these are. */
  machineName: string;
  protocolVersion: number | null | undefined;
  distro?: string;
  onPick: (path: string) => void;
  onCancel: () => void;
  /** The folder Use This Folder would pick (the typed path on a runner that cannot list folders),
   * or null while there is none. For a dialog or form that owns the actions (`hideActions`). */
  onLocationChange?: (path: string | null) => void;
  hideActions?: boolean;
}

/**
 * Browse the runner machine's filesystem (native host or a WSL distro) and pick a folder (#2956,
 * docs/design-system.md §4.8, §5.2, §12.3, §13.2): a breadcrumb from the home folder with Edit Path,
 * one row per folder, and a failed path that keeps the last listing under a notice. Escape belongs
 * to whatever hosts the picker, except inside an open Edit Path field, where it restores the trail.
 */
export function DirectoryPicker(props: DirectoryPickerProps) {
  // Another machine's or distro's folders start from its own home, with nothing carried over.
  return <FolderBrowser key={`${props.runnerId}\0${props.distro ?? ""}`} {...props} />;
}

function FolderBrowser({
  runnerId,
  machineName,
  protocolVersion,
  distro,
  onPick,
  onCancel,
  onLocationChange,
  hideActions = false,
}: DirectoryPickerProps) {
  const api = useApi();
  const supported = runnerSupportsProtocol(protocolVersion, "directoryListing");
  // `path` "" asks for the runner's home folder; `fromField` is a path typed into Edit Path.
  const [request, setRequest] = useState({ id: 0, path: "", fromField: false });
  const [settledId, setSettledId] = useState(-1);
  const [listing, setListing] = useState<Listing | null>(null);
  const [home, setHome] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ path: string; message: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [pathInput, setPathInput] = useState("");
  const loading = supported && settledId !== request.id;
  const showSkeleton = useDelayedFlag(loading, FOLDER_PICKER_SKELETON_DELAY_MS);
  const pathFieldId = useId();
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const pathInputRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    api
      .listDirectory(runnerId, request.path, distro)
      .then((result) => {
        if (cancelled) return;
        setListing(result);
        setFailure(null);
        if (request.path === "") setHome((current) => current ?? result.path);
        if (request.fromField) setEditing(false);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setFailure({ path: request.path, message: cause instanceof Error ? cause.message : String(cause) });
      })
      .finally(() => {
        if (!cancelled) setSettledId(request.id);
      });
    return () => {
      cancelled = true;
    };
  }, [api, runnerId, distro, supported, request]);

  // With no folder listed yet, a failed home folder leaves the path field as the only way on.
  const fieldOpen = editing || (supported && listing === null && failure !== null);
  // Use This Folder picks the last folder that listed, never one still loading.
  const selection = supported ? (loading ? null : listing?.path ?? null) : pathInput.trim() || null;
  const onLocationChangeRef = useRef(onLocationChange);
  onLocationChangeRef.current = onLocationChange;
  useEffect(() => { onLocationChangeRef.current?.(selection); }, [selection]);

  // Closing the field (Escape, or a typed path that listed) would drop focus on <body>, outside
  // the host dialog's Tab trap; Edit Path, which opened it, takes it back.
  const wasEditing = useRef(false);
  useEffect(() => {
    if (editing && !wasEditing.current) pathInputRef.current?.focus();
    if (!editing && wasEditing.current) {
      const active = document.activeElement;
      if (!active || active === document.body) editButtonRef.current?.focus();
    }
    wasEditing.current = editing;
  }, [editing]);

  // A crumb that becomes the current folder turns into plain text, and a row is replaced by the
  // next folder's rows or the skeleton, so a keyboard press that opens a folder would leave focus
  // on <body>, outside the host dialog's Tab trap. The opened folder's first row takes it instead,
  // with Edit Path holding it while skeleton rows show. Set by a press inside the picker; cleared
  // once that folder has settled.
  const keepFocus = useRef<{ holder: HTMLElement | null } | null>(null);
  useLayoutEffect(() => {
    const pending = keepFocus.current;
    if (!pending) return;
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected || active === pending.holder) {
      const row = pickerRef.current?.querySelector<HTMLElement>(".folder-picker-list > .row") ?? null;
      const target = row ?? editButtonRef.current;
      if (target && target !== active) target.focus();
      pending.holder = row ? null : target;
    }
    if (!loading) keepFocus.current = null;
  });

  const open = (path: string, fromField = false) => {
    if (!fromField) setEditing(false);
    // A typed path's field hands focus back to Edit Path itself (above).
    keepFocus.current = !fromField && pickerRef.current?.contains(document.activeElement) ? { holder: null } : null;
    setRequest((current) => ({ id: current.id + 1, path, fromField }));
  };
  const go = () => {
    const typed = pathInput.trim();
    if (typed) open(typed, true);
  };

  const actions = !hideActions && (
    <div className="folder-picker-actions">
      <button type="button" className="btn sm" onClick={onCancel}>
        Cancel
      </button>
      <button type="button" className="btn primary sm" disabled={selection === null}
        onClick={() => { if (selection !== null) onPick(selection); }}>
        {supported ? "Use This Folder" : "Use Path"}
      </button>
    </div>
  );

  if (!supported) {
    return (
      <div className="folder-picker">
        <Notice tone="warning" title="Browsing Needs an Update">
          Update Wollipog on {machineName} to browse its folders. You can still type a path.
        </Notice>
        <div className="field">
          <label className="field-label" htmlFor={pathFieldId}>Path</label>
          <input
            id={pathFieldId}
            className="input folder-picker-path"
            value={pathInput}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder="Type or paste a folder path"
            onChange={(event) => setPathInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && selection !== null) {
                event.preventDefault();
                onPick(selection);
              }
            }}
          />
        </div>
        {actions}
      </div>
    );
  }

  const crumbs = listing ? folderCrumbs(listing.path, home) : [];
  return (
    <div className="folder-picker" ref={pickerRef}>
      <div className="folder-picker-bar">
        {fieldOpen ? (
          <>
            <input
              ref={pathInputRef}
              className="input folder-picker-path"
              aria-label="Path"
              value={pathInput}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              placeholder="Type or paste a folder path"
              onChange={(event) => setPathInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  go();
                } else if (event.key === "Escape" && listing) {
                  // Claimed here, so the dialog hosting the picker stays open (Modal checks
                  // defaultPrevented).
                  event.preventDefault();
                  setEditing(false);
                }
              }}
            />
            <button type="button" className="btn" disabled={!pathInput.trim()} onClick={go}>
              Go
            </button>
          </>
        ) : (
          <>
            <nav className="crumbs" aria-label="Path">
              {crumbs.map((crumb, index) => (
                <span className="folder-picker-crumb" key={crumb.path}>
                  {index > 0 && (
                    <span className="crumb-sep" aria-hidden="true"><ChevronRightIcon size={14} /></span>
                  )}
                  {index === crumbs.length - 1 ? (
                    <span className="crumb is-current" aria-current="location" title={crumb.path}>{crumb.name}</span>
                  ) : (
                    <button type="button" className="crumb" title={crumb.path} onClick={() => open(crumb.path)}>
                      {crumb.name}
                    </button>
                  )}
                </span>
              ))}
            </nav>
            <button
              ref={editButtonRef}
              type="button"
              className="icon-btn sm"
              aria-label="Edit Path"
              title="Edit Path"
              onClick={() => {
                setPathInput(listing?.path ?? "");
                setEditing(true);
              }}
            >
              <EditIcon />
            </button>
          </>
        )}
      </div>
      {failure && (
        <Notice compact tone="danger" role="alert" details={<code>{failure.message}</code>}>
          Can't open {failure.path || "the home folder"} on {machineName}.{" "}
          {listing ? "Check the path, or pick a folder below." : "Check the path and try again."}
        </Notice>
      )}
      {showSkeleton ? (
        <div className="skeleton folder-picker-skeleton" role="status" aria-live="polite">
          <span className="sr-only">Loading folders…</span>
          {[0, 1, 2, 3, 4].map((index) => (
            <div className="row" key={index} aria-hidden="true">
              <span className="skeleton-bar title" />
            </div>
          ))}
        </div>
      ) : listing && (
        <div className="folder-picker-list">
          {listing.parent != null && (
            <button type="button" className="row" title={listing.parent} onClick={() => open(listing.parent!)}>
              <span className="row-icon"><FolderUpIcon size={16} /></span>
              <span className="row-title">Up One Level</span>
            </button>
          )}
          {listing.entries.length === 0 ? (
            <p className="folder-picker-empty">No subfolders here. You can still use this folder.</p>
          ) : listing.entries.map((entry) => (
            <button type="button" className="row" key={entry.path} title={entry.path} onClick={() => open(entry.path)}>
              <span className="row-icon"><FolderIcon size={16} /></span>
              <span className="row-title">{entry.name}</span>
            </button>
          ))}
        </div>
      )}
      {actions}
    </div>
  );
}
