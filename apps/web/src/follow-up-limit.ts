/**
 * How many follow-ups a campaign has accepted against its approval limit (#2940), as one phrase for
 * Campaign Status and the follow-up approval card. The limit counts follow-ups that start without
 * approval, so accepted follow-ups beyond it are named as past the limit, never as "4 of 3". They can
 * be there because the person approved them or because the person lowered the limit later.
 */
export function followUpLimitText(accepted: number, limit: number | null | undefined): string {
  if (limit === null || limit === undefined) return `${accepted} follow-up${accepted === 1 ? "" : "s"} accepted, no approval limit`;
  const within = Math.min(accepted, limit);
  const past = accepted - within;
  return `${within} of ${limit} follow-up${limit === 1 ? "" : "s"} without approval${past > 0 ? `, ${past} past the limit` : ""}`;
}
