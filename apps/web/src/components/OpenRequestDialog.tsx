import { useRef, useState } from "react";
import type { GitFailure } from "../git-failure.js";
import { Modal } from "./common.js";
import { FieldError } from "./FieldError.js";
import { Notice } from "./Notice.js";
import { BusyButton } from "./ui/BusyButton.js";

const TITLE_ID = "open-request-title";
const TITLE_ERROR_ID = "open-request-title-error";
const BODY_ID = "open-request-body";
const BRANCH_ID = "open-request-branch";
const BRANCH_HELPER_ID = "open-request-branch-helper";

/**
 * Open Pull Request (#2847; docs/design-system.md §7.2–§7.5, §8.1, §8.5): pushes the branch and
 * opens the request, a sheet on phones. GitLab reads "Merge Request" throughout. The three fields
 * are Review's drafts, owned by the panel, so closing the dialog or leaving Review keeps them.
 *
 * A missing title is a field error; a failure the runner reports is a danger notice above the
 * footer, in plain words with Git's output behind Show Details. Closing while it runs is allowed:
 * the result then shows in the commit bar.
 */
export function OpenRequestDialog({
  requestName,
  title,
  onTitleChange,
  body,
  onBodyChange,
  branch,
  onBranchChange,
  partialStage,
  busy,
  failure,
  onSubmit,
  onClose,
  returnFocusRef,
}: {
  requestName: string;
  title: string;
  onTitleChange: (title: string) => void;
  body: string;
  onBodyChange: (body: string) => void;
  branch: string;
  onBranchChange: (branch: string) => void;
  /** Some changes are staged and some aren't, which the runner refuses to push. */
  partialStage: boolean;
  busy: boolean;
  failure: GitFailure | null;
  onSubmit: () => void;
  onClose: () => void;
  returnFocusRef?: { current: HTMLElement | null };
}) {
  const [titleError, setTitleError] = useState<string | null>(null);
  const [edited, setEdited] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const request = requestName.toLowerCase();
  const formId = "open-request-form";
  const validate = (value: string) => value.trim() ? null : `Enter a title for the ${request}.`;

  const submit = () => {
    if (busy) return;
    const problem = validate(title);
    setTitleError(problem);
    setEdited(true);
    if (problem) {
      titleRef.current?.focus();
      return;
    }
    onSubmit();
  };

  return (
    <Modal
      title={`Open ${requestName}`}
      onClose={onClose}
      {...(returnFocusRef ? { returnFocusRef } : {})}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <BusyButton className="btn primary" type="submit" form={formId} busy={busy}
            progress={`Opening the ${request}…`}>
            {`Open ${requestName}`}
          </BusyButton>
        </>
      )}
    >
      <form
        id={formId}
        className="form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="field">
          <div className="field-head"><label htmlFor={TITLE_ID}>Title</label></div>
          <input
            ref={titleRef}
            id={TITLE_ID}
            value={title}
            autoComplete="off"
            aria-invalid={titleError ? true : undefined}
            aria-describedby={titleError ? TITLE_ERROR_ID : undefined}
            onChange={(event) => {
              onTitleChange(event.target.value);
              setEdited(true);
              if (titleError) setTitleError(validate(event.target.value));
            }}
            onBlur={() => { if (edited && !busy) setTitleError(validate(title)); }}
          />
          {titleError && <FieldError id={TITLE_ERROR_ID}>{titleError}</FieldError>}
        </div>
        <div className="field">
          <div className="field-head"><label htmlFor={BODY_ID}>Description (Optional)</label></div>
          <textarea id={BODY_ID} value={body} rows={3} onChange={(event) => onBodyChange(event.target.value)} />
        </div>
        <div className="field">
          <div className="field-head"><label htmlFor={BRANCH_ID}>Branch (Optional)</label></div>
          <input
            id={BRANCH_ID}
            value={branch}
            autoComplete="off"
            spellCheck={false}
            aria-describedby={BRANCH_HELPER_ID}
            onChange={(event) => onBranchChange(event.target.value)}
          />
          <p className="field-helper" id={BRANCH_HELPER_ID}>Defaults to the agent's branch.</p>
        </div>
        {partialStage && (
          <Notice tone="warning" compact role="status">
            Commit the staged changes first. Opening a {request} won't commit a partial stage.
          </Notice>
        )}
        {failure && (
          <Notice
            tone="danger"
            role="alert"
            details={<div className="code-well"><pre>{failure.detail}</pre></div>}
          >
            {failure.sentence}
          </Notice>
        )}
      </form>
    </Modal>
  );
}
