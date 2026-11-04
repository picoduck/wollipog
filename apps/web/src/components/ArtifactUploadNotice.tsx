import React, { useState } from "react";
import { useInstanceScope } from "../instance-scope.js";
import { loadInstanceStorageValue, saveInstanceStorageValue } from "../instance-storage.js";
import { viewPath } from "../navigation.js";
import { useHasStore, useStoreActions } from "../store.js";
import { Notice } from "./Notice.js";

export const ARTIFACT_UPLOAD_NOTICE_KEY = "wollipog.artifact-upload-notice.v1.dismissed";
const settingsView = { name: "settings", section: "behavior" } as const;

function SettingsLink() {
  const { navigate } = useStoreActions();
  return <a className="btn sm" href={viewPath(settingsView)} onClick={(event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(settingsView);
  }}>Upload Settings</a>;
}

/**
 * The Artifacts tab's one compact line until it is dismissed (#3039, §13.2 Compact): that private
 * uploads exist and where their setting is. The explanation is About Browser's
 * (`BrowserAboutPopover`), which stays after this is dismissed, so this sentence never repeats it.
 */
export function ArtifactUploadNotice() {
  const instanceScope = useInstanceScope();
  return <ScopedArtifactUploadNotice key={instanceScope} instanceScope={instanceScope} />;
}

function ScopedArtifactUploadNotice({ instanceScope }: { instanceScope: string }) {
  const hasStore = useHasStore();
  const [dismissed, setDismissed] = useState(() => loadInstanceStorageValue(ARTIFACT_UPLOAD_NOTICE_KEY, instanceScope) === "1");
  if (dismissed) return null;
  return <Notice tone="info" compact className="artifact-upload-notice" role="note" ariaLabel="Private Artifact Uploads"
    dismissLabel="Dismiss Artifact Upload Notice"
    onDismiss={() => {
      saveInstanceStorageValue(ARTIFACT_UPLOAD_NOTICE_KEY, "1", instanceScope);
      setDismissed(true);
    }}
    actions={hasStore ? <SettingsLink /> : <a className="btn sm" href={viewPath(settingsView)}>Upload Settings</a>}>
    Artifacts can be stored privately.
  </Notice>;
}
