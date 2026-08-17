import { readFile } from 'node:fs/promises';
import { createPublicKey, verify } from 'node:crypto';
import { canonicalJson, publicKeyFingerprint } from './lib.mjs';

const [manifestPath, signaturePath, publicKeyPath] = process.argv.slice(2);
if (!publicKeyPath) throw new Error('Usage: verify-manifest MANIFEST SIGNATURE PUBLIC_KEY');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const lines = (await readFile(signaturePath, 'utf8')).trim().split('\n');
if (lines.length !== 3 || lines[0] !== 'YUQI-ED25519-SIGNATURE-V1') throw new Error('Invalid signature envelope');
const publicPem = await readFile(publicKeyPath, 'utf8');
const fingerprint = publicKeyFingerprint(publicPem);
if (manifest.signing?.publicKeyFingerprint !== fingerprint || manifest.signing?.keyId !== lines[1]) throw new Error('Public key identity mismatch');
if (!verify(null, Buffer.from(canonicalJson(manifest)), createPublicKey(publicPem), Buffer.from(lines[2], 'base64'))) throw new Error('Manifest signature verification failed');
console.log(`Verified ${lines[1]} (${fingerprint})`);
