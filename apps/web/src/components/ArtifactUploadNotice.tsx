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
  return <a className="btn ghost sm" href={viewPath(settingsView)} onClick={(event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(settingsView);
  }}>Artifact Upload Settings</a>;
}

export function ArtifactUploadNotice() {
  const instanceScope = useInstanceScope();
  return <ScopedArtifactUploadNotice key={instanceScope} instanceScope={instanceScope} />;
}

function ScopedArtifactUploadNotice({ instanceScope }: { instanceScope: string }) {
  const hasStore = useHasStore();
  const [dismissed, setDismissed] = useState(() => loadInstanceStorageValue(ARTIFACT_UPLOAD_NOTICE_KEY, instanceScope) === "1");
  if (dismissed) return null;
  return <Notice tone="info" title="Private Artifact Uploads" role="note" ariaLabel="Private Artifact Uploads"
    dismissLabel="Dismiss Artifact Upload Notice"
    onDismiss={() => {
      saveInstanceStorageValue(ARTIFACT_UPLOAD_NOTICE_KEY, "1", instanceScope);
      setDismissed(true);
    }}
    actions={hasStore ? <SettingsLink /> : <a className="btn ghost sm" href={viewPath(settingsView)}>Artifact Upload Settings</a>}>
    Wollipog can store task artifacts privately on this control plane so you can view them remotely.
    Uploads are manual by default. Choose your preference in Settings → Behavior; dismissing this notice does not enable uploads.
  </Notice>;
}
