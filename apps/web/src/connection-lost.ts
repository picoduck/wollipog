import { useEffect, useState } from "react";
import type { ConnState } from "./store.js";

/**
 * True from the first offline report until the connection is online again.
 *
 * The store retries a lost socket every 1.5s, so a lost connection alternates between offline and
 * connecting. Disconnection therefore runs from the first offline until the next online rather than
 * per attempt; otherwise every retry would look like a fresh first connection.
 */
export function useConnectionLost(conn: ConnState): boolean {
  const [lost, setLost] = useState(false);
  useEffect(() => {
    if (conn === "offline") setLost(true);
    else if (conn === "online") setLost(false);
  }, [conn]);
  return lost && conn !== "online";
}

/**
 * True once the connection has been lost for `delayMs` (docs/design-system.md §12.5: the offline
 * banner appears only after 2s of disconnection, so a cold load's first attempt never flashes it).
 * Every retry would otherwise restart the hold and the banner would never appear.
 */
export function useConnectionLostFor(conn: ConnState, delayMs: number): boolean {
  const active = useConnectionLost(conn);
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!active) {
      setHeld(false);
      return;
    }
    const timer = window.setTimeout(() => setHeld(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [active, delayMs]);
  return active && held;
}
