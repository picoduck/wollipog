import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode, type Ref } from "react";
import type { ProjectView, UpdateProjectRequest } from "@wollipog/protocol";
import { useLeaveGuard } from "../leave-guard.js";
import {
  draftAfterSave,
  PROJECT_SETTINGS_FIELDS,
  projectSettingsChanges,
  projectSettingsDirty,
  projectSettingsErrors,
  projectSettingsValues,
  type ProjectSettingsDraft,
  type ProjectSettingsField,
} from "../project-settings-draft.js";
import { DetailSection } from "./DetailSection.js";
import { useFeedback } from "./FeedbackProvider.js";
import { SaveBar } from "./SaveBar.js";
import { NumberRow, SAVED_MS, SettingRow, SettingsGroup, SwitchRow, type RowFailure } from "./ui/SettingsRows.js";

const READ_ONLY_REASON = "You can't change this project.";

/**
 * A project's Settings and Child Session Defaults (#2962), as setting rows (docs/design-system.md
 * §8.2) on one draft. Name and the two child limits are typed values saved together by one
 * `SaveBar` (§8.6, Editor), in one update request carrying only what changed; Show as a Sessions Tab
 * applies at once (§8.6, Instant). Keyed by project identity by the caller, so another project
 * starts with no draft.
 *
 * `memorySharing` is drawn between the two sections, where Memory Sharing sits until it joins this
 * draft (#2963).
 */
export function ProjectSettings({
  project,
  access,
  memorySharing,
  busy,
  nameInputRef,
  onSave,
  onSetSessionsTab,
}: {
  project: ProjectView;
  /** The Access row (#2960's readout with Change…), where access is managed. */
  access?: ReactNode;
  memorySharing?: ReactNode;
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
  };

  const save = async () => {
    if (saving || readOnly) return;
    // Another request for this project is still running; Save is pressed again once it settles.
    if (busy !== null) return;
    setRevealed(new Set(PROJECT_SETTINGS_FIELDS));
    edited.current.clear();
    // Focus moves to the first invalid field, which announces its error (§8.5).
    const invalid = PROJECT_SETTINGS_FIELDS.find((field) => errors[field]);
    if (invalid) {
      document.getElementById(inputIds[invalid])?.focus();
      return;
    }
    const changes = projectSettingsChanges(project, values);
    if (Object.keys(changes).length === 0) {
      reset();
      return;
    }
    const sent = values;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(changes);
      // A field typed into while the request ran keeps what was typed.
      setDraft((current) => draftAfterSave(current, sent));
      setRevealed(new Set());
    } catch {
      // The draft stays as typed, and the bar offers Try Again (§8.6). The request is one atomic
      // update, so a failure changed nothing.
      setSaveError("Couldn't save the changes. Nothing was changed.");
    } finally {
      setSaving(false);
    }
  };
  const submit = (event: FormEvent) => {
    // React bubbles a submit through portals, so a dialog opened from a row (Change Access) that
    // holds a form of its own would otherwise save this draft too.
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    void save();
  };

  useLeaveGuard(dirty, (leave) => {
    void confirm({
      title: "Discard Changes",
      message: `“${project.name}” has changes that aren't saved. Discarding them keeps the saved settings.`,
      confirmLabel: "Discard Changes",
      cancelLabel: "Keep Editing",
      // Danger opens with focus on Keep Editing, the choice that loses nothing (§7.4).
      tone: "danger",
    }).then((discard) => { if (discard) leave(); });
  });

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
      {memorySharing}
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
        dirty={dirty}
        busy={saving}
        error={saveError}
        blockedReason={invalidCount > 0 ? `Fix ${invalidCount} field${invalidCount === 1 ? "" : "s"} to save` : null}
        onDiscard={reset}
        onSave={() => void save()}
      />
    </>
  );
}
