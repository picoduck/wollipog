import { Fragment, type MouseEvent } from "react";
import type { OrchestratorCampaignProjection, SessionHoldView } from "@wollipog/protocol";
import { titleCaseLabel } from "../format.js";
import { viewPath } from "../navigation.js";
import { CountBadge } from "./CountBadge.js";
import { HeldIcon } from "./Icons.js";
import { Notice } from "./Notice.js";
import { RelativeTime } from "./RelativeTime.js";

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
 * a neutral notice listing each child's link and its holds as facts (#2157), never a request row
 * with answer or approve controls.
 */
export function CampaignHeldChildren({
  heldChildren,
  blocked,
  childTitle,
  recoveryAction = (_sessionId, hold) => hold.recoveryAction,
  onOpenChild,
}: {
  heldChildren: readonly CampaignHeldChild[];
  /** `children.blocked` from the same projection; it also counts failed and stopped children. */
  blocked: number;
  childTitle: (sessionId: string) => string | undefined;
  /** The hold's advice as written for the signed-in person (#1857); the server's copy by default. */
  recoveryAction?: (sessionId: string, hold: SessionHoldView) => string;
  onOpenChild: (sessionId: string) => void;
}) {
  if (heldChildren.length === 0) return null;
  const held = heldChildren.length;
  const open = (event: MouseEvent<HTMLAnchorElement>, sessionId: string) => {
    // Keep modified clicks as ordinary links so a child can open in a new tab.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onOpenChild(sessionId);
  };
  // The count badge is hidden from assistive technology, so the region's name carries the count.
  const name = `Held Children (${held})`;
  return (
    <Notice
      as="section"
      className="held-children-notice"
      tone="neutral"
      icon={<HeldIcon />}
      ariaLabel={name}
      title={<>Held Children <CountBadge count={held} /></>}
    >
      <p>
        {held === 1 ? "This child cannot" : "These children cannot"} start another turn until the hold clears.
        {" "}A hold has nothing to answer.
        {/* The projection lists at most 32 held children, so the rest of Blocked may be held too. */}
        {blocked > held && ` ${blocked - held} other blocked ${blocked - held === 1 ? "child is" : "children are"} ` +
          "not listed here, such as failed or stopped children."}
      </p>
      {/* Focusable so a keyboard can scroll the list once it reaches its height limit. */}
      <ul className="held-children" tabIndex={0} aria-label={name}>
        {heldChildren.map((child) => {
          const title = childTitle(child.sessionId) || child.sessionId;
          return (
            <li key={child.sessionId}>
              <a
                className="held-child-link"
                href={viewPath({ name: "session", id: child.sessionId })}
                onClick={(event) => open(event, child.sessionId)}
              >
                {title}
              </a>
              {child.holds.map((hold) => (
                <dl key={hold.holdId} className="facts" data-hold-kind={hold.kind}>
                  <div>
                    <dt>Hold</dt>
                    <dd>{holdKindLabel(hold.kind)} · <RelativeTime at={hold.since} /></dd>
                  </div>
                  <div>
                    <dt>Reason</dt>
                    <dd>{hold.reason}</dd>
                  </div>
                  <div>
                    <dt>Recovery Action</dt>
                    <dd><RecoveryText text={recoveryAction(child.sessionId, hold)} /></dd>
                  </div>
                  {hold.heldResumes && hold.heldResumes.length > 0 && (
                    <div>
                      <dt>Held Decision Resumes</dt>
                      <dd>
                        <ul className="held-child-resumes">
                          {hold.heldResumes.map((resume) => (
                            <li key={resume.occurrenceId}>
                              <code>{resume.occurrenceId}</code> · <RelativeTime at={resume.since} />
                            </li>
                          ))}
                        </ul>
                        Each is delivered once after the hold clears.
                      </dd>
                    </div>
                  )}
                </dl>
              ))}
            </li>
          );
        })}
      </ul>
    </Notice>
  );
}
