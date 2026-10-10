import type { WorkflowArtifactKind } from "@wollipog/protocol";

/**
 * What a person calls each artifact kind, in sentence case for a row's meta line (#2854;
 * docs/design-system.md §17.1). One map rather than `titleCaseLabel`, which read `html_preview` as
 * "Html Preview": acronyms keep their capitals and a JSON verdict says it is JSON.
 */
const KIND_LABELS: Readonly<Record<WorkflowArtifactKind, string>> = {
  html_preview: "HTML preview",
  patch: "Patch",
  review_report: "Review report",
  screenshot: "Screenshot",
  test_log: "Test log",
  verdict: "Verdict (JSON)",
  video: "Video",
};

export function labelFor(kind: WorkflowArtifactKind): string {
  // A kind added to the protocol before this map learns it still reads as words, not as an id.
  const known = KIND_LABELS[kind];
  if (known) return known;
  const words = (kind as string).replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
