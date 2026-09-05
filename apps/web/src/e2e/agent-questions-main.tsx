import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AgentQuestion, SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { SessionQuestionBanner } from "../components/SessionApproval.js";
import { ComposerQuestionResponse } from "../components/ComposerQuestionResponse.js";
import { setQuestionResponseStyle, useQuestionResponseStyle } from "../question-response-style.js";
import { inTypingContext } from "../shortcuts.js";
import { isFollowTailResumeKey } from "../useFollowTail.js";
import "../styles.css";

interface AnswerCall {
  sessionId: string;
  requestId: string;
  answers: Record<string, string | string[]>;
  action?: "submit" | "dismiss";
}

declare global {
  interface Window {
    agentQuestionCalls: AnswerCall[];
    replaceAgentQuestion(): void;
    releaseAgentQuestion(): void;
    setAgentQuestionOnline(online: boolean): void;
  }
}

const params = new URLSearchParams(window.location.search);
setQuestionResponseStyle(["composer", "text"].includes(params.get("style") ?? "") ? "composer" : "interactive");
const initialOnline = params.get("offline") !== "1";
const shouldFail = params.get("failure") === "1";
const renderInFallbackSlot = params.get("slot") === "1";
const recoveryRequired = params.get("recovery") === "1";
const recoveryCanResume = recoveryRequired && params.get("resume") === "1";
let shouldHold = params.get("hold") === "1";
let releasePending: (() => void) | null = null;

const shortQuestions: AgentQuestion[] = [{
  id: "language",
  header: "Language",
  question: "Which language should the example use?",
  multiSelect: false,
  options: [
    { label: "TypeScript", description: "Use the existing Node.js toolchain." },
    { label: "Python", description: "Use a standalone script." },
  ],
}];

const longDescription = "A deliberately long description that wraps across several lines on a narrow phone while remaining understandable and tappable.";
const longQuestions: AgentQuestion[] = [
  {
    id: "strategy",
    header: "Strategy",
    question: "Choose the release strategy after reviewing all of these deliberately detailed options.",
    multiSelect: false,
    options: [
      { label: "Canary", description: longDescription },
      { label: "Blue-Green", description: longDescription },
      { label: "Rolling", description: longDescription },
      { label: "Regional", description: longDescription },
    ],
  },
  {
    id: "checks",
    header: "Checks",
    question: "Select every validation that should run before the release is promoted.",
    multiSelect: true,
    options: [
      { label: "Unit Tests", description: longDescription },
      { label: "Browser Tests", description: longDescription },
      { label: "Accessibility Audit", description: longDescription },
      { label: "Smoke Test", description: longDescription },
    ],
  },
  {
    id: "window",
    header: "Window",
    question: "Choose the final deployment window after considering the detailed operational tradeoffs.",
    multiSelect: false,
    options: [
      { label: "Morning", description: longDescription },
      { label: "Afternoon", description: longDescription },
      { label: "Evening", description: longDescription },
      { label: "Overnight", description: longDescription },
    ],
  },
];

const replacementQuestions: AgentQuestion[] = [{
  id: "replacement",
  header: "Replacement",
  question: "This is a new request. Choose its answer.",
  multiSelect: false,
  options: [
    { label: "Fresh Answer", description: "Belongs only to the replacement request." },
    { label: "Another Fresh Answer", description: "Also belongs only to the replacement request." },
  ],
}];

const formQuestions: AgentQuestion[] = [
  {
    id: "target",
    header: "Target",
    question: "Choose a deployment target.",
    options: [{ label: "Staging" }, { label: "Production" }],
  },
  {
    id: "checks",
    header: "Checks",
    question: "Choose exactly two checks.",
    multiSelect: true,
    minSelections: 2,
    maxSelections: 2,
    options: [{ label: "Unit Tests" }, { label: "Browser Tests" }, { label: "Smoke Test" }],
  },
  {
    id: "note",
    header: "Note",
    question: "Add an optional note.",
    options: [],
    allowOther: true,
    required: false,
    maxLength: 40,
  },
  {
    id: "token",
    header: "Token",
    question: "Enter the temporary token.",
    options: [],
    allowOther: true,
    secret: true,
    minLength: 3,
    maxLength: 12,
  },
  {
    id: "retries",
    header: "Retries",
    question: "Choose the retry count.",
    options: [],
    allowOther: true,
    inputFormat: "integer",
    minimum: 1,
    maximum: 5,
  },
];

