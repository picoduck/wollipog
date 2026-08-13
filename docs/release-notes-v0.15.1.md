# Wollipog v0.15.1 — Compatibility Release A

Wollipog v0.15.1 is Compatibility Release A for the staged runner-credential
and durable-identity migrations. It deliberately ships compatible consumers,
dual identities, and rollback bridges around producer cutovers before later
removal gates.

Compatibility warning: v0.15.1 control planes now advertise the
`wollipog-control-plane` service identity. Desktop v0.15.0 and later accept both
the current and legacy identities. Remote-pairing users on v0.14.0 or earlier
must upgrade the desktop before connecting to a v0.15.1 control plane; otherwise
the older desktop reports `The address is not a Wollipog control plane.` This
release also completes the Wollipog-generation producer cutovers for conductor,
policy-hook, transcript-share, and service-worker identities while retaining the
documented compatibility readers.

Desktop provisioning and development bootstrap accept both exact `mamr_` and
`wollipogr_` runner credentials. The control plane intentionally continues
issuing `mamr_` credentials until this release is published and verified.
Existing credentials remain valid without database migration or forced rotation.

Compatibility diagnostics now ensure so canonical values, including
explicitly empty ones, retain new-first precedence without warnings. A legacy
alias warns only when it supplies the effective value.

Runner releases now publish byte-identical canonical
`wollipog-runner-<triple>[.exe]` and legacy
`agent-manager-runner-<triple>[.exe]` assets for all six native targets.
`SHA256SUMS` covers all twelve names, while publisher digests, native
`--version`, pair equality, and the exact 27-asset hosted inventory are verified
before publication. Consumers prefer canonical assets and retain absence-only
legacy fallback for rollback compatibility.

Fresh standalone installs use the canonical Wollipog executable and config
locations while refreshing a compatible legacy executable alias. Existing
credential-bearing legacy configs remain byte-for-byte in place and are never
copied or overwritten; canonical configs take precedence when present.
