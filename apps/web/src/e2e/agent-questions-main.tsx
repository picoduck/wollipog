import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AgentQuestion, SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { SessionQuestionBanner } from "../components/SessionApproval.js";
import "../styles.css";

interface AnswerCall {
  sessionId: string;
  requestId: string;
  answers: Record<string, string | string[]>;
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
const initialOnline = params.get("offline") !== "1";
const shouldFail = params.get("failure") === "1";
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

window.agentQuestionCalls = [];

function Fixture() {
  const [requestId, setRequestId] = useState("ask-1");
  const [questions, setQuestions] = useState(params.get("set") === "long" ? longQuestions : shortQuestions);
  const [runnerOnline, setRunnerOnline] = useState(initialOnline);
  const [resolved, setResolved] = useState(false);

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
      window.agentQuestionCalls.push({ sessionId, requestId: body.requestId, answers: body.answers });
      if (shouldHold) {
        shouldHold = false;
        await new Promise<void>((resolve) => { releasePending = resolve; });
      }
      if (shouldFail) throw new Error("The runner rejected this answer. Try again.");
      return { id: sessionId, pendingApproval: null, status: "running" } as SessionView;
    },
  }), []) as ApiClient;

  return (
    <ApiProvider client={client}>
      <main id="question-frame">
        {resolved ? (
          <p role="status">Question Answered</p>
        ) : (
          <SessionQuestionBanner
            sessionId="agent-question-session"
            requestId={requestId}
            questions={questions}
            runnerOnline={runnerOnline}
            onSessionUpdate={() => setResolved(true)}
            showKeyHints={false}
          />
        )}
      </main>
    </ApiProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
