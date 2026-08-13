import type { ConfirmationOptions } from "./components/FeedbackProvider.js";

/** Re-check a live action fence after an asynchronous confirmation resolves. */
export async function confirmWhileAllowed(
  confirm: (options: ConfirmationOptions) => Promise<boolean>,
  isBlocked: () => boolean,
  options: ConfirmationOptions,
): Promise<boolean> {
  if (isBlocked()) return false;
  if (!await confirm(options)) return false;
  return !isBlocked();
}
