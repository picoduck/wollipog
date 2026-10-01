import { useId, useState } from "react";
import type { SkillFile } from "@wollipog/protocol";
import { skillMarkdownBody } from "../skills.js";
import { CopyButton } from "./common.js";
import { CopyIcon } from "./Icons.js";
import { Markdown } from "./Markdown.js";
import { SkillDetailSection } from "./SkillDetailHeader.js";

const isMarkdown = (path: string) => /\.(md|markdown)$/i.test(path);

/** SKILL.md first, then the rest in path order. */
export function skillInstructionFiles(files: ReadonlyArray<SkillFile>): SkillFile[] {
  return [...files].sort((a, b) => a.path === "SKILL.md" ? -1 : b.path === "SKILL.md" ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/**
 * Every file the skill's latest version ships (#1980), one at a time: SKILL.md, then its scripts,
 * references and templates, chosen with chips when there is more than one. Markdown renders as
 * Markdown; anything else is shown as text and never run, and a file that isn't text says so. Only
 * the content the version already returned is shown; nothing is fetched. Copy copies the raw text of
 * the file on screen.
 */
export function SkillInstructions({ files }: { files: ReadonlyArray<SkillFile> }) {
  const ordered = skillInstructionFiles(files);
  const [selectedPath, setSelectedPath] = useState(ordered[0]?.path);
  const id = useId().replace(/:/g, "");
  const file = ordered.find((candidate) => candidate.path === selectedPath) ?? ordered[0];
  if (!file) return null;
  const viewId = `skill-file-${id}`;
  const copyNoteId = `skill-file-copies-${id}`;
  const binaryId = `skill-file-binary-${id}`;
  const text = file.encoding === "utf8";

  return (
    <SkillDetailSection
      title="Instructions"
      actions={text ? (
        <>
          <CopyButton text={file.content} className="btn ghost sm" describedBy={copyNoteId} />
          <span id={copyNoteId} className="sr-only">Copies {file.path}</span>
        </>
      ) : (
        <button type="button" className="btn ghost sm" disabled aria-describedby={binaryId}>
          <CopyIcon size={14} />
          Copy
        </button>
      )}
    >
      <div className="surface">
        {ordered.length > 1 && (
          <div className="chips skill-file-chips" role="group" aria-label="Files">
            {ordered.map((candidate) => (
              <button
                key={candidate.path}
                type="button"
                className="chip"
                aria-pressed={candidate.path === file.path}
                aria-controls={viewId}
                onClick={() => setSelectedPath(candidate.path)}
              >
                {candidate.path}
              </button>
            ))}
          </div>
        )}
        {/* Scrolls on its own, so it takes focus for the keyboard and is named by its file. */}
        <div id={viewId} className="skill-file-view" role="region" aria-label={file.path} tabIndex={0} data-file={file.path}>
          {!text ? (
            <p id={binaryId} className="skills-hint">This file isn't text, so it can't be shown or copied here.</p>
          ) : isMarkdown(file.path) ? (
            // Frontmatter is SKILL.md's format; in any other file a leading `---` is a rule to keep.
            <Markdown highlightEligible={false}>{file.path === "SKILL.md" ? skillMarkdownBody(file.content) : file.content}</Markdown>
          ) : (
            <pre className="skill-file-code"><code>{file.content}</code></pre>
          )}
        </div>
      </div>
    </SkillDetailSection>
  );
}
