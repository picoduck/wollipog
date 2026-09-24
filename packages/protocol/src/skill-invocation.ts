import type { SkillFile } from "./index.js";

/** Produce the manual-invocation variant of a SKILL.md: the frontmatter gains
 * `disable-model-invocation: true` (replacing any existing spelling of the key); a file without
 * a frontmatter block gains one containing only that key.
 *
 * Like skills-digest.ts this lives outside index.ts: its variant helpers use Node's Buffer, and the
 * web app bundles the package root for the browser. */
export function withManualInvocationFrontmatter(content: string): string {
  const bom = content.startsWith("﻿") ? "﻿" : "";
  const body = bom ? content.slice(1) : content;
  const lines = body.split(/(?<=\n)/);
  if ((lines[0] ?? "").trim() === "---" && lines.length > 1) {
    let closedAt = -1;
    for (let index = 1; index < lines.length; index += 1) {
      const trimmed = lines[index]!.trim();
      if (trimmed === "---" || trimmed === "...") {
        closedAt = index;
        break;
      }
    }
    if (closedAt > 0) {
      const kept = lines
        .slice(1, closedAt)
        .filter((line) => !/^disable-model-invocation\s*:/i.test(line.trim()));
      return (
        bom + lines[0]! + "disable-model-invocation: true\n" + kept.join("") + lines.slice(closedAt).join("")
      );
    }
  }
  return `${bom}---\ndisable-model-invocation: true\n---\n\n${body}`;
}

const INJECTED_LINE = "disable-model-invocation: true\n";
const SYNTHESIZED_BLOCK = `---\n${INJECTED_LINE}---\n\n`;

/** Recover source content from a Manual Only SKILL.md by removing exactly the line the transform
 * injects. Returns null unless the result transforms back to the identical input, so an edit to
 * the injected key itself is never silently folded into library content. A source key the
 * transform replaced cannot be recovered; the result then simply omits it. */
export function withoutManualInvocationFrontmatter(content: string): string | null {
  const bom = content.startsWith("﻿") ? "﻿" : "";
  const body = bom ? content.slice(1) : content;
  const candidates: string[] = [];
  if (body.startsWith(SYNTHESIZED_BLOCK)) candidates.push(bom + body.slice(SYNTHESIZED_BLOCK.length));
  const lines = body.split(/(?<=\n)/);
  if ((lines[0] ?? "").trim() === "---" && lines[1] === INJECTED_LINE) {
    candidates.push(bom + lines[0]! + lines.slice(2).join(""));
  }
  return candidates.find((candidate) => withManualInvocationFrontmatter(candidate) === content) ?? null;
}

/** The exact files a runner publishes for the manual variant of a version: SKILL.md is decoded as
 * UTF-8, transformed, and re-encoded; every other file is unchanged. */
export function manualInvocationVariantFiles(files: SkillFile[]): SkillFile[] {
  return files.map((file) => file.path === "SKILL.md"
    ? {
        path: file.path,
        encoding: "utf8" as const,
        content: withManualInvocationFrontmatter(Buffer.from(file.content, file.encoding).toString("utf8")),
      }
    : file);
}
