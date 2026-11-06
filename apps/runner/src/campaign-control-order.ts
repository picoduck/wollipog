import type { CampaignControl } from "@wollipog/protocol";

/** A runner's diagnostic copy of its campaign's control, with the authoritative control revision
 * (the campaign root's policy revision) the control plane read it at (#3363). */
export interface OrderedCampaignControl {
  control?: CampaignControl;
  controlRevision?: number;
}

/** Whether `value` can order control: a non-negative safe integer, or absent. */
export function validControlRevision(value: unknown): value is number | undefined {
  return value === undefined || Number.isSafeInteger(value) && (value as number) >= 0;
}

/**
 * The control a runner keeps after an authoritative update offers `incoming` (#3363). Issue-scope
 * ordering cannot tell two controls of one scope revision apart, so control has its own order:
 *
 * - An ordered update (with `controlRevision`) replaces the held control unless the runner already
 *   holds a newer revision; a delayed or reordered older update is ignored (`kept_newer`).
 * - An unordered update (an older control plane) replaces it as before while nothing ordered is
 *   held. Once an ordered control is held, an unordered one may only narrow it to Custom, keeping
 *   the held revision: a stale diagnostic never becomes Full Control again.
 * - An update without control leaves the held control and revision as they are.
 *
 * This is a diagnostic copy only. The server rechecks current authority before every consumption.
 */
export function nextCampaignControl(held: OrderedCampaignControl | undefined, incoming: OrderedCampaignControl):
  OrderedCampaignControl & { outcome: "applied" | "kept_newer" | "unchanged" } {
  const kept = { ...(held?.control === undefined ? {} : { control: held.control }),
    ...(held?.controlRevision === undefined ? {} : { controlRevision: held.controlRevision }) };
  if (incoming.control === undefined) return { ...kept, outcome: "unchanged" };
  const heldRevision = held?.controlRevision;
  if (incoming.controlRevision !== undefined) {
    if (heldRevision !== undefined && incoming.controlRevision < heldRevision) return { ...kept, outcome: "kept_newer" };
    return { control: incoming.control, controlRevision: incoming.controlRevision, outcome: "applied" };
  }
  if (heldRevision === undefined) return { control: incoming.control, outcome: "applied" };
  if (incoming.control.mode === "custom") return { control: incoming.control, controlRevision: heldRevision, outcome: "applied" };
  return { ...kept, outcome: "kept_newer" };
}

type OrchestratorMeta = OrderedCampaignControl & { issueScope?: { revision: number } };

/** The Orchestrator metadata a (re)launch persists: a saved copy at a newer issue-scope revision
 * stays, as before; otherwise the launch's own, except that its control follows the same order as
 * a synchronization's (#3363). A control the launch carries never replaces a newer one the runner
 * already holds, and a launch without control (an older control plane's relaunch) keeps the held
 * ordered control and its revision, so the fence survives the relaunch. Without an ordered control
 * held, a launch without control keeps today's behavior and persists none. */
export function launchOrchestratorMeta<P extends OrchestratorMeta, S extends OrchestratorMeta>(
  saved: P | undefined, spec: S | undefined): P | S | undefined {
  if ((saved?.issueScope?.revision ?? 0) > (spec?.issueScope?.revision ?? 0) || !spec) return saved;
  if (spec.control === undefined && saved?.controlRevision === undefined) return spec;
  const ordered = nextCampaignControl(saved, spec);
  const { control: _control, controlRevision: _revision, ...rest } = spec;
  return { ...rest, ...(ordered.control === undefined ? {} : { control: ordered.control }),
    ...(ordered.controlRevision === undefined ? {} : { controlRevision: ordered.controlRevision }) } as S;
}
