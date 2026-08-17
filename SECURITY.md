# Security policy

Report suspected source, build, manifest-signing, or release compromise privately to the repository owner after the repository is created. Do not attach private keys or secrets to an issue.

Source downloads require HTTPS, initial and final redirect host allowlists, size limits, fixed SHA-256, FFmpeg PGP verification, exact FFmpeg fingerprint, and an exact LAME patch hash. LAME 3.100 has no upstream detached signature; this is a documented provenance limitation.

Release manifests use Ed25519 over canonical JSON. Private keys must never be committed, uploaded as artifacts, or printed. Production signing fails closed if `YUQI_FFMPEG_ED25519_PRIVATE_KEY_PEM` is absent. Key rotation follows the overlap procedure in README and requires an app update that pins the new public key before its first use.
