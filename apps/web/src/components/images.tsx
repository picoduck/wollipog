import { type ClipboardEvent, useCallback, useMemo, useRef, useState } from "react";
import {
  MAX_PROMPT_IMAGE_BYTES,
  MAX_PROMPT_IMAGES,
  MAX_PROMPT_IMAGE_TOTAL_BASE64_BYTES,
  PROMPT_IMAGE_MIME_TYPES,
  isPromptImageReference,
  type PromptImage,
  type PromptImageInput,
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
      if (next.length >= MAX_PROMPT_IMAGES) {
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

  return { images, onPaste, addFiles, remove, clear, replace };
}

export function ImageStrip({
  images,
  onRemove,
}: {
  images: PromptImageInput[];
  onRemove: (i: number) => void;
}) {
  if (!images.length) return null;
  return (
    <div className="image-strip">
      {images.map((img, i) => (
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
      ))}
    </div>
  );
}
