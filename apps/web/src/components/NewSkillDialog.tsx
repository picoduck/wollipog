import { useId, useRef, useState, type DragEvent } from "react";
import { SKILL_MAX_FILES, isSkillScriptFile, skillMarkdownFromFields, type SkillFile } from "@wollipog/protocol";
import {
  skillFilesFromUploads,
  skillMarkdownFrontmatterName,
  skillNameError,
  validateSkillFiles,
  type UploadedSkillFile,
} from "../skills.js";
import { Modal } from "./common.js";
import { FieldError } from "./FieldError.js";
import { FolderIcon } from "./Icons.js";
import { Notice } from "./Notice.js";
import { SkillDescriptionField } from "./SkillDescriptionField.js";
import { BusyButton } from "./ui/BusyButton.js";
import { SegmentedControl } from "./ui/ChoiceControls.js";
import { useAutoGrowTextarea } from "./useAutoGrowTextarea.js";

type InstructionsSource = "write" | "upload";

const TOO_MANY_FILES = `A skill can contain at most ${SKILL_MAX_FILES} files.`;

/** Read a picked folder's files, refusing one with more files than a skill can hold before reading
 * any of them. */
async function uploadsFromFiles(files: File[]): Promise<UploadedSkillFile[] | null> {
  if (files.length > SKILL_MAX_FILES) return null;
  return Promise.all(files.map(async (file) => ({
    relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
    bytes: new Uint8Array(await file.arrayBuffer()),
  })));
}

/** Read a dropped folder (or loose files) the way the folder input reports them: each path starts
 * with the dropped folder's own name. Stops, returning null, once there are more files than a
 * skill can hold, so dropping a large tree never reads it all into memory. */
async function uploadsFromDrop(transfer: DataTransfer): Promise<UploadedSkillFile[] | null> {
  const entries = [...transfer.items].map((item) => item.webkitGetAsEntry?.()).filter((entry) => entry != null);
  if (entries.length === 0) return uploadsFromFiles([...transfer.files]);
  const found: FileSystemFileEntry[] = [];
  const walk = async (entry: FileSystemEntry): Promise<boolean> => {
    if (entry.isFile) {
      found.push(entry as FileSystemFileEntry);
      return found.length <= SKILL_MAX_FILES;
    }
    if (!entry.isDirectory) return true;
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries returns a directory in batches; an empty batch is the end.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      if (batch.length === 0) return true;
      for (const child of batch) if (!(await walk(child))) return false;
    }
  };
  for (const entry of entries) if (!(await walk(entry))) return null;
  return Promise.all(found.map(async (entry) => {
    const file = await new Promise<File>((resolve, reject) => entry.file(resolve, reject));
    return { relativePath: entry.fullPath.replace(/^\/+/, ""), bytes: new Uint8Array(await file.arrayBuffer()) };
  }));
}

/**
 * New Skill (docs/design-system.md §7, §8): a name, a description, and instructions either written
 * here or uploaded as a folder. Written instructions are the SKILL.md body; its frontmatter is
 * built from the name and description when the skill is created, so there is one place to edit
 * each. An uploaded folder is used as it is, with its own SKILL.md.
 */
