import React from "react";
import { Markdown, compactMarkdownUrlLabel } from "./Markdown.js";

const ABSOLUTE_URL = /https?:\/\/[^\s<>()]+/gi;
const SUMMARY_LIMIT = 120;

/** A concise plain-text label for a collapsed historical question card. */
export function structuredQuestionSummary(text: string): string {
  const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "Question";
  const summary = firstLine
    .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s*)+/, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(ABSOLUTE_URL, (url) => compactMarkdownUrlLabel(url))
    .replace(/[*_~`]+/g, "")
    .replace(/\s+/g, " ")
    .trim() || "Question";
  return summary.length > SUMMARY_LIMIT ? `${summary.slice(0, SUMMARY_LIMIT - 1).trimEnd()}…` : summary;
}

/** Safe question Markdown with generated URL labels compacted and remote media disabled. */
export function StructuredQuestionText({ children }: { children: string }) {
  return <Markdown highlightEligible={false} compactUrls>{children}</Markdown>;
}
