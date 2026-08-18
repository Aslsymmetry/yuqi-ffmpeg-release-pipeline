import { createPrivateKey, createPublicKey } from 'node:crypto';
import { verifyPinnedProductionSigningIdentity } from './production-trust.mjs';
import { releaseMetadataFromEnvironment } from './release-metadata.mjs';

try {
  const metadata = releaseMetadataFromEnvironment(process.env);
  const privatePem = process.env.YUQI_FFMPEG_ED25519_PRIVATE_KEY_PEM?.replace(/\\n/g, '\n');
  if (!privatePem) throw new Error('missing signing key');
  const derivedPublicPem = createPublicKey(createPrivateKey(privatePem)).export({ type: 'spki', format: 'pem' }).toString();
  const identity = await verifyPinnedProductionSigningIdentity(derivedPublicPem, metadata.manifestSchemaVersion);
  process.stdout.write(`Production signing identity verified: ${identity.keyId} (${identity.fingerprint})\n`);
} catch {
  process.stderr.write('Production signing identity verification failed.\n');
  process.exitCode = 1;
}
