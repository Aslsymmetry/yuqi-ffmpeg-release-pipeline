import { execFileSync } from 'node:child_process';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './lib.mjs';
import { releaseMetadataFromEnvironment } from './release-metadata.mjs';
import { verifyPinnedProductionSigningIdentity } from './production-trust.mjs';

const privatePem = process.env.YUQI_FFMPEG_ED25519_PRIVATE_KEY_PEM?.replace(/\\n/g, '\n');
if (!privatePem) throw new Error('YUQI_FFMPEG_ED25519_PRIVATE_KEY_PEM is required; production release fails closed.');
const privateKey = createPrivateKey(privatePem);
const publicPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
await verifyPinnedProductionSigningIdentity(publicPem);
const env = { ...process.env, YUQI_FFMPEG_ED25519_PRIVATE_KEY_PEM: privatePem, YUQI_FFMPEG_ED25519_PUBLIC_KEY_PEM: publicPem };
const metadata = releaseMetadataFromEnvironment(process.env);
const dist = path.join(ROOT, 'dist');
const manifest = path.join(dist, `${metadata.assetBase}.manifest.json`);
const signature = path.join(dist, `${metadata.assetBase}.manifest.sig`);
const temporary = await mkdtemp(path.join(os.tmpdir(), 'yuqi-release-public-'));
try {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/create-release-package.mjs')], { env, stdio: 'inherit' });
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/sign-manifest.mjs'), manifest, signature], { env, stdio: 'inherit' });
  const publicPath = path.join(temporary, 'public.pem');
  await writeFile(publicPath, publicPem, { mode: 0o600 });
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/verify-manifest.mjs'), manifest, signature, publicPath], { stdio: 'inherit' });
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/verify-release-package.mjs'), path.join(dist, `${metadata.assetBase}.zip`), manifest], { stdio: 'inherit' });
} finally {
  await rm(temporary, { recursive: true, force: true });
}
