import { Fragment, useId, type MouseEvent } from "react";
import type { OrchestratorCampaignProjection, SessionHoldView } from "@wollipog/protocol";
import { relativeTime, titleCaseLabel } from "../format.js";
import { viewPath } from "../navigation.js";

export type CampaignHeldChild = NonNullable<OrchestratorCampaignProjection["heldChildren"]>[number];

/** A hold kind is an open vocabulary (#1651 adds runner-side kinds), so label it from its value
 * rather than a table that would hide a kind this client predates. */
export function holdKindLabel(kind: SessionHoldView["kind"]): string {
  return titleCaseLabel(String(kind).replaceAll("_", " "));
}

/** The runner's recovery copy quotes commands in backticks; render those spans as code. */
function RecoveryText({ text }: { text: string }) {
  const parts = text.split("`");
  // An unbalanced backtick leaves the text as written rather than code-formatting the remainder.
  if (parts.length % 2 === 0) return <>{text}</>;
  return <>{parts.map((part, index) => index % 2 === 1
    ? <code key={index}>{part}</code>
    : <Fragment key={index}>{part}</Fragment>)}</>;
}

/**
 * Campaign children that cannot start their next turn, read from the same campaign projection
 * as the Blocked count so the two always agree (#1760). A hold has nothing to answer, so this is
 * a status list with links to each child, never a request row with answer or approve controls.
 */
export function CampaignHeldChildren({
  heldChildren,
  blocked,
  childTitle,
  onOpenChild,
}: {
  heldChildren: readonly CampaignHeldChild[];
  /** `children.blocked` from the same projection; it also counts failed and stopped children. */
  blocked: number;
  childTitle: (sessionId: string) => string | undefined;
  onOpenChild: (sessionId: string) => void;
}) {
  const headingId = `campaign-held-children-${useId().replace(/:/gu, "")}`;
  if (heldChildren.length === 0) return null;
  const held = heldChildren.length;
  const open = (event: MouseEvent<HTMLAnchorElement>, sessionId: string) => {
    // Keep modified clicks as ordinary links so a child can open in a new tab.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onOpenChild(sessionId);
  };
  return (
    <section className="campaign-held-children" aria-labelledby={headingId}>
      <div className="campaign-held-children-head">
        <strong id={headingId}>Held Children</strong>
        <span className="campaign-held-children-count">{held}</span>
      </div>
      <p className="campaign-held-children-summary">
        {held === 1 ? "This child cannot" : "These children cannot"} start another turn until the hold clears.
        {" "}A hold has nothing to answer.
        {/* The projection lists at most 32 held children, so the rest of Blocked may be held too. */}
        {blocked > held && ` ${blocked - held} other blocked ${blocked - held === 1 ? "child is" : "children are"} ` +
          "not listed here, such as failed or stopped children."}
      </p>
      {/* Focusable so a keyboard can scroll the list once it reaches its height limit. */}
      <ul className="campaign-held-children-list" tabIndex={0} aria-labelledby={headingId}>
        {heldChildren.map((child) => {
          const title = childTitle(child.sessionId) || child.sessionId;
          return (
            <li key={child.sessionId} className="campaign-held-child">
              <a
                className="campaign-held-child-link"
                href={viewPath({ name: "session", id: child.sessionId })}
                onClick={(event) => open(event, child.sessionId)}
              >
                {title}
              </a>
              {child.holds.map((hold) => (
                <dl key={hold.holdId} className="campaign-held-child-hold" data-hold-kind={hold.kind}>
                  <div>
                    <dt>Hold</dt>
                    <dd>{holdKindLabel(hold.kind)}<small> · {relativeTime(hold.since)}</small></dd>
                  </div>
                  <div>
                    <dt>Reason</dt>
                    <dd>{hold.reason}</dd>
                  </div>
                  <div>
                    <dt>Recovery Action</dt>
                    <dd><RecoveryText text={hold.recoveryAction} /></dd>
                  </div>
                  {hold.heldResumes && hold.heldResumes.length > 0 && (
                    <div>
                      <dt>Held Decision Resumes</dt>
                      <dd>
                        <ul className="campaign-held-child-resumes">
                          {hold.heldResumes.map((resume) => (
                            <li key={resume.occurrenceId}>
                              <code>{resume.occurrenceId}</code>
                              <small> · {relativeTime(resume.since)}</small>
                            </li>
                          ))}
                        </ul>
                        <small>Each is delivered once after the hold clears.</small>
                      </dd>
                    </div>
                  )}
                </dl>
              ))}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
