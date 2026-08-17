import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ROOT, canonicalJson, publicKeyFingerprint, sha256 } from '../scripts/lib.mjs';
import { parseReleaseTag } from '../scripts/release-metadata.mjs';

const run = (file, args, options = {}) => execFileSync(file, args, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, ...options });
const key = generateKeyPairSync('ed25519');
const privatePem = key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicPem = key.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const metadata = parseReleaseTag('ffmpeg-9.0.1-lame-3.100-r2');
const ASSET_BASE = metadata.assetBase;
const env = { ...process.env, SOURCE_DATE_EPOCH: '1786924800', YUQI_RELEASE_TAG: metadata.releaseTag, YUQI_FFMPEG_ED25519_PRIVATE_KEY_PEM: privatePem, YUQI_FFMPEG_ED25519_PUBLIC_KEY_PEM: publicPem };
const dist = path.join(ROOT, 'dist');
const zip = path.join(dist, `${ASSET_BASE}.zip`);
const manifest = path.join(dist, `${ASSET_BASE}.manifest.json`);
const signature = path.join(dist, `${ASSET_BASE}.manifest.sig`);
const temporary = await mkdtemp(path.join(os.tmpdir(), 'yuqi-release-test-'));

function expectFailure(file, args, options = {}) {
  const result = spawnSync(file, args, { encoding: 'utf8', ...options });
  assert.notEqual(result.status, 0, `unexpected success: ${file} ${args.join(' ')}`);
}
async function rewriteEnvelope(packageFile, outputManifest) {
  const value = JSON.parse(await readFile(manifest, 'utf8'));
  value.packageFilename = path.basename(packageFile);
  value.packageSha256 = await sha256(packageFile);
  value.packageSize = (await stat(packageFile)).size;
  await writeFile(outputManifest, `${canonicalJson(value)}\n`);
}

test('build output packages, signs, verifies and rejects supply-chain mutations', async () => {
  try {
    run(process.execPath, [path.join(ROOT, 'scripts/create-release-package.mjs')], { env });
    run(process.execPath, [path.join(ROOT, 'scripts/sign-manifest.mjs'), manifest, signature], { env });
    const publicKey = path.join(temporary, 'public.pem');
    await writeFile(publicKey, publicPem);
    run(process.execPath, [path.join(ROOT, 'scripts/verify-manifest.mjs'), manifest, signature, publicKey]);
    run(process.execPath, [path.join(ROOT, 'scripts/verify-release-package.mjs'), zip, manifest]);
    const releaseManifest = JSON.parse(await readFile(manifest, 'utf8'));
    assert.equal(releaseManifest.releaseTag, metadata.releaseTag);
    assert.equal(releaseManifest.packageFilename, metadata.assetNames[0]);

    const tamperedManifest = path.join(temporary, 'tampered.manifest.json');
    await copyFile(manifest, tamperedManifest);
    const changed = JSON.parse(await readFile(tamperedManifest, 'utf8')); changed.channel = 'nightly';
    await writeFile(tamperedManifest, `${canonicalJson(changed)}\n`);
    expectFailure(process.execPath, [path.join(ROOT, 'scripts/verify-manifest.mjs'), tamperedManifest, signature, publicKey]);

    const wrong = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const wrongKey = path.join(temporary, 'wrong.pem'); await writeFile(wrongKey, wrong);
    expectFailure(process.execPath, [path.join(ROOT, 'scripts/verify-manifest.mjs'), manifest, signature, wrongKey]);

    const altered = path.join(temporary, 'altered.zip'); await copyFile(zip, altered); await writeFile(altered, Buffer.concat([await readFile(altered), Buffer.from([0])]));
    expectFailure(process.execPath, [path.join(ROOT, 'scripts/verify-release-package.mjs'), altered, manifest]);

    for (const [label, mutate] of [
      ['missing-lame', (file) => run('/usr/bin/zip', ['-q', '-d', file, 'yuqi-ffmpeg/lib/libmp3lame.0.dylib'])],
      ['extra-file', (file) => { const extra = path.join(temporary, 'extra'); return writeFile(extra, 'x').then(() => run('/usr/bin/zip', ['-q', file, extra], { cwd: temporary })); }],
      ['path-traversal', async (file) => { const data = await readFile(file); const from = Buffer.from('yuqi-ffmpeg/ffmpeg'); const to = Buffer.from('yuqi-ffmpeg/../x  '); for (let at = data.indexOf(from); at >= 0; at = data.indexOf(from, at + to.length)) to.copy(data, at); await writeFile(file, data); }],
    ]) {
      const candidate = path.join(temporary, `${label}.zip`); await copyFile(zip, candidate); await mutate(candidate);
      const envelope = path.join(temporary, `${label}.json`); await rewriteEnvelope(candidate, envelope);
      expectFailure(process.execPath, [path.join(ROOT, 'scripts/verify-release-package.mjs'), candidate, envelope]);
    }

    const fingerprint = publicKeyFingerprint(publicPem);
    assert.match(fingerprint, /^[a-f0-9]{64}$/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
