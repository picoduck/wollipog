const MAX_META_BYTES = 16 * 1024;
const MAX_BODY_BYTES = 128 * 1024 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface NativeHttpRequestMeta {
  runtimeKey: string;
  requestId: string;
  method: string;
  path: string;
  headers: Array<[string, string]>;
  bodyLength: number;
}

export interface NativeHttpResponseMeta {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  bodyLength: number;
}

function encodeFrame(meta: object, body: Uint8Array): Uint8Array {
  const metadata = encoder.encode(JSON.stringify(meta));
  if (metadata.byteLength === 0 || metadata.byteLength > MAX_META_BYTES) {
    throw new TypeError("The native transport metadata is too large.");
  }
  if (body.byteLength > MAX_BODY_BYTES) throw new TypeError("The native transport body is too large.");
  const frame = new Uint8Array(4 + metadata.byteLength + body.byteLength);
  new DataView(frame.buffer).setUint32(0, metadata.byteLength, true);
  frame.set(metadata, 4);
  frame.set(body, 4 + metadata.byteLength);
  return frame;
}

export function encodeNativeHttpRequest(
  meta: Omit<NativeHttpRequestMeta, "bodyLength">,
  body: Uint8Array,
): Uint8Array {
  return encodeFrame({ ...meta, bodyLength: body.byteLength }, body);
}

export function decodeNativeHttpResponse(
  value: ArrayBuffer | Uint8Array | number[],
): { meta: NativeHttpResponseMeta; body: Uint8Array } {
  const frame = value instanceof Uint8Array
    ? value
    : Array.isArray(value)
      ? Uint8Array.from(value)
      : new Uint8Array(value);
  if (frame.byteLength < 4) throw new TypeError("The native transport response is incomplete.");
  const metadataLength = new DataView(frame.buffer, frame.byteOffset, 4).getUint32(0, true);
  if (metadataLength === 0 || metadataLength > MAX_META_BYTES || frame.byteLength < 4 + metadataLength) {
    throw new TypeError("The native transport response metadata is invalid.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(frame.subarray(4, 4 + metadataLength)));
  } catch {
    throw new TypeError("The native transport response metadata is invalid.");
  }
  const meta = parsed as Partial<NativeHttpResponseMeta>;
  const body = frame.slice(4 + metadataLength);
  if (!Number.isInteger(meta.status) || meta.status! < 100 || meta.status! > 599 ||
      typeof meta.statusText !== "string" || !Array.isArray(meta.headers) ||
      !Number.isInteger(meta.bodyLength) || meta.bodyLength !== body.byteLength ||
      body.byteLength > MAX_BODY_BYTES) {
    throw new TypeError("The native transport response is invalid.");
  }
  const headers = meta.headers.every((pair) => Array.isArray(pair) && pair.length === 2 &&
    pair.every((part) => typeof part === "string"))
    ? meta.headers as Array<[string, string]>
    : null;
  if (!headers) throw new TypeError("The native transport response headers are invalid.");
  return { meta: { ...meta, headers } as NativeHttpResponseMeta, body };
}
