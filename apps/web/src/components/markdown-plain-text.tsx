import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const BLOCK_TAGS = new Set([
  "P", "H1", "H2", "H3", "H4", "H5", "H6", "PRE", "BLOCKQUOTE", "UL", "OL", "LI", "TABLE", "HR", "DIV",
]);

const tagOf = (node: Node): string => node.nodeType === ELEMENT_NODE ? (node as Element).tagName.toUpperCase() : "";

/** A run of inline content: text with its source newlines read as spaces, as a browser lays it out,
 * a line break for <br>, an image's alt text and a task list's box. */
function inlineText(node: Node): string {
  if (node.nodeType === TEXT_NODE) return (node.nodeValue ?? "").replace(/\n/gu, " ");
  if (node.nodeType !== ELEMENT_NODE) return "";
  const element = node as Element;
  switch (tagOf(element)) {
    case "BR": return "\n";
    case "IMG": return element.getAttribute("alt") ?? "";
    case "INPUT": return element.getAttribute("type") === "checkbox"
      ? (element.hasAttribute("checked") ? "[x]" : "[ ]")
      : "";
    default: return [...element.childNodes].map(inlineText).join("");
  }
}

function blockText(element: Element): string {
  switch (tagOf(element)) {
    case "PRE": return (element.textContent ?? "").replace(/\n$/u, "");
    case "HR": return "";
    case "UL":
    case "OL": {
      const ordered = tagOf(element) === "OL";
      const start = Number(element.getAttribute("start") ?? 1) || 1;
      return [...element.children].filter((child) => tagOf(child) === "LI").map((item, index) => {
        const marker = ordered ? `${start + index}. ` : "- ";
        return marker + containerText(item, "\n").replace(/\n/gu, `\n${" ".repeat(marker.length)}`);
      }).join("\n");
    }
    case "TABLE":
      return [...element.querySelectorAll("tr")].map((row) =>
        [...row.children].map((cell) => inlineText(cell).trim()).join("\t")).join("\n");
    default: return containerText(element, "\n\n");
  }
}

/** A container's blocks, `separator` apart; the inline runs between them count as blocks too. */
function containerText(element: Element, separator: string): string {
  const blocks: string[] = [];
  let inline = "";
  const flush = () => {
    const text = inline.replace(/[ \t]*\n[ \t]*/gu, "\n").replace(/^[ \t\n]+|[ \t\n]+$/gu, "");
    if (text) blocks.push(text);
    inline = "";
  };
  for (const child of element.childNodes) {
    if (BLOCK_TAGS.has(tagOf(child))) {
      flush();
      const text = blockText(child as Element);
      if (text) blocks.push(text);
    } else {
      inline += inlineText(child);
    }
  }
  flush();
  return blocks.join(separator);
}

/**
 * A response's words without its Markdown syntax, for Copy Response: what a reader sees, with
 * paragraphs a blank line apart, list markers, code as written and table cells tab-separated. It
 * renders through the transcript's own Markdown plugins into a detached node, so the copy and the
 * page never parse the text differently. Images are named by their alt text and are never fetched.
 */
export function markdownPlainText(markdown: string): string {
  if (!markdown.trim()) return "";
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    flushSync(() => {
      root.render(
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkBreaks]}
          skipHtml
          components={{ img: ({ alt }) => <img alt={alt ?? ""} /> }}
        >
          {markdown}
        </ReactMarkdown>,
      );
    });
    return containerText(host, "\n\n");
  } finally {
    root.unmount();
  }
}
