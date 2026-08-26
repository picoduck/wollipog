import { createHash } from "node:crypto";
import type { SkillFile } from "./index.js";

/** Content identity of one skill version: sha256 hex over the canonical JSON manifest
 * `{"files":[{"path","sha256","size"},...]}` where files are sorted by path, sha256 is of the
 * decoded content bytes, and size is the decoded byte length. File order on the wire never
 * changes the digest, and utf8 vs base64 transport of identical bytes never changes it either.
 *
 * This helper lives outside index.ts on purpose: the web app bundles the package root for the
 * browser, which must not pull in node:crypto. Node consumers import "@wollipog/protocol/skills-digest". */
export function skillVersionDigest(files: SkillFile[]): string {
  const manifest = files
    .map((file) => {
      const bytes = Buffer.from(file.content, file.encoding);
      return {
        path: file.path,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length,
      };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return createHash("sha256").update(JSON.stringify({ files: manifest })).digest("hex");
}
