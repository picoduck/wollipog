import React from "react";
import { createRoot } from "react-dom/client";
import { CopyButton } from "../components/common.js";
import "../styles.css";

/**
 * Copy buttons (#1955, docs/design-system.md §18) in a real browser, where width is layout rather
 * than a number a DOM test supplies.
 *
 * Renders the labeled form in each of its production classes between two neighbours, plus the
 * icon-only form. `?result=fail` makes every copy fail (no Clipboard API and a refused
 * `execCommand`); otherwise the clipboard accepts the text. `?theme=light` switches theme. Chosen by
 * query string so every state is a clean reload.
 */

const params = new URLSearchParams(window.location.search);
document.documentElement.setAttribute("data-theme", params.get("theme") === "light" ? "light" : "dark");
const fail = params.get("result") === "fail";
Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: { writeText: () => (fail ? Promise.reject(new Error("blocked")) : Promise.resolve()) },
});
if (fail) document.execCommand = () => false;

const LABELED = [
  ["Default", "copy-btn", undefined],
  ["Secondary", "btn", "Copy Pairing Link"],
  ["Primary", "btn primary", "Copy Pairing Link"],
] as const;

function Harness() {
  return (
    <div className="copy-button-fixture" style={{ display: "grid", gap: 16, padding: 24, justifyItems: "start" }}>
      {LABELED.map(([name, className, label]) => (
        <div className="actions" key={name} data-variant={name} style={{ display: "flex", alignItems: "center" }}>
          <button className="btn sm" type="button" data-neighbour="before">Before</button>
          <CopyButton text="wollipog pair --token abc123" className={className} label={label} />
          <button className="btn sm" type="button" data-neighbour="after">After</button>
        </div>
      ))}
      <div className="actions" data-variant="Icon Only" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <code>wollipog runner start</code>
        <CopyButton text="wollipog runner start" iconOnly ariaLabel="Copy Start Command" className="copy-btn icon-only-copy" />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
