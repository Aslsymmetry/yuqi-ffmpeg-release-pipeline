import { generateKeyPairSync } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { publicKeyFingerprint } from './lib.mjs';

const output = process.argv[2];
if (!output || !path.resolve(output).startsWith('/private/tmp/') && !path.resolve(output).startsWith('/tmp/')) throw new Error('Test keys may only be generated under /tmp');
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'test-private.pem'), privatePem, { mode: 0o600 });
await writeFile(path.join(output, 'test-public.pem'), publicPem, { mode: 0o644 });
console.log(JSON.stringify({ publicKeyFingerprint: publicKeyFingerprint(publicPem), privateKeyPath: path.join(output, 'test-private.pem'), publicKeyPath: path.join(output, 'test-public.pem') }));
