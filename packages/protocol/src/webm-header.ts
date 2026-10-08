import { Buffer } from "node:buffer";

/** Bounded EBML header recognition, not validation of a complete video. Kept on a Node-only
 * subpath so browser consumers of the protocol root do not pull in Buffer. */
const MAX_EBML_HEADER_BYTES = 4096;
const EBML_SIGNATURE = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
const WEBM_DOC_TYPE = Buffer.from("webm");

function readEbmlVint(bytes: Buffer, offset: number, end: number, isSize: boolean): { value: number; next: number } | undefined {
  if (offset >= end) return undefined;
  let marker = 0x80;
  let width = 1;
  while (marker && !(bytes[offset]! & marker)) {
    marker >>= 1;
    width++;
  }
  if (!marker || width > (isSize ? 8 : 4) || offset + width > end) return undefined;
  let value = isSize ? bytes[offset]! & (marker - 1) : bytes[offset]!;
  for (let index = 1; index < width; index++) {
    value = value * 256 + bytes[offset + index]!;
    if (isSize && value > MAX_EBML_HEADER_BYTES) return undefined;
  }
  // An all-ones size means unknown length, which cannot bound the header or a child.
  if (isSize && value === 2 ** (7 * width) - 1) return undefined;
  return { value, next: offset + width };
}

export function hasWebmDocType(bytes: Buffer): boolean {
  if (bytes.length < 6 || !bytes.subarray(0, 4).equals(EBML_SIGNATURE)) return false;
  const headerSize = readEbmlVint(bytes, 4, Math.min(bytes.length, MAX_EBML_HEADER_BYTES), true);
  if (!headerSize) return false;
  const headerEnd = headerSize.next + headerSize.value;
  if (headerEnd > bytes.length || headerEnd > MAX_EBML_HEADER_BYTES) return false;

  let offset = headerSize.next;
  let foundDocType = false;
  while (offset < headerEnd) {
    const id = readEbmlVint(bytes, offset, headerEnd, false);
    if (!id) return false;
    const size = readEbmlVint(bytes, id.next, headerEnd, true);
    if (!size || size.next + size.value > headerEnd) return false;
    if (id.value === 0x4282) {
      // EBML strings may contain a null terminator and padding after their value.
      if (foundDocType || size.value < WEBM_DOC_TYPE.length ||
        !bytes.subarray(size.next, size.next + WEBM_DOC_TYPE.length).equals(WEBM_DOC_TYPE) ||
        (size.value > WEBM_DOC_TYPE.length && bytes[size.next + WEBM_DOC_TYPE.length] !== 0)) return false;
      foundDocType = true;
    }
    offset = size.next + size.value;
  }
  return foundDocType;
}
