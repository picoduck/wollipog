# Navigation and internal session links

The dashboard has one canonical URL for every application view. The URL and the external store are
kept in lockstep without a second router state:

| View | Canonical path |
| --- | --- |
| Board | `/` |
| Connections | `/connections` (`/runners` remains a legacy alias) |
| Multi-Agent runs | `/runs` |
| Run detail | `/runs/:id` |
| Collaboration pods | `/pods` |
| Pod detail | `/pods/:id` |
| Automations | `/automations` |
| Session detail | `/sessions/:id` |

Resource ids are encoded from their exact UTF-16LE code units as one marker-prefixed, alphabet-only
base64url segment and decoded back to their exact value. The marker prevents valid `.` and `..` ids
from becoming browser navigation segments. This preserves
the control plane's existing nonblank 256-character session-id contract, including spaces, Unicode,
percent signs, query/hash characters, and encoded slashes. Malformed escapes, blank ids, oversized
ids, extra literal segments, and unknown paths resolve to Board and replace the address with `/`.

## History and direct loads

- In-app navigation adds one browser history entry only when the destination changes.
- Back and Forward dispatch through the existing store navigation reducer without adding another
  entry. That reducer remains responsible for pruning off-view timelines, shell scrollback, pod
  context, and recovery cursors.
- The initial URL becomes the store's initial view before the UI WebSocket opens, so a copied session
  URL subscribes to that session immediately and never briefly requests Board streams.
- The control plane serves the marked app shell for extensionless client routes while keeping API,
  WebSocket, hook, asset, and credential-bearing misses out of the SPA fallback.
- Packaged Tauri 2.11.3 uses its built-in final `index.html` asset fallback for unknown deep paths;
  Vite and the control-plane-hosted web bundle provide the equivalent development/browser fallback.

Legacy push-notification destinations (`#open=...` and `#view=automations`) are replaced with their
canonical paths before React starts. Newly installed service workers open canonical paths directly.
Existing-client notification messages use the same store navigation path as clicks inside the app.

## Credential and sharing boundary

Pairing and public transcript capabilities remain fragment-only boot modes:

- `#pair=...` is adopted and scrubbed before route initialization while preserving the path.
- `#share=...` boots the isolated read-only transcript application and never constructs the normal
  store, WebSocket, service worker, or navigation bridge.
- Canonicalization preserves existing `history.state` fields and removes query/hash material from
  normal dashboard routes.

The session action menu can copy an internal session URL. This link grants no capability: the
recipient still needs network access to the dashboard/control plane and an authorized paired-device
token. When the UI is hosted by the control plane or Vite, the link uses the browser origin. A Tauri
origin exists only inside that desktop process, so its copy action remains disabled unless the build
sets `VITE_DASHBOARD_ORIGIN` to an explicit browser-hosted dashboard origin. It never invents a
recipient-local `127.0.0.1` link.

Archived sessions are omitted from the bounded live snapshot. Session deep links therefore perform
one exact, authorized `GET /api/sessions/lookup/by-id?id=...` lookup and upsert that result into the
same store. Keeping the identifier in a query value prevents URL-path normalization from changing
ids that contain slashes or dot segments; a guessed or inaccessible id retains the normal uniform
`404` boundary. Run/pod links wait for the authoritative initial snapshot. None of the detail views
claims a resource is missing while its authoritative source is still loading.

## Extending navigation

Add a new member to `View`, then update both `viewPath()` and `viewFromPath()` in
`apps/web/src/navigation.ts` and add a round-trip case in `navigation.test.ts`. All navigation must
continue through `Store.navigate()` so history, stream pruning, and subscription selection remain
one atomic application transition.
