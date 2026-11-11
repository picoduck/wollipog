/** Extra installed-code contracts used only by the inactive integration fixtures. These pins
 * are deliberately not a claim that the complete dynamically imported graph was attested. */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { verifyPiCommandHomePrototypeInstallation } from "./pi-command-home-prototype.js";
export const PI_INERT_CONTROL_SDK_PINS = Object.freeze({
  "dist/core/extensions/runner.js": "0de12ed1275e02595f92476eec3f61ae1f2e54fd2225ced721ddc90af58a5e61",
  "dist/core/extensions/loader.js": "a1393de916487a2c47107ac7239f3139dcdb938705f88ba1ea5a954b3c8bb483",
  "dist/core/tools/grep.js": "641ae520a88c7eb86406d9a18880f31412cb41cdc15a7ee3e1da5de62979ca7c",
  "dist/core/tools/find.js": "cbb5e3a76e962899f833452ff26670c1fdbf333e7efdecb9953b07f6ebd14ed7",
});
export function verifyPiInertControlSdk(root: string): boolean {
  try {
    return verifyPiCommandHomePrototypeInstallation(root) && Object.entries(PI_INERT_CONTROL_SDK_PINS).every(([name, sha]) => {
      const path = `${root}/${name}`;
      return realpathSync(path) === path && createHash("sha256").update(readFileSync(path)).digest("hex") === sha;
    });
  } catch { return false; }
}
