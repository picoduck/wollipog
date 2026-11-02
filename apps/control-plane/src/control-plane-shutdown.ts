import { SSH_TEARDOWN_TIMEOUT_MS } from "./ssh-runner-launch.js";

export const CLOSE_FAILSAFE_MS = 5_000;
export const CONTROL_PLANE_SHUTDOWN_LIMIT_MS = SSH_TEARDOWN_TIMEOUT_MS + CLOSE_FAILSAFE_MS;

/** Preserve the 5s hung-close guard after SSH drains settle, within the service's stop budget.
 * Start drains before calling this function so an application-close hook cannot delay them. */
export function finishControlPlaneShutdown(
  runnersStopped: Promise<void>, close: () => Promise<unknown>, exit: () => void,
): void {
  let finished = false;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(hardTimer);
    clearTimeout(closeTimer);
    exit();
  };
  const hardTimer = setTimeout(finish, CONTROL_PLANE_SHUTDOWN_LIMIT_MS);
  const drained = () => {
    if (!finished) closeTimer = setTimeout(finish, CLOSE_FAILSAFE_MS);
  };
  void runnersStopped.then(drained, drained);
  void Promise.allSettled([Promise.resolve().then(close), runnersStopped]).then(finish);
}
