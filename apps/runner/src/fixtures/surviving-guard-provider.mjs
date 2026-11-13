// Inert native provider: retain the launch's guard address while its runner is replaced.
const { requestManagedWorktreeGuardVerdict } = await import(process.argv[2]);
process.on("message", async ({ address, payload }) => {
  try {
    const result = await requestManagedWorktreeGuardVerdict(address, payload);
    process.send({ judged: true, result });
  } catch {
    process.send({ judged: false });
  }
});
process.send({ ready: true });
