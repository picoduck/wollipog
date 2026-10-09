/**
 * How the dashboard paces publication of socket frames (#2763). A store reduces every frame as it
 * arrives, but tells React and other subscribers at most once per animation frame.
 */

/** Schedules one deferred publication and returns how to cancel it, or null to publish at once
 * (no animation frames, such as a hidden tab or a test without a browser). */
export type StorePublishScheduler = (publish: () => void) => (() => void) | null;

/** Publication waits at most this long when animation frames stall in a tab still reported
 * visible (an occluded window, a throttled frame). */
export const FRAME_PUBLISH_FALLBACK_MS = 100;

/** Publish socket frames on the next animation frame, or at once while the tab is hidden. */
export const animationFramePublishScheduler: StorePublishScheduler = (publish) => {
  if (document.visibilityState === "hidden") return null;
  const frame = window.requestAnimationFrame(() => publish());
  const timer = window.setTimeout(() => publish(), FRAME_PUBLISH_FALLBACK_MS);
  return () => {
    window.cancelAnimationFrame(frame);
    window.clearTimeout(timer);
  };
};

let providerPublishScheduler: StorePublishScheduler | null = animationFramePublishScheduler;

/** The scheduler each `StoreProvider` installs when it mounts. */
export function defaultPublishScheduler(): StorePublishScheduler | null {
  return providerPublishScheduler;
}

/**
 * Replace the scheduler `StoreProvider`s mounted from now on install. DOM tests set null (see
 * `installDomTestCleanup`), so a frame a fake socket delivers is visible at once: happy-dom runs
 * animation frames on a Node queue that React's `act` does not wait for in a fixed order. A test of
 * the batching itself sets `animationFramePublishScheduler` back and drives the frames.
 */
export function setDefaultPublishScheduler(scheduler: StorePublishScheduler | null): void {
  providerPublishScheduler = scheduler;
}
