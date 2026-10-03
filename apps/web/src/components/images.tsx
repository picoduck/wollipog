import { type ClipboardEvent, useCallback, useMemo, useRef, useState } from "react";
import {
  MAX_PROMPT_IMAGE_BYTES,
  MAX_PROMPT_IMAGES,
  MAX_PROMPT_IMAGE_TOTAL_BASE64_BYTES,
  PROMPT_IMAGE_MIME_TYPES,
  MAX_WORKSPACE_REFERENCES,
  isPromptImageReference,
  isWorkspaceReference,
  type PromptImage,
  type PromptImageInput,
  type WorkspaceReference,
} from "@wollipog/protocol";
import { CloseIcon, FileCodeIcon, FolderIcon } from "./Icons.js";
import { PromptImageView } from "./PromptImageView.js";

function fileToImage(file: File): Promise<PromptImage | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") return resolve(null);
      const m = /^data:([^;]+);base64,(.*)$/.exec(result);
      if (!m || m[1] === undefined || m[2] === undefined) return resolve(null);
      resolve({ mimeType: m[1], data: m[2] });
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

// What the protocol does not carry: the file an image was picked, dropped or pasted from, for its alt
// text and the broken-image notice. Drafts are copied attachment by attachment on their way through
// queued edits, Edit as a New Turn and failed sends, so a name follows the image's content rather than
// one object: a 53-bit hash of all of its data, computed once per attachment object. The key is a new
// short string, so it never holds a removed image's data alive. Only this page's recent picks are
// remembered; an image the composer never saw picked (a draft restored after a reload, a stored
// artifact) is numbered instead.
const MAX_REMEMBERED_FILE_NAMES = 64;
const attachmentFileNames = new Map<string, string>();
const contentKeys = new WeakMap<PromptImageInput, string | null>();
const attachmentKeys = new WeakMap<PromptImageInput, string>();
let nextAttachmentKey = 0;

