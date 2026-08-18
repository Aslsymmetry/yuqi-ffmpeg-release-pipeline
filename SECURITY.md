# Security policy

Report suspected source, build, manifest-signing, or release compromise privately to the repository owner after the repository is created. Do not attach private keys or secrets to an issue.

Source downloads require HTTPS, initial and final redirect host allowlists, size limits, fixed SHA-256, FFmpeg PGP verification, exact FFmpeg fingerprint, and an exact LAME patch hash. LAME 3.100 has no upstream detached signature; this is a documented provenance limitation.

Release manifests use Ed25519 over canonical JSON. Published `ffmpeg-9.0.1-lame-3.100-r1` and `r2` releases remain schema v1 and verify only with the legacy pinned key `ed25519-sha256:65c3365329bb4384`. Any later release tag is schema v2, requires minimum consumer schema 2, and verifies only with `ed25519-sha256:14b0bbaf1dba378a`.

Production signing derives the public key from the GitHub `production` Environment Secret and selects the pinned trust anchor from the tag-derived manifest schema. Cross-generation signing, unknown schemas, schema downgrades after r2, and key mismatches fail closed.

The active private key exists only in that Environment Secret and an encrypted offline backup. Private keys must never be committed, uploaded as artifacts, printed, or copied into release assets. The legacy public key remains for verification only during the overlap period.
