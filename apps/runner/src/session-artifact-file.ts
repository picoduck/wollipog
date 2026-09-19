/** Reads one image file for `attach_session_artifact`. The file's bytes go from disk to the control
 * plane; nothing returned from here except the media type, size, and digest may reach a model. */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { MAX_PROMPT_IMAGE_BYTES } from "@wollipog/protocol";

export type ImageFileRead =
  | { ok: true; bytes: Buffer; mediaType: string; sizeBytes: number; sha256: string }
  | { ok: false; error: string };

/** The media type is read from the content, never from the file name: a `.png` that holds something
 * else must not be stored, cited, and later shown to a reviewer as a PNG. */
export function sniffImageMediaType(bytes: Buffer): string | null {
  if (bytes.length >= 8 &&
      bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6) {
    const head = bytes.subarray(0, 6).toString("latin1");
    if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
      bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

function failure(path: string, error: unknown): ImageFileRead {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") return { ok: false, error: `file not found: ${path}` };
  if (code === "EACCES" || code === "EPERM") return { ok: false, error: `file is not readable: ${path}` };
  if (code === "EISDIR") return { ok: false, error: `not a regular file: ${path}` };
  return { ok: false, error: `could not read ${path}: ${code ?? (error as Error)?.message ?? String(error)}` };
}

export async function readImageFileForAttach(
  path: string,
  /** Test seam: runs after the size is checked and before the read, where a writer could race. */
  afterSizeCheck?: () => void | Promise<void>,
): Promise<ImageFileRead> {
  // The management server's working directory is the provider's launch directory, not the agent's
  // current one, so a relative path would silently name a different file. The CLI resolves relative
  // paths against its own working directory before it gets here.
  if (!isAbsolute(path)) return { ok: false, error: `an absolute file path is required: ${path}` };
  try {
    // Refuse a FIFO, device, or directory before opening: opening a FIFO for reading blocks until a
    // writer appears, which would hang the tool call.
    if (!(await stat(path)).isFile()) return { ok: false, error: `not a regular file: ${path}` };
  } catch (error) {
    return failure(path, error);
  }
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    return failure(path, error);
  }
  try {
    // Size and type are judged on the descriptor that will be read, so the path cannot be swapped
    // for something else between the check and the read.
    const info = await handle.stat();
    if (!info.isFile()) return { ok: false, error: `not a regular file: ${path}` };
    if (info.size === 0) return { ok: false, error: `file is empty: ${path}` };
    if (info.size > MAX_PROMPT_IMAGE_BYTES) {
      return {
        ok: false,
        error: `file is ${info.size} bytes; an attached image may be at most ${MAX_PROMPT_IMAGE_BYTES} bytes: ${path}`,
      };
    }
    await afterSizeCheck?.();
    // Read into a buffer sized from the size just checked, plus one byte to detect growth.
    // `readFile()` would take its own fstat and allocate whatever the file had become by then, so a
    // file grown after the check above could make this process allocate without bound.
    const buffer = Buffer.allocUnsafe(Math.min(info.size, MAX_PROMPT_IMAGE_BYTES) + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const bytes = buffer.subarray(0, length);
    // Either direction means a writer is still at work; a half-written capture is not evidence.
    if (bytes.length !== info.size) {
      return { ok: false, error: `file changed size while it was being read; attach it once it is complete: ${path}` };
    }
    const mediaType = sniffImageMediaType(bytes);
    if (!mediaType) {
      return { ok: false, error: `file content is not a PNG, JPEG, GIF, or WebP image: ${path}` };
    }
    return {
      ok: true,
      bytes,
      mediaType,
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    return failure(path, error);
  } finally {
    await handle.close().catch(() => {});
  }
}
