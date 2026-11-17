/**
 * The runner daemon holds credentials in memory, among them each Wollipog Assistant thread's
 * credential (#4663). An agent running as the same OS user could otherwise send the runner
 * SIGUSR1, which makes Node open its inspector on a loopback port, then read the runner's heap
 * through it without any ptrace permission.
 *
 * Installing a listener for SIGUSR1 keeps Node from starting the inspector on that signal
 * (measured on Node 24: without a listener the inspector opens, with one it does not). An operator
 * who needs the inspector starts the runner with `--inspect` instead, which this does not affect.
 */
export function refuseSignalInspector(target: NodeJS.Process = process, log: (message: string) => void = () => {}): void {
  target.on("SIGUSR1", () => log("ignored SIGUSR1: the runner does not open its inspector on a signal"));
}