export function NewSkillDialog({ onClose, onCreate, busy, error }: {
  onClose: () => void;
  onCreate: (input: { name: string; description: string; files: SkillFile[] }) => Promise<void>;
  busy: boolean;
  /** The last create request's failure, shown above the footer. */
  error?: string | null;
}) {
  const ids = useId();
  const nameHelperId = `${ids}-name-helper`;
  const instructionsLabelId = `${ids}-instructions`;
  const instructionsHelperId = `${ids}-instructions-helper`;
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [source, setSource] = useState<InstructionsSource>("write");
  const [body, setBody] = useState("");
  const [folderFiles, setFolderFiles] = useState<SkillFile[]>([]);
  const [fileErrors, setFileErrors] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const chooseRef = useRef<HTMLButtonElement>(null);
  const fileListRef = useRef<HTMLUListElement>(null);
  useAutoGrowTextarea(bodyRef, body);

  const trimmedName = name.trim();

  const applyUploads = (uploads: UploadedSkillFile[] | null) => {
    if (!uploads) {
      setFolderFiles([]);
      setFileErrors([TOO_MANY_FILES]);
      return;
    }
    const converted = skillFilesFromUploads(uploads);
    setFolderFiles(converted.files);
    setFileErrors(converted.errors);
    // A folder's SKILL.md already names the skill; an empty Name takes that name. The field's own
    // value, not this render's: the files were read asynchronously, and the person may have typed
    // a name meanwhile.
    const skillMd = converted.files.find((file) => file.path === "SKILL.md");
    const named = skillMd?.encoding === "utf8" ? skillMarkdownFrontmatterName(skillMd.content) : null;
    if (named && !nameRef.current?.value.trim()) {
      setName(named);
      setNameError((error) => error && skillNameError(named));
    }
  };

  const removeFile = (path: string) => {
    const index = folderFiles.findIndex((file) => file.path === path);
    setFolderFiles(folderFiles.filter((file) => file.path !== path));
    setFileErrors([]);
    // Focus stays in the list: on the row that took this one's place, else the one before, else
    // Choose Folder… once the list is gone.
    queueMicrotask(() => {
      const buttons = fileListRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [];
      (buttons[Math.min(index, buttons.length - 1)] ?? chooseRef.current)?.focus();
    });
  };

  const onDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (busy) return;
    try {
      applyUploads(await uploadsFromDrop(event.dataTransfer));
    } catch (cause) {
      setFileErrors([`The dropped files could not be read: ${(cause as Error).message}`]);
    }
  };

  const submit = async () => {
    const nameProblem = skillNameError(trimmedName);
    setNameError(nameProblem);
    setNameEdited(true);
    const files: SkillFile[] = source === "upload"
      ? folderFiles
      : [{ path: "SKILL.md", content: skillMarkdownFromFields({ name: trimmedName, description: description.trim(), body }), encoding: "utf8" }];
    const fileProblems = validateSkillFiles({ name: nameProblem ? undefined : trimmedName, files });
    setFileErrors(fileProblems);
    if (nameProblem) {
      nameRef.current?.focus();
      return;
    }
    if (fileProblems.length) {
      (source === "upload" ? chooseRef.current : bodyRef.current)?.focus();
      return;
    }
    await onCreate({ name: trimmedName, description: description.trim(), files });
  };

  // The instructions' errors replace their helper (§8.5); the control is described by whichever shows.
  const instructionsDescribedBy = fileErrors.length
    ? fileErrors.map((_, index) => `${ids}-file-error-${index}`).join(" ")
    : instructionsHelperId;
  const instructionsHelper = (helper: string) => fileErrors.length
    ? fileErrors.map((message, index) => <FieldError key={index} id={`${ids}-file-error-${index}`}>{message}</FieldError>)
    : <p className="field-helper" id={instructionsHelperId}>{helper}</p>;

  return (
    <Modal title="New Skill" onClose={onClose} footer={
      <>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <BusyButton className="btn primary" busy={busy} progress="Creating the skill…" onClick={() => void submit()}>
          Create Skill
        </BusyButton>
      </>
    }>
      <div className="form">
        <div className="field">
          <div className="field-head"><label htmlFor={`${ids}-name`}>Name</label></div>
          <input
            ref={nameRef}
            id={`${ids}-name`}
            value={name}
            maxLength={64}
            autoComplete="off"
            spellCheck={false}
            placeholder="e.g. code-review"
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameHelperId}
            onChange={(event) => {
              const next = event.target.value;
              setName(next);
              setNameEdited(true);
              // An error showing clears as soon as the value is valid (§8.5).
              if (nameError) setNameError(skillNameError(next.trim()));
            }}
            onBlur={() => { if (nameEdited) setNameError(skillNameError(trimmedName)); }}
          />
          {nameError
            ? <FieldError id={nameHelperId}>{nameError}</FieldError>
            : <p className="field-helper" id={nameHelperId}>Lowercase letters, digits, dots, dashes or underscores; it also names the skill's folder.</p>}
        </div>

        <SkillDescriptionField value={description} onChange={setDescription} />

        <div className="field">
          <div className="field-head">
            <span id={instructionsLabelId}>Instructions</span>
            <SegmentedControl<InstructionsSource>
              className="sm"
              label="Instructions Source"
              value={source}
              options={[
                { value: "write", label: "Write" },
                { value: "upload", label: "Upload Folder" },
              ]}
              onChange={(next) => { setSource(next); setFileErrors([]); }}
            />
          </div>
          {source === "write" ? <>
            <textarea
              ref={bodyRef}
              rows={6}
              value={body}
              placeholder="e.g. Read the whole diff before commenting. Point out bugs before style."
              aria-labelledby={instructionsLabelId}
              aria-describedby={instructionsDescribedBy}
              aria-invalid={fileErrors.length ? true : undefined}
              onChange={(event) => setBody(event.target.value)}
            />
            {instructionsHelper("Markdown the agent follows; the name and description above become its frontmatter.")}
          </> : <>
            <div
              className={`skill-dropzone${dragging ? " is-dragging" : ""}`}
              role="group"
              aria-labelledby={instructionsLabelId}
              onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
              onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
              }}
              onDrop={(event) => void onDrop(event)}
            >
              <FolderIcon className="skill-dropzone-icon" aria-hidden="true" />
              <span>Drop a skill folder here or</span>
              <button
                ref={chooseRef}
                type="button"
                className="btn sm"
                disabled={busy}
                aria-describedby={instructionsDescribedBy}
                onClick={() => folderInputRef.current?.click()}
              >
                Choose Folder…
              </button>
              <input
                ref={folderInputRef}
                type="file"
                multiple
                hidden
                tabIndex={-1}
                {...({ webkitdirectory: "" } as Record<string, string>)}
                onChange={(event) => {
                  const files = [...(event.target.files ?? [])];
                  // Choosing the same folder again after a Remove must still fire a change.
                  event.target.value = "";
                  if (files.length === 0) return;
                  void uploadsFromFiles(files).then(applyUploads, (cause: Error) =>
                    setFileErrors([`The folder could not be read: ${cause.message}`]));
                }}
              />
            </div>
            {instructionsHelper("Every file in the folder is uploaded as it is, including its own SKILL.md.")}
            {folderFiles.length > 0 && (
              <ul className="skill-upload-files" ref={fileListRef} aria-label="Files to Upload">
                {folderFiles.map((file) => (
                  <li key={file.path} className="skill-upload-file">
                    <span className="skill-upload-path">{file.path}</span>
                    {isSkillScriptFile(file) && <span className="status no-dot t-warning">Script</span>}
                    <button type="button" className="btn ghost sm" disabled={busy} aria-label={`Remove ${file.path}`}
                      onClick={() => removeFile(file.path)}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>}
        </div>

        {error && <Notice tone="danger" role="alert" title="Couldn't Create the Skill">{error}</Notice>}
      </div>
    </Modal>
  );
}
