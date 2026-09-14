import type {
  AutomationExecution,
  AutomationNotificationEvent,
  AutomationSchedule,
} from "@wollipog/protocol";
import type { PushMessage } from "./web-push.js";

type AutomationPushSource = Pick<AutomationSchedule, "automationId" | "name">;
type AutomationPushExecution = Pick<AutomationExecution, "error">;

/** Build the encrypted notification card without copying execution details into terminal alerts.
 * The execution argument remains part of the notifier contract so the regression test can prove
 * that failure and expiry messages ignore it. Authenticated execution history keeps the details. */
export function automationPushMessage(
  automation: AutomationPushSource,
  _execution: AutomationPushExecution,
  event: AutomationNotificationEvent,
): PushMessage {
  const common = {
    notificationKey: `automation:${automation.automationId}`,
    view: "automations",
  } as const;

  switch (event) {
    case "failed":
      return {
        ...common,
        title: "Automation Failed",
        body: "Open Automations to inspect the failed execution.",
        urgency: "high",
      };
    case "expired":
      return {
        ...common,
        title: "Automation Expired",
        body: "Open Automations to inspect the expired execution.",
        urgency: "high",
      };
    case "started":
      return {
        ...common,
        title: `${automation.name} started`.slice(0, 120),
        body: "The scheduled action was accepted and is running.",
        urgency: "normal",
      };
    case "succeeded":
      return {
        ...common,
        title: `${automation.name} completed`.slice(0, 120),
        body: "The scheduled action completed successfully.",
        urgency: "normal",
      };
  }
}
