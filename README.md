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

The production public trust anchor is `trust/production/yuqi-ffmpeg-ed25519-public.pem`; its independently recorded metadata is `trust/production/yuqi-ffmpeg-ed25519-fingerprint.txt`.

- Public SPKI DER SHA-256: `65c3365329bb4384569541a79a9400415fd04cbc0b7bab462952e59c3f815272`
- Key ID: `ed25519-sha256:65c3365329bb4384`

The production Ed25519 private PKCS#8 PEM exists only in the GitHub `production` Environment Secret `YUQI_FFMPEG_ED25519_PRIVATE_KEY_PEM` and an encrypted offline backup. It is never stored in this repository or release assets. Before signing, the release job derives a public key in memory and fails closed unless it exactly matches the pinned SPKI public key, fingerprint, and key ID. It then recreates the package manifests with that identity, signs, and verifies before upload. The public SPKI PEM, SHA-256 fingerprint, owner/repository, and allowed key IDs must also be pinned in Yuqi Downloader.

Rotation requires a transition period in which existing and updated app versions can trust the applicable old and new keys. Ship an app release that trusts both keys before publishing with the new key; remove the old key only in a later app release after the transition period. Never rotate through an unsigned network manifest.

The workflow does not publish on push. `workflow_dispatch` defaults to build-only. Publishing additionally requires an exact protected annotated release tag and explicit `publish=true`. A non-production preflight validates the repository, source-locked versions, revision, tag target, and existing Release state before the production Environment can be entered; the release job then fails closed without the private-key secret.
