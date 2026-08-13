# Shared Locations Migration

## Goal

Allow one physical Location—the exact `(runnerId, workspaceId)` pair for a folder on a
Machine—to be linked to more than one Project without moving the folder, reassigning historical
Sessions, or removing it from another Project.

## Compatibility-Preserving Model

`project_locations` becomes the Project-to-Location link table:

- one row remains one stable Project-specific Location link;
- multiple active rows may share the same `(runner_id, workspace_id)` when they belong to different
  Projects;
- one Project may have at most one active link to a particular `(runner_id, workspace_id)`;
- `sessions.project_location_id` continues to reference the Project-specific link selected at
  launch, preserving historical identity and per-Project counts;
- `projects.default_location_id` continues to reference one link owned by that Project.

This avoids rewriting existing Session foreign keys or changing launch request shapes while making
the physical Location reusable.

## Behavior Changes

- **Add Location** adds a link to the target Project and never changes another Project.
- **Remove Location** removes only the target Project's link. The physical folder, other Project
  links, and historical Sessions remain.
- The legacy **Move Location** endpoint remains temporarily compatible for older clients, but the
  current UI no longer offers move semantics.
- Workspace-only legacy Session creation infers a Project only when exactly one active Project link
  exists. Multiple links are ambiguous and therefore resolve to **No Project** unless the caller
  supplies explicit `projectId` and `projectLocationId`.
- Renames, runner discovery, offline state, and runner removal update every Project link for the
  same physical Location.

## Data Migration

On startup:

1. Drop the old unique active-workspace index.
2. Recreate it as a non-unique lookup index.
3. Add a partial unique index on `(project_id, runner_id, workspace_id)` for active links.
4. Preserve all existing rows and IDs; no data rewrite is required.

## Validation

- Database migration and reopen tests.
- Add/remove/default/session-history tests with one Location linked to multiple Projects.
- Authorization and ambiguous legacy-inference tests.
- API integration tests proving add does not mutate the source Project.
- Web unit tests for shared candidate grouping and copy.
- Playwright end-to-end coverage for adding one existing Location to two Projects, launching from
  both, and removing one link without affecting the other.

## Downgrade

After one Workspace is linked to multiple Projects, older control-plane releases cannot open that
database because they enforce one active Project link per Workspace. Restore a pre-upgrade database
backup or remove duplicate active memberships with the current release before downgrading.
