import assert from "node:assert/strict";
import test from "node:test";
import { confirmWhileAllowed } from "./confirmation-fence.js";

test("confirmation rechecks a live action fence after the modal await", async () => {
  let blocked = false;
  let resolveConfirmation!: (confirmed: boolean) => void;
  const pending = confirmWhileAllowed(
    () => new Promise<boolean>((resolve) => { resolveConfirmation = resolve; }),
    () => blocked,
    { title: "Close pod?", message: "Close it." },
  );
  blocked = true;
  resolveConfirmation(true);
  assert.equal(await pending, false);
});

test("confirmation never opens when the live action fence is already blocked", async () => {
  let called = false;
  assert.equal(await confirmWhileAllowed(
    async () => { called = true; return true; },
    () => true,
    { title: "Close pod?", message: "Close it." },
  ), false);
  assert.equal(called, false);
});