/** cyrb53: a fast, well-distributed 53-bit string hash. Not cryptographic; it tells images apart. */
function hash53(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

function contentKey(image: PromptImageInput): string | null {
  let key = contentKeys.get(image);
  if (key === undefined) {
    key = isPromptImageReference(image)
      ? null
      : `${image.mimeType.length}:${image.data.length}:${hash53(image.mimeType)}:${hash53(image.data)}`;
    contentKeys.set(image, key);
  }
  return key;
}

function rememberFileName(image: PromptImageInput, name: string) {
  const key = contentKey(image);
  if (key === null) return;
  attachmentFileNames.delete(key);
  attachmentFileNames.set(key, name);
  if (attachmentFileNames.size > MAX_REMEMBERED_FILE_NAMES) {
    attachmentFileNames.delete(attachmentFileNames.keys().next().value!);
  }
}

/** The name of the file an attached image came from, when this page saw it picked. */
export function attachmentFileName(image: PromptImageInput): string | undefined {
  const key = contentKey(image);
  return key === null ? undefined : attachmentFileNames.get(key);
}

/** A stable key for an attachment while the composer holds it: React keys and notice keys. */
export function attachmentKey(image: PromptImageInput): string {
  let key = attachmentKeys.get(image);
  if (key === undefined) {
    key = `attachment-${nextAttachmentKey++}`;
    attachmentKeys.set(image, key);
  }
  return key;
}

/** Why an attachment did not land, before it is put into words (§17; #2156). */
export type AttachmentProblem =
  | { kind: "unsupported-type"; mimeType: string; allowedMimeTypes: readonly string[] }
  | { kind: "model-refuses-images"; modelName: string | null }
  | { kind: "too-large"; fileName: string }
  | { kind: "unreadable"; fileName: string }
  | { kind: "too-many" }
  | { kind: "too-large-together" }
  | { kind: "too-many-references" }
  | { kind: "duplicate-reference"; path: string };

/** A composer notice's words: the "+N More" menu's Title Case title and one sentence-case message. */
export interface AttachmentProblemText {
  title: string;
  message: string;
}

const IMAGE_TYPE_NAMES: Readonly<Record<string, string>> = {
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/jpg": "JPEG",
  "image/pjpeg": "JPEG",
  "image/gif": "GIF",
  "image/webp": "WebP",
  "image/svg+xml": "SVG",
  "image/x-icon": "ICO",
  "image/vnd.microsoft.icon": "ICO",
  "image/x-ms-bmp": "BMP",
};

/** "BMP" for image/bmp: the name a person knows a file type by, never its MIME type. Null when the
 * type has no short name, so the sentence says "This image type" instead. */
export function imageTypeName(mimeType: string): string | null {
  const known = IMAGE_TYPE_NAMES[mimeType.toLowerCase()];
  if (known) return known;
  const subtype = /^image\/(?:x-)?([a-z0-9]{2,5})$/i.exec(mimeType)?.[1];
  return subtype ? subtype.toUpperCase() : null;
}

/** "PNG, JPEG, GIF or WebP": the types a session accepts, by name, each once. */
function imageTypeList(mimeTypes: readonly string[]): string {
  const names = [...new Set(mimeTypes.map(imageTypeName).filter((name): name is string => name !== null))];
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

/** The + menu's Attach Image… second line: "PNG, JPEG, GIF or WebP, up to 6 images." */
export function attachImageDescription(mimeTypes: readonly string[], limit: number): string {
  const types = imageTypeList(mimeTypes);
  const count = `up to ${limit} ${limit === 1 ? "image" : "images"}.`;
  return types ? `${types}, ${count}` : `Up to ${limit} ${limit === 1 ? "image" : "images"}.`;
}

/** The one sentence for a model without image input, shared by the composer notice, the drop target
 * and the + menu's Attach Image row. */
export function modelRefusesImagesSentence(modelName: string | null | undefined): string {
  return `${modelName?.trim() || "This model"} can't read images. Choose another model in Model Settings to attach them.`;
}

/** Each outcome in plain words: what happened and what to do, with no MIME types or byte units. */
export function describeAttachmentProblem(problem: AttachmentProblem): AttachmentProblemText {
  switch (problem.kind) {
    case "unsupported-type": {
      const name = imageTypeName(problem.mimeType);
      const allowed = imageTypeList(problem.allowedMimeTypes);
      return {
        title: "Image Not Supported",
        message: `${name ? `${name} images aren't` : "This image type isn't"} supported.` +
          (allowed ? ` Attach a ${allowed} image.` : ""),
      };
    }
    case "model-refuses-images":
      return { title: "Images Not Supported", message: modelRefusesImagesSentence(problem.modelName) };
    case "too-large":
      return {
        title: "Image Too Large",
        message: `“${problem.fileName}” is larger than ${MAX_PROMPT_IMAGE_BYTES / 1024 / 1024} MB. Attach a smaller image.`,
      };
    case "unreadable":
      return {
        title: "Couldn't Read Image",
        message: `“${problem.fileName}” couldn't be read. Try saving it as PNG or JPEG.`,
      };
    case "too-many":
      return {
        title: "Too Many Images",
        message: `You can attach up to ${MAX_PROMPT_IMAGES} images. Remove one to add another.`,
      };
    case "too-large-together":
      return {
        title: "Images Too Large",
        message: "These images are too large to send together. Remove one to add another.",
      };
    case "too-many-references":
      return {
        title: "Too Many References",
        message: `You can reference up to ${MAX_WORKSPACE_REFERENCES} files. Remove one to add another.`,
      };
    case "duplicate-reference":
      return { title: "Already Attached", message: `“${problem.path}” is already attached.` };
  }
}

/** Collect images pasted (or dropped) into a prompt input. */
export function usePastedImages(
  onUserChange?: () => void,
  onProblem?: (problem: AttachmentProblem) => void,
  allowedMimeTypes: readonly string[] = PROMPT_IMAGE_MIME_TYPES,
  /** The selected model, named in the sentence when it cannot read images at all. */
  modelName: string | null = null,
) {
  const [images, setImages] = useState<PromptImageInput[]>([]);
  const imagesRef = useRef<PromptImageInput[]>([]);
  const allowedMimeSet = useMemo(() => new Set<string>(allowedMimeTypes), [allowedMimeTypes]);

  const addFiles = useCallback(async (files: File[]) => {
    // One notice per pick: the first thing that kept a file out. It is reported after the files that
    // did fit have landed, because a draft change clears the composer's notices.
    let problem: AttachmentProblem | null = null;
    const unsupported = files.find((f) => f.type.startsWith("image/") && !allowedMimeSet.has(f.type));
    if (unsupported) {
      problem = allowedMimeTypes.length
        ? { kind: "unsupported-type", mimeType: unsupported.type, allowedMimeTypes }
        : { kind: "model-refuses-images", modelName };
    }
    const oversized = files.find((f) => allowedMimeSet.has(f.type) && f.size > MAX_PROMPT_IMAGE_BYTES);
    if (oversized) problem ??= { kind: "too-large", fileName: oversized.name };
    const accepted = files.filter((f) => allowedMimeSet.has(f.type) && f.size <= MAX_PROMPT_IMAGE_BYTES);
    const parsed = await Promise.all(accepted.map(fileToImage));
    const unreadable = accepted.find((_, index) => parsed[index] === null);
    if (unreadable) problem ??= { kind: "unreadable", fileName: unreadable.name };
    parsed.forEach((image, index) => {
      const name = accepted[index]?.name;
      if (image && name) rememberFileName(image, name);
    });
    const valid = parsed.filter((x): x is PromptImage => x !== null);
    if (valid.length) {
      onUserChange?.();
      const next = [...imagesRef.current];
      let total = next.reduce((n, img) => n + (isPromptImageReference(img) ? Math.ceil(img.sizeBytes / 3) * 4 : img.data.length), 0);
      for (const img of valid) {
        if (next.filter((attachment) => !isWorkspaceReference(attachment)).length >= MAX_PROMPT_IMAGES) {
          problem ??= { kind: "too-many" };
          break;
        }
        if (total + img.data.length > MAX_PROMPT_IMAGE_TOTAL_BASE64_BYTES) {
          problem ??= { kind: "too-large-together" };
          break;
        }
        next.push(img);
        total += img.data.length;
      }
      imagesRef.current = next;
      setImages(next);
    }
    if (problem) onProblem?.(problem);
  }, [allowedMimeSet, allowedMimeTypes, modelName, onProblem, onUserChange]);

  const onPaste = useCallback(
    (e: ClipboardEvent) => {
      const items = Array.from(e.clipboardData.items);
      const files: File[] = [];
      for (const item of items) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length) {
        e.preventDefault();
        void addFiles(files);
      }
    },
    [addFiles],
  );

  const remove = useCallback(
    (i: number) => {
      onUserChange?.();
      const next = imagesRef.current.filter((_, idx) => idx !== i);
      imagesRef.current = next;
      setImages(next);
    },
    [onUserChange],
  );
  const clear = useCallback(() => {
    imagesRef.current = [];
    setImages([]);
  }, []);
  const replace = useCallback((next: PromptImageInput[]) => {
    imagesRef.current = next;
    setImages(next);
  }, []);

  const addWorkspaceReference = useCallback((reference: WorkspaceReference) => {
    const currentReferences = imagesRef.current.filter(isWorkspaceReference);
    if (currentReferences.length >= MAX_WORKSPACE_REFERENCES) {
      onProblem?.({ kind: "too-many-references" });
      return "limit" as const;
    }
    if (currentReferences.some((candidate) => candidate.targetFingerprint === reference.targetFingerprint &&
        candidate.kind === reference.kind && candidate.startLine === reference.startLine &&
        candidate.endLine === reference.endLine && candidate.side === reference.side)) {
      onProblem?.({ kind: "duplicate-reference", path: reference.path });
      return "duplicate" as const;
    }
    onUserChange?.();
    const next = [...imagesRef.current, reference];
    imagesRef.current = next;
    setImages(next);
    return "added" as const;
  }, [onProblem, onUserChange]);

  return { images, onPaste, addFiles, addWorkspaceReference, remove, clear, replace };
}

/** ":18-21" (":18" for one line), then " · Worktree" or " · Base" for a diff: what follows the path. */
export function workspaceReferenceSuffix(reference: WorkspaceReference): string {
  const lines = reference.startLine === undefined
    ? ""
    : `:${reference.startLine}${reference.endLine === undefined || reference.endLine === reference.startLine ? "" : `-${reference.endLine}`}`;
  const side = reference.kind === "diff" ? ` · ${reference.side === "left" ? "Base" : "Worktree"}` : "";
  return `${lines}${side}`;
}

/** "src/session.ts:18-21": the path and what follows it, which names a reference in its controls. */
export function workspaceReferenceLabel(reference: WorkspaceReference): string {
  return `${reference.path}${workspaceReferenceSuffix(reference)}`;
}

/** "Attached image 2: diagram.png", or "Attached image 2" when the file name isn't known. */
export function attachedImageAlt(number: number, name: string | undefined): string {
  return name ? `Attached image ${number}: ${name}` : `Attached image ${number}`;
}

function ReferenceChipBody({ reference }: { reference: WorkspaceReference }) {
  const suffix = workspaceReferenceSuffix(reference);
  return (
    <>
      {reference.kind === "directory" ? <FolderIcon size={14} /> : <FileCodeIcon size={14} />}
      {/* A long path keeps its end, where the file name is, and loses its start. */}
      <span className="ref-chip-path"><bdi>{reference.path}</bdi></span>
      {suffix && <span className="ref-chip-suffix">{suffix}</span>}
    </>
  );
}

/** A sent message's reference in the transcript: the chip without its open and remove halves. */
export function ReadonlyReferenceChip({ reference }: { reference: WorkspaceReference }) {
  return (
    <span className="ref-chip is-readonly" title={workspaceReferenceLabel(reference)}>
      <ReferenceChipBody reference={reference} />
    </span>
  );
}

/**
 * The one remove button of the composer's attachment tray (#2177): 20px with the close icon, and a
 * 28px hit area on a fine pointer, 44px on a coarse one. It unmounts with its attachment, so
 * `onRemove` gets the button, to move a keyboard user's focus back to the composer (#1913).
 */
export function AttachmentRemove({ label, onRemove }: {
  label: string;
  onRemove: (control: HTMLElement) => void;
}) {
  return (
    <button
      className="attach-remove"
      type="button"
      // Keep the composer focused until the click lands, like Send: blurring it on pointerdown brings
      // the phone rail back and moves this button out from under the finger.
      onPointerDown={(event) => event.preventDefault()}
      onClick={(event) => onRemove(event.currentTarget)}
      aria-label={label}
      title={label}
    >
      <CloseIcon size={14} />
    </button>
  );
}

/**
 * Attached images and file references in one wrapping tray inside the composer card (#2177): 56px
 * thumbnails and reference chips on one centre line, each with the same remove button.
 */
export function ComposerAttachments({
  images,
  onRemove,
  onInspectReference,
  onImageBroken,
}: {
  images: PromptImageInput[];
  /** `control` is the remove button, which unmounts with its attachment: a keyboard user's focus
   * needs a new home. */
  onRemove: (i: number, control: HTMLElement) => void;
  /** `opener` is the chip, for returning focus on close: a pointer never focuses it. */
  onInspectReference?: (reference: WorkspaceReference, opener: HTMLElement) => void;
  /** An attached image that couldn't be shown, for the notice slot to name. */
  onImageBroken?: (image: PromptImageInput) => void;
}) {
  if (!images.length) return null;
  let imageNumber = 0;
  return (
    <div className="composer-attachments">
      {images.map((img, i) => {
        if (isWorkspaceReference(img)) {
          const label = workspaceReferenceLabel(img);
          return (
            <div className="ref-chip" key={img.artifactId}>
              <button
                className="ref-chip-open"
                type="button"
                // Keep the composer focused until the click lands, like Send: blurring it on
                // pointerdown brings the phone rail back and moves this chip out from under the finger.
                onPointerDown={(event) => event.preventDefault()}
                onClick={(event) => onInspectReference?.(img, event.currentTarget)}
                aria-label={`Inspect Reference ${label}`}
                title={label}
              >
                <ReferenceChipBody reference={img} />
              </button>
              <AttachmentRemove label={`Remove Reference ${label}`} onRemove={(control) => onRemove(i, control)} />
            </div>
          );
        }
        imageNumber += 1;
        const number = imageNumber;
        return (
          <div className="attach-thumb" key={attachmentKey(img)}>
            <PromptImageView
              image={img}
              alt={attachedImageAlt(number, attachmentFileName(img))}
              onBroken={onImageBroken && (() => onImageBroken(img))}
            />
            <AttachmentRemove label={`Remove Attached Image ${number}`} onRemove={(control) => onRemove(i, control)} />
          </div>
        );
      })}
    </div>
  );
}

