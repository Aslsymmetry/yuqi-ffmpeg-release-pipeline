# Yuqi FFmpeg Release Pipeline

Independent, fail-closed build and release template for the atomic Apple Silicon set `ffmpeg`, `ffprobe`, and `lib/libmp3lame.0.dylib`.

## Fixed policy

- Tag family: `ffmpeg-9.0.1-lame-3.100-rN`, where `N` is a canonical integer greater than zero.
- Assets: `yuqi-ffmpeg-9.0.1-lame-3.100-macos-arm64-rN.{zip,manifest.json,manifest.sig,SHA256SUMS}`
- Runner: official GitHub-hosted `macos-15` arm64 only; the workflow verifies `uname -m` before building.
- Stable consumers must reject draft and prerelease GitHub Releases.
- Sources are only the pinned HTTPS FFmpeg and LAME upstream URLs in `config/source-lock.json`.

## Local build

Use Node 22. Run `npm ci`, `npm run sources:download`, `npm run sources:verify`, `npm run build`, `npm run verify:set`, then generate a temporary Ed25519 key under `/tmp`. Export its PEM values only for the manifest commands; never place a private key in this repository.

The ZIP contains a payload manifest. The separately signed release-envelope manifest contains the ZIP hash and size. A ZIP cannot contain its own final SHA-256 without a circular hash dependency. Consumers verify signature → ZIP hash → strict ZIP entries → internal manifest → binary hashes.

## Release key and rotation

Published schema-v1 `r1` and `r2` assets remain bound to the legacy trust anchor:

- Public key: `trust/production/yuqi-ffmpeg-ed25519-public.pem`
- Fingerprint metadata: `trust/production/yuqi-ffmpeg-ed25519-fingerprint.txt`
- SPKI DER SHA-256: `65c3365329bb4384569541a79a9400415fd04cbc0b7bab462952e59c3f815272`
- Key ID: `ed25519-sha256:65c3365329bb4384`

Any `r3` or later release is forced to manifest schema v2 and the rotation trust anchor:

- Public key: `trust/production/yuqi-ffmpeg-ed25519-v2-public.pem`
- Fingerprint metadata: `trust/production/yuqi-ffmpeg-ed25519-v2-fingerprint.txt`
- SPKI DER SHA-256: `14b0bbaf1dba378ae5f5a4afcdb00483485299723d26a8f9c62cd81ad8692551`
- Key ID: `ed25519-sha256:14b0bbaf1dba378a`

The active production Ed25519 private PKCS#8 PEM exists only in the GitHub `production` Environment Secret `YUQI_FFMPEG_ED25519_PRIVATE_KEY_PEM` and an encrypted offline backup. It is never stored in this repository or release assets. Release metadata derives the allowed schema and signing-key generation from the exact tag. Before signing, the release job derives a public key in memory and fails closed unless it exactly matches the pinned public key for that schema. It then recreates the package manifests with that identity, signs, and verifies before upload.

The legacy private key is not used for new releases. Keep the legacy public key only for verification during the overlap period. Never rotate through an unsigned network manifest or allow a schema-v1 manifest for a post-r2 release tag.

The workflow does not publish on push. `workflow_dispatch` defaults to build-only. Publishing additionally requires an exact protected annotated release tag and explicit `publish=true`. A non-production preflight validates the repository, source-locked versions, revision, tag target, and existing Release state before the production Environment can be entered; the release job then fails closed without the private-key secret.
