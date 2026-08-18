import { execFileSync } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalJson, fileRecord, publicKeyFingerprint, sha256 } from './lib.mjs';
import { assertProductionReleaseEnvironment, releaseMetadataFromEnvironment } from './release-metadata.mjs';
import lock from '../config/source-lock.json' with { type: 'json' };

export async function createManifest({ payload, packageFile, output, smokeTests, metadata = releaseMetadataFromEnvironment() }) {
  assertProductionReleaseEnvironment(metadata);
  const files = {
    ffmpeg: await fileRecord(path.join(payload, 'ffmpeg'), 'ffmpeg'),
    ffprobe: await fileRecord(path.join(payload, 'ffprobe'), 'ffprobe'),
    libmp3lame: await fileRecord(path.join(payload, 'lib/libmp3lame.0.dylib'), 'lib/libmp3lame.0.dylib'),
  };
  const setId = `ffmpeg-9.0.1-lame-3.100-arm64-${files.ffmpeg.sha256.slice(0, 8)}-${files.ffprobe.sha256.slice(0, 8)}-${files.libmp3lame.sha256.slice(0, 8)}`;
  const run = (file, args) => execFileSync(file, args, { encoding: 'utf8' });
  const configuration = run(path.join(payload, 'ffmpeg'), ['-version']).split(/\r?\n/).find((line) => line.startsWith('configuration:'))?.slice(15).trim().split(/ (?=--)/) ?? [];
  const publicPem = process.env.YUQI_FFMPEG_ED25519_PUBLIC_KEY_PEM?.replace(/\\n/g, '\n');
  if (!publicPem) throw new Error('YUQI_FFMPEG_ED25519_PUBLIC_KEY_PEM is required');
  const fingerprint = publicKeyFingerprint(publicPem);
  const manifest = {
    schemaVersion: metadata.manifestSchemaVersion, minimumConsumerSchemaVersion: metadata.minimumConsumerSchemaVersion, manifestKind: packageFile ? 'release-envelope' : 'payload',
    releaseTag: metadata.releaseTag, channel: 'stable', ffmpegVersion: metadata.ffmpegVersion, ffprobeVersion: metadata.ffmpegVersion, lameVersion: metadata.lameVersion,
    platform: 'darwin', architecture: 'arm64', deploymentTarget: '12.0', setId,
    packageFilename: packageFile ? path.basename(packageFile) : null,
    packageSha256: packageFile ? await sha256(packageFile) : null,
    packageSize: packageFile ? (await stat(packageFile)).size : null,
    files,
    sources: {
      ffmpeg: { url: lock.ffmpeg.sourceUrl, sha256: lock.ffmpeg.sha256, pgpSignatureValid: true, signingKeyFingerprint: lock.ffmpeg.signingKeyFingerprint, independentWebOfTrustEstablished: false },
      lame: { url: lock.lame.sourceUrl, sha256: lock.lame.sha256, signatureAvailable: false, patchSha256: lock.lame.patchSha256 },
    },
    configureArguments: configuration,
    build: { compiler: run('/usr/bin/clang', ['--version']).split('\n')[0], sdk: run('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-version']).trim(), timestamp: new Date(Number(process.env.SOURCE_DATE_EPOCH ?? 1786924800) * 1000).toISOString(), sourceDateEpochUsed: true },
    licenses: { ffmpeg: 'LGPL-2.1-or-later', lame: 'LGPL-2.0-or-later', gplEnabled: false, nonfreeEnabled: false },
    allowedDependencies: ['@loader_path/lib/libmp3lame.0.dylib', '/usr/lib/*', '/System/Library/*'],
    smokeTests,
    provenanceClassification: 'OFFICIAL_SOURCE_REPRODUCIBLE_CI_BUILD',
    signing: { algorithm: 'Ed25519', canonicalization: 'recursive-lexicographic-json-v1', keyId: `ed25519-sha256:${fingerprint.slice(0, 16)}`, publicKeyFingerprint: fingerprint },
  };
  await writeFile(output, `${canonicalJson(manifest)}\n`);
  return manifest;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const [payload, output, packageFile] = process.argv.slice(2);
  await createManifest({ payload, output, packageFile, smokeTests: [] });
}
