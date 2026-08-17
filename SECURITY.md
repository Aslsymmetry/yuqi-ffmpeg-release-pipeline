# Security policy

Report suspected source, build, manifest-signing, or release compromise privately to the repository owner after the repository is created. Do not attach private keys or secrets to an issue.

Source downloads require HTTPS, initial and final redirect host allowlists, size limits, fixed SHA-256, FFmpeg PGP verification, exact FFmpeg fingerprint, and an exact LAME patch hash. LAME 3.100 has no upstream detached signature; this is a documented provenance limitation.

Release manifests use Ed25519 over canonical JSON. The production trust anchor is `trust/production/yuqi-ffmpeg-ed25519-public.pem`, with SPKI DER SHA-256 `65c3365329bb4384569541a79a9400415fd04cbc0b7bab462952e59c3f815272` and key ID `ed25519-sha256:65c3365329bb4384`. Production signing fails closed unless the public key derived from the GitHub `production` Environment Secret exactly matches that public key, fingerprint, and key ID.

The private key exists only in that Environment Secret and an encrypted offline backup. Private keys must never be committed, uploaded as artifacts, or printed. Key rotation follows the overlap procedure in README: existing and updated app versions need a transition period that trusts the applicable old and new keys before the signing key changes.
