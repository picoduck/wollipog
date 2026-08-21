// Runner frames can legitimately contain the protocol's 28 MiB combined base64 image payload.
// Leave bounded JSON overhead while remaining far below ws's 100 MiB default.
export const MAX_RUNNER_CLIENT_MESSAGE_BYTES = 32 * 1024 * 1024;
export const MAX_RUNNER_CONNECTIONS = 256;
export const MAX_RUNNER_CONNECTIONS_PER_IP = 8;
export const RUNNER_AUTH_TIMEOUT_MS = 10_000;

export interface RunnerConnectionLimitsOptions {
  maxConnections?: number;
  maxConnectionsPerIp?: number;
}

/** Tracks every upgraded runner socket, including sockets that have not authenticated yet. */
export class RunnerConnectionLimits {
  private connectionCount = 0;
  private readonly connectionsByIp = new Map<string, number>();
  private readonly maxConnections: number;
  private readonly maxConnectionsPerIp: number;

  constructor(options: RunnerConnectionLimitsOptions = {}) {
    this.maxConnections = positiveInteger(options.maxConnections ?? MAX_RUNNER_CONNECTIONS);
    this.maxConnectionsPerIp = positiveInteger(
      options.maxConnectionsPerIp ?? MAX_RUNNER_CONNECTIONS_PER_IP,
    );
  }

  acquire(sourceIp: string): (() => void) | null {
    const ipCount = this.connectionsByIp.get(sourceIp) ?? 0;
    if (this.connectionCount >= this.maxConnections || ipCount >= this.maxConnectionsPerIp) {
      return null;
    }
    this.connectionCount++;
    this.connectionsByIp.set(sourceIp, ipCount + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.connectionCount--;
      const remaining = (this.connectionsByIp.get(sourceIp) ?? 1) - 1;
      if (remaining === 0) this.connectionsByIp.delete(sourceIp);
      else this.connectionsByIp.set(sourceIp, remaining);
    };
  }
}

function positiveInteger(value: number): number {
  return Math.max(1, Math.floor(Number.isFinite(value) ? value : 1));
}
