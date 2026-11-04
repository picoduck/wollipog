import type { Readable } from "node:stream";

/** The SSH client holds stdin open for this launch. EOF is a transport-owned shutdown request,
 * not provider input. No network disconnect can turn this runner into an unattended daemon. */
export function watchSshLifetime(input: Readable, stop: () => void): () => void {
  let stopped = false;
  const lost = () => { if (!stopped) { stopped = true; stop(); } };
  input.once("end", lost);
  input.once("error", lost);
  input.resume();
  if (input.readableEnded || input.destroyed) lost();
  return () => { stopped = true; input.off("end", lost); input.off("error", lost); };
}
