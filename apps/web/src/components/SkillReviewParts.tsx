import { useId, type ReactNode } from "react";
import type { SkillFile } from "@wollipog/protocol";
import { SkillFileDiff } from "./SkillFileDiff.js";

/**
 * The shared anatomy of the edited-copy, orphaned-copy and built-in reviews (#1973): one
 * description sentence in the dialog header, then a facts row, at most one compact notice, and the
 * diff under its heading. These are the facts row and the diff section.
 */

/** One fact of a review's facts row; a null value is still being read. */
export interface SkillReviewFact {
  label: string;
  value: ReactNode | null;
}

/** What the review is of, from where, and what accepting it makes (§5.4), side by side. */
export function SkillReviewFacts({ facts }: { facts: readonly SkillReviewFact[] }) {
  return (
    <dl className="facts strip skill-review-facts">
      {facts.map((fact) => (
        <div key={fact.label}>
          <dt>{fact.label}</dt>
          <dd>{fact.value ?? <><span className="skeleton-bar" aria-hidden="true" /><span className="sr-only">Loading</span></>}</dd>
        </div>
      ))}
    </dl>
  );
}

/** "Reviewing and importing never run skill contents.": the one line under every review's diff heading. */
export function skillReviewSafetyNote(verb: "importing" | "accepting" | "restoring" | "saving"): string {
  return `Review every file, including scripts. Reviewing and ${verb} never run skill contents.`;
}

/**
 * The diff under its heading ("Changes From v3"). Until the files are read it keeps the diff's place
 * with one skeleton block that names what is being read (§12.3), so the dialog does not jump; a
 * read that failed shows `failure` there instead.
 */
export function SkillReviewChanges({ title, note, files, loading, failure, collapsed }: {
  title: string;
  note: string;
  files: { previous: readonly SkillFile[]; current: readonly SkillFile[]; executablePaths?: readonly string[] } | null;
  /** Sentence-case status while the files are read: "Reading the edited copy…". */
  loading: string;
  failure?: ReactNode;
  /** Every file starts closed (#1984). */
  collapsed?: boolean;
}) {
  const titleId = `skill-review-changes-${useId().replace(/:/g, "")}`;
  return (
    <section className="skill-review-changes" aria-labelledby={titleId}>
      <div className="skill-review-changes-head">
        <h3 id={titleId} className="skill-review-changes-title">{title}</h3>
        <p className="skill-review-changes-note">{note}</p>
      </div>
      {files
        ? <SkillFileDiff label={title} previousFiles={files.previous} files={files.current} executablePaths={files.executablePaths} collapsed={collapsed} />
        : failure || <div className="skill-review-loading" role="status">{loading}</div>}
    </section>
  );
}
