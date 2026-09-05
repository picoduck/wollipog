import {
  isPromptImageReference,
  type PromptImage,
  type PromptImageInput,
} from "@wollipog/protocol";
import { sha256Hex } from "./artifact-preview.js";

const BASE64_CHUNK_BYTES = 32 * 1024;

function mediaType(value: string): string {
  return value.split(";", 1)[0]!.trim().toLowerCase();
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_BYTES));
  }
  return btoa(binary);
}

/** Convert expiring prepared-image references back into self-contained browser draft data. */
export async function materializePromptImages(
  images: readonly PromptImageInput[],
  exportArtifact: (artifactId: string) => Promise<Blob>,
): Promise<PromptImage[]> {
  return Promise.all(images.map(async (image, index) => {
    if (!isPromptImageReference(image)) return { ...image };

    const blob = await exportArtifact(image.artifactId);
    if (!Number.isSafeInteger(image.sizeBytes) || image.sizeBytes < 0 || blob.size !== image.sizeBytes) {
      throw new Error(`Attachment ${index + 1} length does not match its retained metadata.`);
    }
    if (mediaType(blob.type) !== mediaType(image.mimeType)) {
      throw new Error(`Attachment ${index + 1} MIME type does not match its retained metadata.`);
    }
    const bytes = await blob.arrayBuffer();
    if ((await sha256Hex(bytes)) !== image.sha256.toLowerCase()) {
      throw new Error(`Attachment ${index + 1} digest does not match its retained metadata.`);
    }
    return { mimeType: image.mimeType, data: bytesToBase64(new Uint8Array(bytes)) };
  }));
}
