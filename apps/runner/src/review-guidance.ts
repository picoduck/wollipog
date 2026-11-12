import { createHash } from "node:crypto";

export const REVIEW_GUIDANCE_LIMIT_BYTES = 64 * 1024;

export interface ReviewGuidance {
  sourceCommit: string;
  sha256: string;
  content: string;
}

/** Read only the committed root blob, never a checkout path or a symbolic link. Git failures
 * propagate: an unreadable policy must not be mistaken for an absent one. */
export async function readReviewGuidance(
  git: (args: string[]) => Promise<string>, sourceCommit: string,
): Promise<ReviewGuidance | null> {
  const entry = await git(["ls-tree", "-z", "--end-of-options", sourceCommit, "--", "REVIEW.md"]);
  if (!entry) return null;
  const match = /^100(?:644|755) blob ([0-9a-f]{40})\tREVIEW\.md\0$/u.exec(entry);
  if (!match) throw new Error("REVIEW.md must be a regular committed file");
  const blob = match[1]!;
  const size = Number((await git(["cat-file", "-s", blob])).trim());
  if (!Number.isSafeInteger(size) || size < 0 || size > REVIEW_GUIDANCE_LIMIT_BYTES) {
    throw new Error("REVIEW.md exceeds the review guidance limit");
  }
  const content = await git(["cat-file", "blob", blob]);
  const objectId = createHash("sha1").update(`blob ${size}\0`).update(content).digest("hex");
  if (Buffer.byteLength(content) !== size || content.includes("\0") || objectId !== blob) {
    throw new Error("REVIEW.md must contain UTF-8 text without NUL bytes");
  }
  return { sourceCommit, sha256: createHash("sha256").update(content).digest("hex"), content };
}
