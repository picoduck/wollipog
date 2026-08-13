# Wollipog v0.16.0 — Final Dogfooding Release

Wollipog v0.16.0 completes the implementation and final acceptance work in the dogfooding plan.
TODO-001's six-stage internal naming migration is implemented, with its documented compatibility
windows deliberately still active. Claude Code subagents have the live dedicated view supported by
their source events; Codex live subagent linkage remains capability-honest until app-server events
expose parent identity.

## Upgrade and Rollback Warning

The control plane continues to advertise the `wollipog-control-plane` service identity. Desktop v0.15.0 and later
accept both the current and legacy identities. Remote-pairing users on v0.14.0 or earlier must
upgrade the desktop before connecting to a v0.16.0 control plane; otherwise the older desktop
reports `The address is not a Wollipog control plane.`

Desktop and development-bootstrap builds must be v0.15.1 or later before they provision or rotate
a runner credential against v0.16.0. The current control plane now issues only `wollipogr_`
credentials, while v0.15.1 is the first release whose strict validators accept that generation.
Existing exact `mamr_` credentials remain valid and are not forcibly rotated.
After a successful legacy authentication, the control plane emits the value-free warning
`a runner authenticated with a legacy credential; rotate it to complete the credential migration`
at most once per runner and process. Malformed or rejected credentials never warn.

Use v0.15.1 as the supported rollback release. Its consumers understand the compatibility state
introduced before this producer cutover, its control plane authenticates stored credential hashes
without depending on the plaintext prefix, and its six canonical/legacy runner asset pairs remain
available. Do not roll a managed desktop below v0.15.1 after a canonical runner credential has been
provisioned unless that credential is reissued through a supported version.
Because the v0.15.1 control plane still issues `mamr_`, publishing v0.16.0 does not satisfy the
credential removal gate.

## What Shipped

- The complete shippable dogfooding roadmap scope: subagent inspection, session timestamps, structured questions,
  artifact-backed prompt images, driver telemetry, Projects/Workspaces hierarchy, transcript
  sharing, workflow reliability, UI ergonomics, and the staged Wollipog internals migration.
- Canonical `wollipogr_`, `wollipogh_`, and `wollipogwhsec_` issuance with legacy acceptance or
  opaque existing-secret validity preserved at the appropriate boundary.
- Dual checkpoint namespaces with canonical-first reconciliation and rollback-safe cleanup.
- Canonical-first Docker discovery and dual label production through the compatibility window.
- Canonical runner assets and standalone installation paths, with byte-identical legacy executable
  aliases and credential-preserving legacy configuration selection. A canonical config wins;
  otherwise an existing legacy config remains in place and is never copied or rewritten.
- Browser storage, composer, wire, service-marker, installer, and environment migrations that read
  retained legacy state while ordinary new writes and current producers use Wollipog identities.
  Legacy `mam.*` keys and the composer database are silent, read-only copy-forward inputs, and
  deletion tombstones prevent their data from being resurrected.
- A final mixed-version proof in which the published v0.15.1 ARM64 runner authenticated to the
  current control plane with a canonical credential and completed an approval-gated browser session.

## Compatibility Windows That Remain Active

Legacy environment aliases and security scrubbers, browser migration readers, `mamr_` and `mamh_`
acceptors, existing `mamwhsec_` secrets, `refs/mam/*`, legacy wire/service markers, Docker labels,
runner asset aliases, and standalone executable/config fallbacks remain intentional. Their removal
requires the rotation, ownership, soak, rollback, and operator evidence documented in the
dogfooding log; elapsed time alone is not sufficient.

v0.15.1 and v0.16.0 provide the two consecutive stable releases with dual-published runner assets,
but the asset aliases and absence-only fallback remain until the window has ended, supported
consumers are silent, and final upgrade/rollback fixtures pass. The legacy-asset, legacy-config,
locked-alias, and legacy-container diagnostics remain bounded and value-free.

The `.agent-manager` data root, `ai.misko.agent-manager` bundle identifier, `MAMHIDX1` file magic,
SSH-managed command path, and current repository slug remain stable or externally coordinated by
explicit decision. They are not unfinished rename work.

The final acceptance record does not claim a new native container E2E; Docker identities are
covered by their component and integration suites. Desktop bundles remain unsigned, so operating
systems may show an unidentified-developer warning on first launch.

The release workflow publishes all six native runner targets under canonical and legacy names,
verifies each pair is byte-identical, checks native `--version`, and gates publication on the exact
27-asset inventory with `SHA256SUMS`.
