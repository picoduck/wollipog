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

/** Why an attachment did not land, before it is put into words (§17; #2156). */
export type AttachmentProblem =
  | { kind: "unsupported-type"; mimeType: string; allowedMimeTypes: readonly string[] }
  | { kind: "model-refuses-images"; modelName: string | null }
  | { kind: "too-large"; fileName: string }
  | { kind: "unreadable"; fileName: string }
  | { kind: "too-many" }
  | { kind: "too-large-together" }
  | { kind: "too-many-references" };

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
        candidate.endLine === reference.endLine && candidate.side === reference.side)) return "duplicate" as const;
    onUserChange?.();
    const next = [...imagesRef.current, reference];
    imagesRef.current = next;
    setImages(next);
    return "added" as const;
  }, [onProblem, onUserChange]);

  return { images, onPaste, addFiles, addWorkspaceReference, remove, clear, replace };
}

function workspaceReferenceLabel(reference: WorkspaceReference): string {
  const lines = reference.startLine === undefined
    ? ""
    : `:${reference.startLine}${reference.endLine === reference.startLine ? "" : `-${reference.endLine}`}`;
  const side = reference.kind === "diff" ? ` · ${reference.side === "left" ? "Base" : "Worktree"}` : "";
  return `${reference.path}${lines}${side}`;
}

export function ImageStrip({
  images,
  onRemove,
  onInspectReference,
}: {
  images: PromptImageInput[];
  /** `control` is the ✕, which unmounts with its chip: a keyboard user's focus needs a new home. */
  onRemove: (i: number, control: HTMLElement) => void;
  /** `opener` is the chip, for returning focus on close: a pointer never focuses it. */
  onInspectReference?: (reference: WorkspaceReference, opener: HTMLElement) => void;
}) {
  if (!images.length) return null;
  return (
    <div className="image-strip">
      {images.map((img, i) => (
        isWorkspaceReference(img) ? (
          <div className="workspace-reference-chip" key={img.artifactId}>
            <button
              className="workspace-reference-open"
              type="button"
              // Keep the composer focused until the click lands, like Send: blurring it on
              // pointerdown brings the phone rail back and moves this chip out from under the finger.
              onPointerDown={(event) => event.preventDefault()}
              onClick={(event) => onInspectReference?.(img, event.currentTarget)}
              aria-label={`Inspect Workspace Reference ${workspaceReferenceLabel(img)}`}
              title="Inspect Workspace Reference"
            >
              <span aria-hidden="true">@</span>{workspaceReferenceLabel(img)}
            </button>
            <button
              className="workspace-reference-remove"
              type="button"
              // Keep the composer focused until the click lands, like Send: blurring it on
              // pointerdown brings the phone rail back and moves this button out from under the finger.
              onPointerDown={(event) => event.preventDefault()}
              onClick={(event) => onRemove(i, event.currentTarget)}
              aria-label={`Remove Workspace Reference ${workspaceReferenceLabel(img)}`}
            >
              ✕
            </button>
          </div>
        ) : (
          <div className="image-thumb" key={i}>
            <PromptImageView image={img} alt={`attachment ${i + 1}`} />
            <button
              className="image-remove"
              type="button"
              // Keep the composer focused until the click lands, like Send: blurring it on
              // pointerdown brings the phone rail back and moves this button out from under the finger.
              onPointerDown={(event) => event.preventDefault()}
              onClick={(event) => onRemove(i, event.currentTarget)}
              aria-label="Remove Image"
            >
              ✕
            </button>
          </div>
        )
      ))}
    </div>
  );
}
