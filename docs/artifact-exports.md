# Authenticated raw workflow artifact exports

Workflow run artifact previews include **Download raw artifact**. The download is the exact
validated content stored for the artifact: UTF-8 bytes for patches, reports, logs, and verdict JSON,
or decoded PNG/JPEG/JPG/GIF/WebP bytes for screenshots. It is not a transcript projection and receives no
operational redaction. Artifacts may contain source code, secrets, command output, personal data, or
other sensitive material; review the preview and provenance before downloading or redistributing it.

## API and authorization

`GET /api/artifacts/:artifactId/export` is an authenticated human-only route. Remote dashboards
send the paired-device credential in `Authorization: Bearer`; the token never appears in the path,
query, filename, or Blob URL. Conductors cannot use the route. Organization viewers and operators
may download an artifact only when its session, or its run's runner/workspace scope, is readable to
them. Missing and out-of-scope artifacts both return a content-free `404`.

The browser fetches the response into a temporary Blob URL and revokes that URL after the download
has had time to start on mobile browsers. It never navigates to a token-bearing URL.

## Integrity and response boundary

Before loading the body, the control plane reads bounded SQLite metadata and the decoded byte size,
applies the artifact's session/run scope, and rejects oversized metadata before touching the blob.
It then reads the content-addressed sidecar file, re-verifies its exact size and SHA-256, and
re-runs the original kind/MIME/encoding/name/metadata/content validation and recomputes decoded
size and SHA-256. A corrupt, legacy-out-of-contract, or tampered row returns `422` without serving
content. This covers canonical JSON, canonical base64, image signatures, decoded byte ceilings,
and the original immutable digest.

Successful responses use the validated MIME type, exact byte length, and a fixed ASCII filename
whose extension is derived only from the validated artifact kind/MIME contract. Agent-authored
display names never choose an executable download extension. Responses also use `Cache-Control:
private, no-store`, `Pragma: no-cache`, `Vary: Authorization`, `nosniff`, and a sandboxed deny-all CSP.
Text and JSON responses declare UTF-8. No metadata wrapper, session title, prompt, token, or digest
is mixed into the downloaded bytes.

## Current storage boundary

SQLite stores artifact provenance, presentation metadata, size, SHA-256, and the content key but an
empty inline body. Decoded immutable bytes live in the content-addressed artifact sidecar described
in [artifact blob storage](./artifact-blob-storage.md). Database and sidecar must be backed up and
restored together. Prompt-image references and [large session-event payloads](./large-event-payloads.md)
reuse this authenticated, integrity-checked substrate. Public artifact share links and broader
terminal/generated-file migration remain later roadmap slices.
