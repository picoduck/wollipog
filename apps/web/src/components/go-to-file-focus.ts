/**
 * Ctrl/⌘+P and a keyboard choice of Files in the tool switcher put focus in Go to File (#2852).
 * The field is focused now when it is on screen; otherwise the next Files body to mount takes it,
 * provided it mounts within a second, so a request can never surface on an unrelated later visit.
 */
export const goToFileFields = new Set<HTMLInputElement>();
let goToFileFocusRequestedAt: number | null = null;
const GO_TO_FILE_FOCUS_WINDOW_MS = 1000;

export function requestGoToFileFocus(): void {
  const field = [...goToFileFields].find((candidate) => candidate.isConnected);
  if (field) {
    goToFileFocusRequestedAt = null;
    field.focus();
    return;
  }
  goToFileFocusRequestedAt = Date.now();
}

export function takeGoToFileFocusRequest(): boolean {
  const requestedAt = goToFileFocusRequestedAt;
  goToFileFocusRequestedAt = null;
  return requestedAt !== null && Date.now() - requestedAt <= GO_TO_FILE_FOCUS_WINDOW_MS;
}

