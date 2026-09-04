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

/** Collect images pasted (or dropped) into a prompt input. */
export function usePastedImages(
  onUserChange?: () => void,
  onError?: (message: string) => void,
  allowedMimeTypes: readonly string[] = PROMPT_IMAGE_MIME_TYPES,
) {
  const [images, setImages] = useState<PromptImageInput[]>([]);
  const imagesRef = useRef<PromptImageInput[]>([]);
  const allowedMimeSet = useMemo(() => new Set<string>(allowedMimeTypes), [allowedMimeTypes]);

  const addFiles = useCallback(async (files: File[]) => {
    const unsupported = files.find((f) => f.type.startsWith("image/") && !allowedMimeSet.has(f.type));
    if (unsupported) {
      onError?.(
        allowedMimeTypes.length
          ? `Unsupported image type ${unsupported.type || "unknown"}; allowed: ${allowedMimeTypes.join(", ")}.`
          : "The selected model does not support image input.",
      );
    }
    const oversized = files.find((f) => allowedMimeSet.has(f.type) && f.size > MAX_PROMPT_IMAGE_BYTES);
    if (oversized) onError?.(`Image exceeds the ${MAX_PROMPT_IMAGE_BYTES / 1024 / 1024} MiB limit.`);
    const parsed = await Promise.all(
      files.filter((f) => allowedMimeSet.has(f.type) && f.size <= MAX_PROMPT_IMAGE_BYTES).map(fileToImage),
    );
    const valid = parsed.filter((x): x is PromptImage => x !== null);
    if (parsed.some((x) => x === null)) onError?.("An image could not be read.");
    if (!valid.length) return;
    onUserChange?.();
    const next = [...imagesRef.current];
    let total = next.reduce((n, img) => n + (isPromptImageReference(img) ? Math.ceil(img.sizeBytes / 3) * 4 : img.data.length), 0);
    for (const img of valid) {
      if (next.filter((attachment) => !isWorkspaceReference(attachment)).length >= MAX_PROMPT_IMAGES) {
        onError?.(`At most ${MAX_PROMPT_IMAGES} images may be attached.`);
        break;
      }
      if (total + img.data.length > MAX_PROMPT_IMAGE_TOTAL_BASE64_BYTES) {
        onError?.(`Combined image payload exceeds the ${MAX_PROMPT_IMAGE_TOTAL_BASE64_BYTES / 1024 / 1024} MiB limit.`);
        break;
      }
      next.push(img);
      total += img.data.length;
    }
    imagesRef.current = next;
    setImages(next);
  }, [allowedMimeSet, allowedMimeTypes, onError, onUserChange]);

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
      onError?.(`At most ${MAX_WORKSPACE_REFERENCES} workspace references may be attached.`);
      return;
    }
    if (currentReferences.some((candidate) => candidate.targetFingerprint === reference.targetFingerprint &&
        candidate.kind === reference.kind && candidate.startLine === reference.startLine &&
        candidate.endLine === reference.endLine && candidate.side === reference.side)) return;
    onUserChange?.();
    const next = [...imagesRef.current, reference];
    imagesRef.current = next;
    setImages(next);
  }, [onError, onUserChange]);

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
  onRemove: (i: number) => void;
  onInspectReference?: (reference: WorkspaceReference) => void;
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
              onClick={() => onInspectReference?.(img)}
              aria-label={`Inspect Workspace Reference ${workspaceReferenceLabel(img)}`}
              title="Inspect Workspace Reference"
            >
              <span aria-hidden="true">@</span>{workspaceReferenceLabel(img)}
            </button>
            <button
              className="workspace-reference-remove"
              type="button"
              onClick={() => onRemove(i)}
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
              onClick={() => onRemove(i)}
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
