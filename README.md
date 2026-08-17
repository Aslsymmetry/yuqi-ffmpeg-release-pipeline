# Yuqi FFmpeg Release Pipeline

Independent, fail-closed build and release template for the atomic Apple Silicon set `ffmpeg`, `ffprobe`, and `lib/libmp3lame.0.dylib`.

## Fixed policy

- Tag: `ffmpeg-9.0.1-lame-3.100-r1`
- Assets: `yuqi-ffmpeg-9.0.1-lame-3.100-macos-arm64-r1.{zip,manifest.json,manifest.sig,SHA256SUMS}`
- Runner: official GitHub-hosted `macos-15` arm64 only; the workflow verifies `uname -m` before building.
- Stable consumers must reject draft and prerelease GitHub Releases.
- Sources are only the pinned HTTPS FFmpeg and LAME upstream URLs in `config/source-lock.json`.

## Local build

Use Node 22. Run `npm ci`, `npm run sources:download`, `npm run sources:verify`, `npm run build`, `npm run verify:set`, then generate a temporary Ed25519 key under `/tmp`. Export its PEM values only for the manifest commands; never place a private key in this repository.

The ZIP contains a payload manifest. The separately signed release-envelope manifest contains the ZIP hash and size. A ZIP cannot contain its own final SHA-256 without a circular hash dependency. Consumers verify signature → ZIP hash → strict ZIP entries → internal manifest → binary hashes.

## Release key and rotation

The production Ed25519 private PKCS#8 PEM is stored only as the encrypted Actions secret `YUQI_FFMPEG_ED25519_PRIVATE_KEY_PEM`. The release job derives the public key in memory, recreates the package manifests with that key identity, signs, and verifies before upload. Its public SPKI PEM, SHA-256 fingerprint, owner/repository, and allowed key IDs must be pinned in Yuqi Downloader. Rotation requires an app release that trusts both old and new public keys; publish with the new key only after that app is deployed, then remove the old key in a later app release. Never rotate through an unsigned network manifest.

The workflow does not publish on push. `workflow_dispatch` defaults to build-only. Publishing additionally requires an exact protected release tag and explicit `publish=true`; the release job fails closed without the private-key secret.
