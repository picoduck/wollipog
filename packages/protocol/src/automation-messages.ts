/* Sentences an automation shows when its agent installation or target is unavailable. The control
 * plane stores the target reasons as `targetHealth.error` and as an expired run's error, and the
 * Automations view renders them as-is, so both sides read the same sentence from here (#3220).
 * Wording follows docs/design-system.md §17: sentence case and user nouns ("machine", "workspace",
 * "project" in lowercase prose; "Machine Settings" names a dialog). */

/** No candidate target could run the automation because its saved installation isn't available. */
export const AUTOMATION_TARGET_INSTALLATION_UNAVAILABLE =
  "This automation's agent installation isn't available on any of its machines. " +
  "Choose an installation in Machine Settings, or edit the automation to choose another machine.";

/** No candidate target is online, current enough, or still has the workspace and project. */
export const AUTOMATION_TARGET_UNAVAILABLE =
  "None of this automation's machines can run it now. " +
  "Check that the machine is online and up to date and still has the workspace and project.";

/** The Automations card: a saved installation of this automation is not available. */
export const AUTOMATION_INSTALLATION_UNAVAILABLE =
  "This automation's agent installation isn't available. Edit the automation to choose another installation.";

/** Saving the editor after choosing to use the current installation, when none is available. */
export const AUTOMATION_CHOOSE_INSTALLATION = "Choose an available installation of this agent on this machine.";

/** The same, for the alternate target. */
export const AUTOMATION_CHOOSE_ALTERNATE_INSTALLATION =
  "Choose an available installation of this agent on the other machine.";

/* Editor warnings beside an agent field whose saved installation is no longer available. */

export const AUTOMATION_SAVED_INSTALLATION_UNAVAILABLE =
  "The saved installation of this agent isn't available. This automation waits until you choose an available installation.";
export const AUTOMATION_SAVED_ALTERNATE_INSTALLATION_UNAVAILABLE =
  "The saved installation of this agent isn't available on the other machine.";
export const AUTOMATION_SAVED_ROLE_INSTALLATION_UNAVAILABLE = "The saved installation of this role's agent isn't available.";
export const AUTOMATION_SAVED_ALTERNATE_ROLE_INSTALLATION_UNAVAILABLE =
  "The saved installation of this role's agent isn't available on the other machine.";
export const AUTOMATION_SAVED_ORCHESTRATOR_INSTALLATION_UNAVAILABLE =
  "The saved installation of the Orchestrator's agent isn't available.";
export const AUTOMATION_SAVED_ALTERNATE_ORCHESTRATOR_INSTALLATION_UNAVAILABLE =
  "The saved installation of the Orchestrator's agent isn't available on the other machine.";

/** Saving a workflow automation whose role (`Reviewer`) or `the Orchestrator` has no available installation. */
export function automationChooseWorkflowInstallation(label: string, alternate: boolean): string {
  return `Choose an available installation of the agent for ${label} on ${alternate ? "the other" : "this"} machine.`;
}
