const SAFE_SESSION_FILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const WINDOWS_RESERVED_BASENAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;

/** Session ids become runner-local filenames in several credential/config surfaces. */
export function isSafeSessionFileId(sessionId: string): boolean {
  return SAFE_SESSION_FILE_ID.test(sessionId) &&
    !sessionId.endsWith(".") &&
    !WINDOWS_RESERVED_BASENAME.test(sessionId);
}

export function assertSafeSessionFileId(sessionId: string): void {
  if (!isSafeSessionFileId(sessionId)) {
    throw new Error("session id contains unsupported path characters");
  }
}