window.agentQuestionCalls = [];

function Fixture() {
  const responseStyle = useQuestionResponseStyle();
  const [requestId, setRequestId] = useState("ask-1");
  const [questions, setQuestions] = useState(
    params.get("set") === "long" ? longQuestions : params.get("set") === "forms" ? formQuestions : shortQuestions,
  );
  const [runnerOnline, setRunnerOnline] = useState(initialOnline);
  const [resolved, setResolved] = useState(false);
  const [answerActive, setAnswerActive] = useState(responseStyle === "composer");
  const answerInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!resolved && responseStyle === "composer") setAnswerActive(true);
  }, [requestId, resolved, responseStyle]);

  window.replaceAgentQuestion = () => {
    setRequestId("ask-2");
    setQuestions(replacementQuestions);
    setResolved(false);
  };
  window.releaseAgentQuestion = () => releasePending?.();
  window.setAgentQuestionOnline = (online) => setRunnerOnline(online);

  const client = useMemo(() => ({
    ...api,
    answerQuestion: async (
      sessionId: string,
      body: { requestId: string; answers: Record<string, string | string[]> },
    ) => {
      window.agentQuestionCalls.push({
        sessionId,
        requestId: body.requestId,
        answers: body.answers,
        action: (body as { action?: "submit" | "dismiss" }).action,
      });
      if (shouldHold) {
        shouldHold = false;
        await new Promise<void>((resolve) => { releasePending = resolve; });
      }
      if (shouldFail) throw new Error("The runner rejected this answer. Try again.");
      return { id: sessionId, pendingApproval: null, status: "running" } as SessionView;
    },
  }), []) as ApiClient;

  const questionContent = resolved ? (
    <p role="status">Question Answered</p>
  ) : (
    <SessionQuestionBanner
      sessionId="agent-question-session"
      requestId={requestId}
      questions={questions}
      recoveryReason={recoveryRequired ? "provider_restart" : undefined}
      recoveryAction={recoveryCanResume ? "resume_answer" : undefined}
      runnerOnline={runnerOnline}
      onSessionUpdate={() => setResolved(true)}
      showKeyHints={false}
    />
  );
  const composerContent = !resolved && responseStyle === "composer" && (!recoveryRequired || recoveryCanResume) ? (
    <div className="composer">
      <div className={`composer-box${answerActive ? " answer-mode" : ""}`}>
        <ComposerQuestionResponse
          sessionId="agent-question-session"
          requestId={requestId}
          questions={questions}
          runnerOnline={runnerOnline}
          active={answerActive}
          showWaiting
          inputRef={answerInputRef}
          onEnter={() => setAnswerActive(true)}
          onExit={() => setAnswerActive(false)}
          onSessionUpdate={() => setResolved(true)}
        />
      </div>
    </div>
  ) : null;

  return (
    <ApiProvider client={client}>
      <main
        id="question-frame"
        className={renderInFallbackSlot ? "session-detail" : "timeline"}
        onKeyDown={(event) => {
          if (renderInFallbackSlot || event.defaultPrevented || inTypingContext(event.currentTarget.ownerDocument)) return;
          if (isFollowTailResumeKey(event)) event.preventDefault();
        }}
      >
        {renderInFallbackSlot ? (
          <div className="detail-columns">
            <div className="detail-chat">
              {questionContent}
              <div className="detail-main">
                <div className="detail-reader">
                  <div className="detail-scroll">Activity Unavailable</div>
                </div>
                {composerContent}
              </div>
            </div>
          </div>
        ) : <>{questionContent}{composerContent}</>}
      </main>
    </ApiProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
