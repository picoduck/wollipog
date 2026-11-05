import React, { useId, useState } from "react";
import type { CampaignRepositoryBoundaryView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { projectAvailabilityMeta } from "../project-management.js";
import { Notice } from "./Notice.js";
import { StatusBadge } from "./StatusBadge.js";
import { BusyButton } from "./ui/BusyButton.js";

const REMOVED = { label: "Removed", tone: "danger" as const };

/**
 * A campaign's repository boundary (#4117): every repository it covers with that repository's
 * Locations, the Locations left out and why, the Locations someone else added that wait for the
 * owner, and the Locations that joined after launch. Only the campaign's own session offers
 * Include in Campaign; the server checks that the person is its owner.
 */
export function CampaignRepositories({ campaignId, boundary, canInclude }: {
  campaignId: string;
  boundary: CampaignRepositoryBoundaryView;
  canInclude: boolean;
}) {
  const api = useApi();
  const headingId = useId();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const joinedAt = new Map(boundary.joins.map((join) => [join.locationId, join.revision]));
  const include = async (locationId: string) => {
    if (busy) return;
    setBusy(locationId); setError(null);
    try {
      await api.includeCampaignLocation(campaignId, locationId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not include the Location.");
    } finally {
      setBusy(null);
    }
  };

  return <section className="campaign-detail-section" aria-labelledby={headingId}>
    <h3 id={headingId} className="section-title">Repositories</h3>
    <dl className="facts">
      {boundary.repositories.map((entry) => {
        const usable = entry.locations.some((location) => location.availability === "available");
        return <div key={entry.repository}>
          <dt>{entry.repository}</dt>
          <dd>
            {entry.locations.length === 0 ? "No Locations" : <ul className="campaign-detail-list" aria-label={`Locations of ${entry.repository}`}>
              {entry.locations.map((location) => <li key={location.locationId}>
                {location.name}
                {location.isDefault && <> <span className="project-location-default">Default</span></>}{" "}
                <StatusBadge meta={location.availability === "removed" ? REMOVED : projectAvailabilityMeta(location.availability)} />
                {joinedAt.has(location.locationId) && <span className="campaign-status-meta">Joined at boundary revision {joinedAt.get(location.locationId)}.</span>}
              </li>)}
            </ul>}
            {!usable && <span className="campaign-status-meta">No Location of this repository is available, so it can't take new work until one is.</span>}
          </dd>
        </div>;
      })}
      <div>
        <dt>Boundary Revision</dt>
        <dd>{boundary.revision}</dd>
      </div>
    </dl>
    {boundary.excludedLocations.length > 0 && <>
      <h4 className="section-title">Excluded Locations</h4>
      <ul className="campaign-detail-list" aria-label="Excluded Locations">
        {boundary.excludedLocations.map((location) => <li key={location.locationId}>
          {location.name}
          <span className="campaign-status-meta">{location.reason}</span>
        </li>)}
      </ul>
    </>}
    {boundary.pendingLocations.length > 0 && <>
      <h4 className="section-title">Waiting to Be Included</h4>
      <p className="section-note">Someone else added these Locations to the Project. They join this campaign only if you include them.</p>
      <ul className="campaign-detail-list" aria-label="Locations Waiting to Be Included">
        {boundary.pendingLocations.map((location) => <li key={location.locationId}>
          {location.name}
          {canInclude && <> <BusyButton type="button" className="btn sm" busy={busy === location.locationId} progress="Inspecting the Location…"
            disabled={busy !== null && busy !== location.locationId}
            aria-label={`Include ${location.name} in Campaign`} onClick={() => void include(location.locationId)}>
            Include in Campaign
          </BusyButton></>}
        </li>)}
      </ul>
    </>}
    {error && <Notice tone="danger" role="alert" title="Couldn't Include the Location">{error}</Notice>}
  </section>;
}
