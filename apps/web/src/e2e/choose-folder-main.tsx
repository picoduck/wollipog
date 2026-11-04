import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { RUNNER_CAPABILITY_MIN_PROTOCOL } from "@wollipog/protocol";
import type { ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { ChooseFolderDialog } from "../components/ChooseFolderDialog.js";
import { Modal } from "../components/Modal.js";
import "../styles.css";

/**
 * Choose Folder (#2956) in a real browser, where row heights, the coarse-pointer tokens and which
 * element scrolls are layout rather than numbers a DOM test supplies.
 *
 * A New Workspace-shaped form with Browse…, which stacks Choose Folder over it. The machine's home
 * folder holds enough folders to overflow a phone sheet, one empty folder (`notes`) and a nested
 * repository; any other path fails with the runner's message. `?runner=old` is a runner too old to
 * list folders, `?theme=light` switches theme, and `?open=1` opens Choose Folder on load. Chosen by
 * query string so every state is a clean reload.
 */

const params = new URLSearchParams(window.location.search);
document.documentElement.setAttribute("data-theme", params.get("theme") === "light" ? "light" : "dark");
const protocolVersion = RUNNER_CAPABILITY_MIN_PROTOCOL.directoryListing - (params.get("runner") === "old" ? 1 : 0);

const HOME = "/home/ada";
const HOME_FOLDERS = [
  "notes", "repos", "archive", "billing-service", "client-portal", "data-pipelines", "design-system",
  "docs-site", "infrastructure", "marketing-site", "mobile-app", "playground", "release-tools",
  "research", "scratch", "terraform-modules",
];
const FOLDERS: Record<string, { parent: string | null; entries: string[] }> = {
  "/": { parent: null, entries: ["home", "srv"] },
  "/home": { parent: "/", entries: ["ada"] },
  [HOME]: { parent: "/home", entries: HOME_FOLDERS },
  [`${HOME}/repos`]: { parent: HOME, entries: ["wollipog", "wollipog-desktop"] },
  [`${HOME}/repos/wollipog`]: { parent: `${HOME}/repos`, entries: ["apps", "docs", "packages", "scripts"] },
};

function folderAt(path: string) {
  if (FOLDERS[path]) return FOLDERS[path];
  // Every other folder in home is empty.
  return HOME_FOLDERS.some((name) => path === `${HOME}/${name}`) ? { parent: HOME, entries: [] } : null;
}

const client = {
  listDirectory: async (_runnerId: string, path: string) => {
    const at = path || HOME;
    const folder = folderAt(at);
    if (!folder) throw new Error(`cannot read directory: ${at}`);
    return {
      path: at,
      parent: folder.parent,
      entries: folder.entries.map((name) => ({ name, path: `${at === "/" ? "" : at}/${name}`, isDir: true })),
    };
  },
} as unknown as ApiClient;

function Harness() {
  const [folder, setFolder] = useState("");
  const [choosing, setChoosing] = useState(params.get("open") === "1");
  const browseRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Modal title="New Workspace" onClose={() => undefined}>
        <div className="field">
          <label className="field-label" htmlFor="folder">Folder</label>
          <div className="folder-field-row">
            <input id="folder" className="input folder-field-path is-read-only" value={folder} readOnly placeholder="No folder chosen" />
            <button ref={browseRef} type="button" className="btn" onClick={() => setChoosing(true)}>Browse…</button>
          </div>
        </div>
      </Modal>
      {choosing && (
        <ChooseFolderDialog
          runnerId="runner-1"
          machineName="Build Box"
          protocolVersion={protocolVersion}
          returnFocusRef={browseRef}
          onClose={() => setChoosing(false)}
          onPick={(path) => {
            setFolder(path);
            setChoosing(false);
          }}
        />
      )}
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <ApiProvider client={client}>
    <Harness />
  </ApiProvider>,
);
