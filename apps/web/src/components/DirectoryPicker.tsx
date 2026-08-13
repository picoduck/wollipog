import { useEffect, useState } from "react";
import {
  runnerCapabilityRequirement,
  runnerSupportsProtocol,
  type DirectoryEntry,
} from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { FolderOutlineIcon, FolderUpIcon } from "./Icons.js";
import { Spinner } from "./common.js";

interface Listing {
  path: string;
  parent: string | null;
  entries: DirectoryEntry[];
}

/** Browse the runner machine's filesystem (native host or a WSL distro) and pick a directory to use
 * as the session's workspace — for choosing a repo on a remote box without preconfiguring it. */
export function DirectoryPicker({
  runnerId,
  protocolVersion,
  distro,
  onPick,
  onCancel,
}: {
  runnerId: string;
  protocolVersion: number | null | undefined;
  distro?: string;
  onPick: (path: string) => void;
  onCancel: () => void;
}) {
  const api = useApi();
  const [path, setPath] = useState(""); // "" ⇒ the runner's $HOME
  const [pathInput, setPathInput] = useState(""); // the editable path field (typed/pasted)
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const supported = runnerSupportsProtocol(protocolVersion, "directoryListing");
  const unsupported = runnerCapabilityRequirement(protocolVersion, "directoryListing", "Directory browsing");

  useEffect(() => {
    if (!supported) {
      setListing(null);
      setLoading(false);
      setError(unsupported);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    // Drop the previous listing so "Use This Folder" (disabled when there's no listing) can't select a
    // stale directory while the new lookup is in flight or after it fails.
    setListing(null);
    api
      .listDirectory(runnerId, path, distro)
      .then((r) => {
        if (cancelled) return;
        setListing(r);
        setPathInput(r.path); // reflect where we actually landed
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, runnerId, path, distro, supported, unsupported]);

  // Escape closes just the browser, wherever focus is (e.g. still on the "Browse…" button after a
  // mouse click). A capture-phase window listener runs before the Modal's bubble-phase Escape
  // handler, and preventDefault tells the Modal (which checks defaultPrevented) to stand down.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const go = () => {
    const p = pathInput.trim();
    if (p) setPath(p);
  };

  return (
    <div className="dir-picker">
      <div className="dir-path-row">
        <input
          className="dir-path-input"
          value={pathInput}
          disabled={!supported}
          spellCheck={false}
          placeholder="Type or paste a path, then Enter…"
          onChange={(e) => setPathInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              go();
            }
          }}
        />
        <button type="button" className="btn ghost sm" onClick={go} disabled={!supported || loading}>
          {loading ? <Spinner /> : "Go"}
        </button>
      </div>
      {error && <div className="form-error dir-error">{error}</div>}
      <div className="dir-list">
        {loading && !listing && <div className="muted dir-empty">Loading…</div>}
        {listing?.parent != null && (
          <button type="button" className="dir-entry up" onClick={() => setPath(listing.parent!)}>
            <span className="dir-icon">
              <UpIcon />
            </span>
            <span className="dir-name">..</span>
          </button>
        )}
        {listing && listing.entries.length === 0 && !error && (
          <div className="muted dir-empty">No Sub-Folders Here</div>
        )}
        {listing?.entries.map((e) => (
          <button type="button" key={e.path} className="dir-entry" onClick={() => setPath(e.path)} title={e.path}>
            <span className="dir-icon">
              <FolderOutlineIcon size={13} />
            </span>
            <span className="dir-name">{e.name}</span>
          </button>
        ))}
      </div>
      <div className="dir-actions">
        <button type="button" className="btn ghost sm" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn primary sm"
          disabled={!listing}
          onClick={() => listing && onPick(listing.path)}
        >
          Use This Folder
        </button>
      </div>
    </div>
  );
}


function UpIcon() {
  return (
    <FolderUpIcon size={13} />
  );
}
