import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { assertProductionReleaseEnvironment, parseReleaseTag } from '../scripts/release-metadata.mjs';

test('r2 metadata creates the exact title and four asset names', () => {
  const value = parseReleaseTag('ffmpeg-9.0.1-lame-3.100-r2');
  assert.deepEqual(value, {
    releaseTag: 'ffmpeg-9.0.1-lame-3.100-r2', ffmpegVersion: '9.0.1', lameVersion: '3.100', revision: 2, revisionLabel: 'r2',
    releaseTitle: 'FFmpeg 9.0.1 + LAME 3.100 r2', assetBase: 'yuqi-ffmpeg-9.0.1-lame-3.100-macos-arm64-r2',
    assetNames: [
      'yuqi-ffmpeg-9.0.1-lame-3.100-macos-arm64-r2.zip',
      'yuqi-ffmpeg-9.0.1-lame-3.100-macos-arm64-r2.manifest.json',
      'yuqi-ffmpeg-9.0.1-lame-3.100-macos-arm64-r2.manifest.sig',
      'yuqi-ffmpeg-9.0.1-lame-3.100-macos-arm64-r2.SHA256SUMS',
    ],
  });
});

for (const revision of [1, 3, 27]) test(`revision r${revision} is accepted`, () => {
  assert.equal(parseReleaseTag(`ffmpeg-9.0.1-lame-3.100-r${revision}`).revision, revision);
});

for (const invalid of [
  'ffmpeg-9.0.1-lame-3.100-r0', 'ffmpeg-9.0.1-lame-3.100-r01', 'ffmpeg-9.0.1-lame-3.100-r-2',
  'ffmpeg-9.0.1-lame-3.100-r2.0', ' ffmpeg-9.0.1-lame-3.100-r2', 'ffmpeg-9.0.1-lame-3.100-r2 ',
  'ffmpeg-9.0.1-lame-3.100-r2-extra', 'ffmpeg-9.0.2-lame-3.100-r2', 'ffmpeg-9.0.1-lame-3.101-r2',
  'ffmpeg-9.0.1-lame-3.100-r2/path', 'ffmpeg-9.0.1-lame-3.100-r2%2Fpath',
]) test(`invalid release tag is rejected: ${invalid}`, () => assert.throws(() => parseReleaseTag(invalid)));

test('production scripts reject tampered preflight metadata and ref mismatch', () => {
  const metadata = parseReleaseTag('ffmpeg-9.0.1-lame-3.100-r2');
  const environment = {
    YUQI_PRODUCTION_RELEASE: 'true', GITHUB_REPOSITORY: 'Aslsymmetry/yuqi-ffmpeg-release-pipeline', GITHUB_REF_TYPE: 'tag',
    GITHUB_REF: `refs/tags/${metadata.releaseTag}`, GITHUB_REF_NAME: metadata.releaseTag,
    YUQI_RELEASE_TAG: metadata.releaseTag, YUQI_RELEASE_TITLE: metadata.releaseTitle, YUQI_ASSET_BASE: metadata.assetBase,
    YUQI_FFMPEG_VERSION: metadata.ffmpegVersion, YUQI_LAME_VERSION: metadata.lameVersion, YUQI_REVISION_LABEL: metadata.revisionLabel,
  };
  assert.equal(assertProductionReleaseEnvironment(metadata, environment), metadata);
  assert.throws(() => assertProductionReleaseEnvironment(metadata, { ...environment, YUQI_ASSET_BASE: `${metadata.assetBase}-tampered` }));
  assert.throws(() => assertProductionReleaseEnvironment(metadata, { ...environment, GITHUB_REF: 'refs/tags/ffmpeg-9.0.1-lame-3.100-r3' }));
});

test('production package, manifest, signing and Draft scripts share the metadata module', async () => {
  for (const name of ['create-release-package.mjs', 'create-manifest.mjs', 'create-signed-release.mjs', 'create-draft-release.mjs']) {
    assert.match(await readFile(new URL(`../scripts/${name}`, import.meta.url), 'utf8'), /releaseMetadataFromEnvironment/);
  }
});
