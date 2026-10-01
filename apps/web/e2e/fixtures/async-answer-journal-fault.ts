/** Test-only preload: fail one async-answer journal fence before provider submission. */
import { writeFileSync } from "node:fs";
import { DurableCommandStore } from "../../../runner/src/durable-command-store.js";

const prototype = DurableCommandStore.prototype as unknown as {
  writeAtomic(file: string, record: { state: string; steeringPending?: boolean }): void;
};
const originalWrite = prototype.writeAtomic;
let injected = false;
prototype.writeAtomic = function (file, record) {
  if (!injected && record.state === "started" && record.steeringPending) {
    injected = true;
    writeFileSync(process.env.WOLLIPOG_TEST_JOURNAL_FAULT_MARKER!, "injected");
    throw new Error("synthetic async answer journal failure");
  }
  originalWrite.call(this, file, record);
};
