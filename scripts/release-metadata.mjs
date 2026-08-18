import lock from '../config/source-lock.json' with { type: 'json' };

export const FIXTURE_RELEASE_TAG = `ffmpeg-${lock.ffmpeg.version}-lame-${lock.lame.version}-r1`;
export const LEGACY_SCHEMA_V1_RELEASE_TAGS = Object.freeze([
  'ffmpeg-9.0.1-lame-3.100-r1',
  'ffmpeg-9.0.1-lame-3.100-r2',
]);

export function manifestPolicyForReleaseTag(releaseTag) {
  const schemaVersion = LEGACY_SCHEMA_V1_RELEASE_TAGS.includes(releaseTag) ? 1 : 2;
  return Object.freeze({
    manifestSchemaVersion: schemaVersion,
    minimumConsumerSchemaVersion: schemaVersion,
    signingKeyGeneration: schemaVersion === 1 ? 'v1' : 'v2',
  });
}

export function parseReleaseTag(value) {
  if (typeof value !== 'string') throw new Error('Release tag must be a string');
  const match = /^ffmpeg-([0-9]+(?:\.[0-9]+)*)-lame-([0-9]+(?:\.[0-9]+)*)-r([1-9][0-9]*)$/.exec(value);
  if (!match) throw new Error('Release tag does not match the exact policy format');
  const [, ffmpegVersion, lameVersion, revisionText] = match;
  if (ffmpegVersion !== lock.ffmpeg.version || lameVersion !== lock.lame.version) throw new Error('Release tag source versions do not match source-lock.json');
  const revision = Number(revisionText);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('Release revision is invalid');
  const revisionLabel = `r${revision}`;
  const releaseTag = `ffmpeg-${ffmpegVersion}-lame-${lameVersion}-${revisionLabel}`;
  if (releaseTag !== value) throw new Error('Release tag is not canonical');
  const assetBase = `yuqi-ffmpeg-${ffmpegVersion}-lame-${lameVersion}-macos-arm64-${revisionLabel}`;
  const manifestPolicy = manifestPolicyForReleaseTag(releaseTag);
  return Object.freeze({
    releaseTag,
    ffmpegVersion,
    lameVersion,
    revision,
    revisionLabel,
    releaseTitle: `FFmpeg ${ffmpegVersion} + LAME ${lameVersion} ${revisionLabel}`,
    assetBase,
    ...manifestPolicy,
    assetNames: Object.freeze([
      `${assetBase}.zip`,
      `${assetBase}.manifest.json`,
      `${assetBase}.manifest.sig`,
      `${assetBase}.SHA256SUMS`,
    ]),
  });
}

function required(environment, name) {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function assertProductionReleaseEnvironment(metadata, environment = process.env) {
  if (environment.YUQI_PRODUCTION_RELEASE !== 'true') return metadata;
  if (required(environment, 'GITHUB_REPOSITORY') !== 'Aslsymmetry/yuqi-ffmpeg-release-pipeline') throw new Error('Production repository mismatch');
  if (required(environment, 'GITHUB_REF_TYPE') !== 'tag') throw new Error('Production ref type must be tag');
  if (required(environment, 'GITHUB_REF') !== `refs/tags/${metadata.releaseTag}`) throw new Error('Production ref does not match release metadata');
  if (required(environment, 'GITHUB_REF_NAME') !== metadata.releaseTag) throw new Error('Production ref name does not match release metadata');
  const expected = {
    YUQI_RELEASE_TAG: metadata.releaseTag,
    YUQI_RELEASE_TITLE: metadata.releaseTitle,
    YUQI_ASSET_BASE: metadata.assetBase,
    YUQI_FFMPEG_VERSION: metadata.ffmpegVersion,
    YUQI_LAME_VERSION: metadata.lameVersion,
    YUQI_REVISION_LABEL: metadata.revisionLabel,
    YUQI_MANIFEST_SCHEMA_VERSION: String(metadata.manifestSchemaVersion),
    YUQI_MINIMUM_CONSUMER_SCHEMA_VERSION: String(metadata.minimumConsumerSchemaVersion),
    YUQI_SIGNING_KEY_GENERATION: metadata.signingKeyGeneration,
  };
  for (const [name, value] of Object.entries(expected)) if (required(environment, name) !== value) throw new Error(`${name} does not match parsed release metadata`);
  return metadata;
}

export function releaseMetadataFromEnvironment(environment = process.env) {
  const tag = environment.YUQI_RELEASE_TAG || (environment.YUQI_NONPRODUCTION_FIXTURE === 'true' && environment.YUQI_PRODUCTION_RELEASE !== 'true' ? FIXTURE_RELEASE_TAG : undefined);
  if (!tag) throw new Error('YUQI_RELEASE_TAG is required');
  return assertProductionReleaseEnvironment(parseReleaseTag(tag), environment);
}
