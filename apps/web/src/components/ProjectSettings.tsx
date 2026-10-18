import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode, type Ref } from "react";
import type { ProjectMemorySharing, ProjectView, RunnerView, UpdateProjectRequest } from "@wollipog/protocol";
import { useLeaveGuard } from "../leave-guard.js";
import type { RunnerDisplay } from "../runners.js";
import {
  draftAfterSave,
  PROJECT_SETTINGS_FIELDS,
  projectSettingsChanges,
  projectSettingsDirty,
  projectSettingsErrors,
  projectSettingsValues,
  revealedAfterSave,
  withSavedMemorySharing,
  type ProjectSettingsDraft,
  type ProjectSettingsField,
} from "../project-settings-draft.js";
import { DetailSection } from "./DetailSection.js";
import { useFeedback } from "./FeedbackProvider.js";
import { ProjectMemorySharingSection } from "./ProjectMemorySharing.js";
import { SaveBar } from "./SaveBar.js";
import { NumberRow, SAVED_MS, SettingRow, SettingsGroup, SwitchRow, type RowFailure } from "./ui/SettingsRows.js";

const READ_ONLY_REASON = "You can't change this project.";

/**
 * A project's Settings, Memory Sharing and Child Session Defaults, as setting rows
 * (docs/design-system.md §8.2) on one draft. Name, the Memory Sharing choice (#2963) and the two
 * child limits are saved together by one `SaveBar` (§8.6, Editor), in one update request carrying
 * only what changed; Show as a Sessions Tab applies at once (§8.6, Instant). Keyed by project
 * identity by the caller, so another project starts with no draft.
 */
