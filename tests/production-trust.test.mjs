import assert from 'node:assert/strict';
import { createPublicKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  PRODUCTION_V1_FINGERPRINT_PATH,
  PRODUCTION_V1_PUBLIC_KEY_PATH,
  PRODUCTION_V2_FINGERPRINT_PATH,
  PRODUCTION_V2_PUBLIC_KEY_PATH,
  productionTrustPathsForSchema,
  verifyProductionSigningIdentity,
} from '../scripts/production-trust.mjs';

const v1PublicPem = await readFile(PRODUCTION_V1_PUBLIC_KEY_PATH, 'utf8');
const v1FingerprintText = await readFile(PRODUCTION_V1_FINGERPRINT_PATH, 'utf8');
const v2PublicPem = await readFile(PRODUCTION_V2_PUBLIC_KEY_PATH, 'utf8');
const v2FingerprintText = await readFile(PRODUCTION_V2_FINGERPRINT_PATH, 'utf8');

function alteredPublicPem(sourcePem) {
  const der = Buffer.from(createPublicKey(sourcePem).export({ type: 'spki', format: 'der' }));
  der[der.length - 1] ^= 1;
  return createPublicKey({ key: der, type: 'spki', format: 'der' }).export({ type: 'spki', format: 'pem' }).toString();
}

test('schema v1 and v2 resolve to separate pinned trust files', () => {
  assert.equal(productionTrustPathsForSchema(1).generation, 'v1');
  assert.equal(productionTrustPathsForSchema(2).generation, 'v2');
  assert.throws(() => productionTrustPathsForSchema(3), /Unsupported/);
});

test('correct schema-v1 production public key and fingerprint pass', () => {
  assert.deepEqual(
    verifyProductionSigningIdentity({ derivedPublicPem: v1PublicPem, trustedPublicPem: v1PublicPem, fingerprintText: v1FingerprintText }),
    { fingerprint: '65c3365329bb4384569541a79a9400415fd04cbc0b7bab462952e59c3f815272', keyId: 'ed25519-sha256:65c3365329bb4384' },
  );
});

test('correct schema-v2 production public key and fingerprint pass', () => {
  assert.deepEqual(
    verifyProductionSigningIdentity({ derivedPublicPem: v2PublicPem, trustedPublicPem: v2PublicPem, fingerprintText: v2FingerprintText }),
    { fingerprint: '14b0bbaf1dba378ae5f5a4afcdb00483485299723d26a8f9c62cd81ad8692551', keyId: 'ed25519-sha256:14b0bbaf1dba378a' },
  );
});

test('cross-generation production keys are rejected', () => {
  assert.throws(() => verifyProductionSigningIdentity({ derivedPublicPem: v1PublicPem, trustedPublicPem: v2PublicPem, fingerprintText: v2FingerprintText }), /does not match/);
  assert.throws(() => verifyProductionSigningIdentity({ derivedPublicPem: v2PublicPem, trustedPublicPem: v1PublicPem, fingerprintText: v1FingerprintText }), /does not match/);
});

test('tampered pinned public key and fingerprint are rejected', () => {
  assert.throws(() => verifyProductionSigningIdentity({ derivedPublicPem: v2PublicPem, trustedPublicPem: alteredPublicPem(v2PublicPem), fingerprintText: v2FingerprintText }), /does not match|fingerprint mismatch/);
  const tampered = v2FingerprintText.replaceAll('14b0bbaf', '24b0bbaf');
  assert.throws(() => verifyProductionSigningIdentity({ derivedPublicPem: v2PublicPem, trustedPublicPem: v2PublicPem, fingerprintText: tampered }), /fingerprint mismatch/);
});

test('verification failures never include supplied key material', () => {
  const marker = 'DO-NOT-LOG-SECRET-MATERIAL';
  assert.throws(
    () => verifyProductionSigningIdentity({ derivedPublicPem: marker, trustedPublicPem: v2PublicPem, fingerprintText: v2FingerprintText }),
    (error) => !String(error).includes(marker),
  );
});
