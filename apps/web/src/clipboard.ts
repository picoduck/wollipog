/** Copies `text`, falling back to a selected hidden field where the Clipboard API is unavailable
 * (a plain-HTTP dashboard). The fallback moves focus, which the caller restores. A refused write
 * settles late; when `current()` says the person has moved on by then, the fallback is skipped so
 * it cannot take focus from what they opened since, and the result is `null`. */
export async function writeClipboardText(text: string, current: () => boolean): Promise<boolean | null> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    if (!current()) return null;
    const fallback = document.createElement("textarea");
    fallback.value = text;
    fallback.readOnly = true;
    fallback.style.position = "fixed";
    fallback.style.opacity = "0";
    document.body.appendChild(fallback);
    fallback.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      fallback.remove();
    }
  }
}
