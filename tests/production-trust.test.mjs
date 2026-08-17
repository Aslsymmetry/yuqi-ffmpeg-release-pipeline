import assert from 'node:assert/strict';
import { createPublicKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  PRODUCTION_FINGERPRINT_PATH,
  PRODUCTION_PUBLIC_KEY_PATH,
  verifyProductionSigningIdentity,
} from '../scripts/production-trust.mjs';

const trustedPublicPem = await readFile(PRODUCTION_PUBLIC_KEY_PATH, 'utf8');
const fingerprintText = await readFile(PRODUCTION_FINGERPRINT_PATH, 'utf8');

function alteredPublicPem() {
  const der = Buffer.from(createPublicKey(trustedPublicPem).export({ type: 'spki', format: 'der' }));
  der[der.length - 1] ^= 1;
  return createPublicKey({ key: der, type: 'spki', format: 'der' }).export({ type: 'spki', format: 'pem' }).toString();
}

test('correct production public key and fingerprint pass', () => {
  assert.deepEqual(
    verifyProductionSigningIdentity({ derivedPublicPem: trustedPublicPem, trustedPublicPem, fingerprintText }),
    {
      fingerprint: '65c3365329bb4384569541a79a9400415fd04cbc0b7bab462952e59c3f815272',
      keyId: 'ed25519-sha256:65c3365329bb4384',
    },
  );
});

test('tampered pinned public key is rejected', () => {
  assert.throws(() => verifyProductionSigningIdentity({ derivedPublicPem: trustedPublicPem, trustedPublicPem: alteredPublicPem(), fingerprintText }), /does not match|fingerprint mismatch/);
});

test('tampered fingerprint is rejected', () => {
  const tampered = fingerprintText.replaceAll('65c33653', '75c33653');
  assert.throws(() => verifyProductionSigningIdentity({ derivedPublicPem: trustedPublicPem, trustedPublicPem, fingerprintText: tampered }), /fingerprint mismatch/);
});

test('public key derived from a different private key is rejected', () => {
  assert.throws(() => verifyProductionSigningIdentity({ derivedPublicPem: alteredPublicPem(), trustedPublicPem, fingerprintText }), /does not match/);
});

test('verification failures never include supplied key material', () => {
  const marker = 'DO-NOT-LOG-SECRET-MATERIAL';
  assert.throws(
    () => verifyProductionSigningIdentity({ derivedPublicPem: marker, trustedPublicPem, fingerprintText }),
    (error) => !String(error).includes(marker),
  );
});