export function ProjectSettings({
  project,
  access,
  runners,
  machine,
  busy,
  nameInputRef,
  onSave,
  onSetSessionsTab,
}: {
  project: ProjectView;
  /** The Access row (#2960's readout with Change…), where access is managed. */
  access?: ReactNode;
  /** For Memory Sharing's machine rows. */
  runners: ReadonlyMap<string, RunnerView>;
  machine: (runnerId: string) => RunnerDisplay;
  /** The key of the project request in flight, from this editor or any other part of the page. */
  busy: string | null;
  nameInputRef?: Ref<HTMLInputElement>;
  /** Rejects when nothing was saved. */
  onSave: (changes: UpdateProjectRequest) => Promise<void>;
  /** Rejects when the change was not saved. */
  onSetSessionsTab: (shown: boolean) => Promise<void>;
}) {
  const { confirm, showToast } = useFeedback();
  const id = useId();
  const readOnly = project.canManage === false;
  const limitsSupported = project.childSessionDefaults !== undefined;

  const [draft, setDraft] = useState<ProjectSettingsDraft>({});
  /** Fields whose error shows: each one left after an edit, and every one once Save was pressed. */
  const [revealed, setRevealed] = useState<ReadonlySet<ProjectSettingsField>>(() => new Set());
  /** Fields edited since their error last had a chance to show. */
  const edited = useRef(new Set<ProjectSettingsField>());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /*
   * A save in flight is part of the editor's state, not only the draft beside it. Until it settles
   * the editor stays guarded and its bar stays up even when the draft reads clean (a name typed back
   * to the saved one while the rename is still on its way), and what it settles into is reconciled
   * against what was SENT, never against the project the save produced. The latest draft and
   * revealed set are read through refs so that reconciliation sees edits made while it ran.
   */
  const savingRef = useRef(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  /** A navigation asked for while a save ran: it goes ahead, or asks, once the save settles. */
  const leaveAfterSave = useRef<(() => void) | null>(null);
  /** Save pressed while another request for this project ran: it runs once that one settles. */
  const saveWhenFree = useRef(false);
  /**
   * The Memory Sharing choice on screen when that Save was last pressed. The queued save takes the typed
   * fields as they are when it runs, but never a Memory Sharing choice made after the press: sharing
   * is only sent by a Save pressed while its consent notice showed (#2963).
   */
  const queuedMemorySharing = useRef<ProjectMemorySharing | undefined>(undefined);

  const values = projectSettingsValues(project, draft);
  const dirty = projectSettingsDirty(project, draft);
  const errors = projectSettingsErrors(values);
  const shownError = (field: ProjectSettingsField) => (revealed.has(field) ? errors[field] ?? null : null);
  const invalidCount = PROJECT_SETTINGS_FIELDS.filter((field) => shownError(field)).length;
  const inputIds: Record<ProjectSettingsField, string> = { name: `${id}-name`, cost: `${id}-cost`, tools: `${id}-tools` };

  const edit = (field: ProjectSettingsField, value: string) => {
    edited.current.add(field);
    setDraft((current) => ({ ...current, [field]: value }));
  };
  const leaveField = (field: ProjectSettingsField) => {
    if (!edited.current.delete(field)) return;
    setRevealed((current) => current.has(field) ? current : new Set(current).add(field));
  };
  const reset = () => {
    setDraft({});
    setRevealed(new Set());
    edited.current.clear();
    setSaveError(null);
    saveWhenFree.current = false;
  };

  /** `queued` is the run of a press kept while another request ran, rather than a press now. */
  const save = async (queued = false) => {
    if (savingRef.current || readOnly) return;
    // Another request for this project is still running (a Sessions tab change); the press is kept
    // and Save runs once that request settles, on the draft as it is then, except Memory Sharing.
    if (busy !== null) {
      queuedMemorySharing.current = values.memorySharing;
      saveWhenFree.current = true;
      return;
    }
    // A Memory Sharing choice made since a queued press stays in the draft, with its notice, for a
    // Save of its own; the rest of the draft saves now.
    const heldBack = queued && values.memorySharing !== queuedMemorySharing.current;
    saveWhenFree.current = false;
    setRevealed(new Set(PROJECT_SETTINGS_FIELDS));
    edited.current.clear();
    // Focus moves to the first invalid field, which announces its error (§8.5).
    const invalid = PROJECT_SETTINGS_FIELDS.find((field) => errors[field]);
    if (invalid) {
      document.getElementById(inputIds[invalid])?.focus();
      return;
    }
    const sent = heldBack ? withSavedMemorySharing(project, values) : values;
    const changes = projectSettingsChanges(project, sent);
    if (Object.keys(changes).length === 0) {
      if (!heldBack) reset();
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(changes);
      // Reconciled against what was sent: a field still showing it leaves the draft, and one typed
      // into while the request ran keeps its text and, if it was left invalid, its error.
      const next = draftAfterSave(draftRef.current, sent);
      setDraft(next);
      setRevealed((current) => revealedAfterSave(current, next));
    } catch {
      // The draft stays as typed, and the bar offers Try Again (§8.6). The request is one atomic
      // update, so a failure changed nothing.
      setSaveError("Couldn't save the changes. Nothing was changed.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  useEffect(() => {
    if (busy === null && saveWhenFree.current) void save(true);
  // `save` reads this render's draft, which is the point: it saves what is on screen now.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);
  const submit = (event: FormEvent) => {
    // React bubbles a submit through portals, so a dialog opened from a row (Change Access) that
    // holds a form of its own would otherwise save this draft too.
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    void save();
  };

  const askToLeave = (leave: () => void) => {
    void confirm({
      title: "Discard Changes",
      message: `“${project.name}” has changes that aren't saved. Discarding them keeps the saved settings.`,
      confirmLabel: "Discard Changes",
      cancelLabel: "Keep Editing",
      // Danger opens with focus on Keep Editing, the choice that loses nothing (§7.4).
      tone: "danger",
    }).then((discard) => { if (discard) leave(); });
  };
  // A save in flight cannot be discarded (Discard is disabled while busy, §8.6), so leaving waits for
  // it, as Settings › Orchestrator does: a save that leaves nothing behind then leaves without
  // asking, and one that failed or was typed past asks as any dirty draft does.
  useLeaveGuard(dirty || saving, (leave) => {
    if (savingRef.current) leaveAfterSave.current = leave;
    else askToLeave(leave);
  });
  // Runs once the settled save has rendered, so `dirty` is the reconciled draft's.
  useEffect(() => {
    const leave = leaveAfterSave.current;
    if (!leave || saving) return;
    leaveAfterSave.current = null;
    if (dirty) askToLeave(leave);
    else leave();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saving, dirty]);

  // Show as a Sessions Tab applies at once, with the row's Saved check and a toast (§8.6, §13.1).
  const [tabSavedAt, setTabSavedAt] = useState<number | null>(null);
  const [tabFailure, setTabFailure] = useState<RowFailure | null>(null);
  useEffect(() => {
    if (tabSavedAt === null) return;
    const timer = setTimeout(() => setTabSavedAt(null), SAVED_MS);
    return () => clearTimeout(timer);
  }, [tabSavedAt]);
  const setSessionsTab = async (shown: boolean) => {
    setTabFailure(null);
    setTabSavedAt(null);
    try {
      await onSetSessionsTab(shown);
      setTabSavedAt(Date.now());
      showToast(shown ? "Sessions tab shown." : "Sessions tab hidden.");
    } catch (cause) {
      setTabFailure({
        message: shown ? "Couldn't show the Sessions tab." : "Couldn't hide the Sessions tab.",
        detail: cause instanceof Error ? cause.message : undefined,
        onRetry: () => void setSessionsTab(shown),
      });
    }
  };

  const nameError = shownError("name");
  const limitsSet = values.cost !== "" || values.tools !== "";
  const clearLimits = () => {
    edited.current.add("cost");
    edited.current.add("tools");
    setDraft((current) => ({ ...current, cost: "", tools: "" }));
    // Clear Limits leaves with the limits, so focus goes to the first field it emptied.
    document.getElementById(inputIds.cost)?.focus();
  };

  return (
    <>
      <DetailSection title="Settings">
        <form noValidate onSubmit={submit}>
          <SettingsGroup>
            <SettingRow
              title="Name"
              titleId={`${id}-name-title`}
              description="Renaming doesn't rename its folders or locations."
              descriptionId={`${id}-name-desc`}
              error={nameError}
              errorId={`${id}-name-error`}
              control={(
                <span className="field">
                  <input
                    ref={nameInputRef}
                    id={inputIds.name}
                    className={readOnly ? "is-read-only" : undefined}
                    readOnly={readOnly}
                    autoComplete="off"
                    value={values.name}
                    aria-labelledby={`${id}-name-title`}
                    aria-describedby={nameError ? `${id}-name-error` : `${id}-name-desc`}
                    aria-invalid={nameError ? true : undefined}
                    onChange={(event) => edit("name", event.currentTarget.value)}
                    onBlur={() => leaveField("name")}
                  />
                </span>
              )}
            />
            {access}
            <SwitchRow
              title="Show as a Sessions Tab"
              description="Adds a tab for this project above the Sessions list. Its sessions stay in All either way."
              checked={!project.hidden}
              busy={busy === "visibility"}
              disabled={readOnly || (busy !== null && busy !== "visibility")}
              disabledReason={readOnly ? READ_ONLY_REASON : undefined}
              saved={tabSavedAt !== null}
              failure={tabFailure}
              onClick={() => void setSessionsTab(project.hidden)}
            />
          </SettingsGroup>
        </form>
      </DetailSection>
      <ProjectMemorySharingSection
        project={project}
        runners={runners}
        machine={machine}
        value={values.memorySharing ?? "separate"}
        readOnly={readOnly}
        onChange={(memorySharing) => setDraft((current) => ({ ...current, memorySharing }))}
      />
      {limitsSupported && (
        <DetailSection
          title="Child Session Defaults"
          note="Limits for child sessions that don't set their own. A parent's remaining budget always caps them."
          actions={!readOnly && limitsSet && (
            <button type="button" className="btn sm ghost" onClick={clearLimits}>Clear Limits</button>
          )}
        >
          <form noValidate onSubmit={submit}>
            <SettingsGroup>
              <NumberRow
                title="Cost Limit per Child"
                description="Leave both empty for no limits."
                unit="USD"
                placeholder="No limit"
                textEntry
                step={0.01}
                inputId={inputIds.cost}
                readOnly={readOnly}
                value={values.cost}
                error={shownError("cost")}
                errorPlacement="description"
                onChange={(value) => edit("cost", value)}
                onBlur={() => leaveField("cost")}
              />
              <NumberRow
                title="Tool Calls per Child"
                description="A whole number."
                placeholder="No limit"
                textEntry
                step={1}
                inputId={inputIds.tools}
                readOnly={readOnly}
                value={values.tools}
                error={shownError("tools")}
                errorPlacement="description"
                onChange={(value) => edit("tools", value)}
                onBlur={() => leaveField("tools")}
              />
            </SettingsGroup>
          </form>
        </DetailSection>
      )}
      <SaveBar
        // Up while a save runs, even with a draft that reads clean until it settles.
        dirty={dirty || saving}
        busy={saving}
        error={saveError}
        blockedReason={invalidCount > 0 ? `Fix ${invalidCount} field${invalidCount === 1 ? "" : "s"} to save` : null}
        onDiscard={reset}
        onSave={() => void save()}
      />
    </>
  );
}
