import type { ReactNode } from "react";
import type { AssistantThread } from "@wollipog/protocol";
import { useAccountEmailPrivacy } from "../account-email-privacy.js";
import type { AssistantThreadProblem } from "../assistant-thread-health.js";
import { formatFuture } from "../format.js";
import { accountLabelText } from "../personal-identifiers.js";
import { useTimelineClock } from "../timeline-clock.js";
import { withoutPromptFailedPrefix } from "../timeline.js";
import { AUTOMATIC_TURNS_HELD_SENTENCE } from "../turn-error.js";
import { Notice } from "./Notice.js";

export function AssistantThreadProblemNotice({ problem, thread, machine, trailing, details, switchAccount, signIn,
  restart, openMachine, actionError }: {
  problem: AssistantThreadProblem;
  thread: AssistantThread;
  machine: string;
  trailing: ReactNode;
  details?: string;
  switchAccount: ReactNode;
  signIn: ReactNode;
  restart: ReactNode;
  openMachine: ReactNode;
  actionError?: string;
}) {
  const privacy = useAccountEmailPrivacy();
  const account = accountLabelText(thread.providerAccountLabel ?? "Machine Sign-In", "the selected account", privacy.hide);
  const reset = thread.health?.usageLimit?.resetsAt;
  const now = useTimelineClock(problem.key === "usage_limit" && reset !== undefined);
  const resetTime = reset === undefined ? "" : formatFuture(reset, now);
  let title = problem.title;
  let body: string;
  let actions: ReactNode;
  switch (problem.key) {
    case "usage_limit":
      body = account + " reached its usage limit. " + (resetTime
        ? "The assistant continues when it resets at " + resetTime + "."
        : "The assistant continues when the account has available usage.");
      actions = switchAccount;
      break;
    case "turn_rejected":
      body = "The provider rejected the turn before it started.";
      break;
    case "automatic_turns_held":
      body = AUTOMATIC_TURNS_HELD_SENTENCE;
      break;
    case "sign_in_needed":
      body = "Sign in to " + account + " to continue this thread.";
      actions = <>{signIn}{switchAccount}</>;
      break;
    case "machine_offline":
      title = machine + " Is Offline";
      body = "Messages wait until it reconnects.";
      actions = openMachine;
      break;
    case "tools_unavailable":
      body = "Wollipog rejected this thread’s tool key. Restart the thread to reconnect its tools.";
      actions = restart;
      break;
    default:
      body = "Messages are queued.";
  }
  const hasDetails = problem.key === "turn_rejected" || problem.key === "automatic_turns_held";
  return <Notice tone={problem.severity} role={problem.severity === "danger" ? "alert" : "status"}
    title={title} trailing={trailing} compact={problem.key === "reconnecting"} actions={actions}
    details={hasDetails ? <div className="code-well"><pre>
      {details ? withoutPromptFailedPrefix(details) : "Provider details are unavailable."}
    </pre></div> : undefined}>
    <p>{body}</p>
    {actionError && <p className="notice-meta" role="alert">{actionError}</p>}
  </Notice>;
}
