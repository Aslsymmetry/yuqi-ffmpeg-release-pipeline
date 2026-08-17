import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import test from 'node:test';
import { canonicalJson, publicKeyFingerprint } from '../scripts/lib.mjs';

test('canonical JSON is independent of object insertion order', () => {
  assert.equal(canonicalJson({ z: 1, a: { y: 2, x: 3 } }), canonicalJson({ a: { x: 3, y: 2 }, z: 1 }));
});

test('Ed25519 accepts canonical manifest and rejects mutation and wrong key', () => {
  const first = generateKeyPairSync('ed25519');
  const second = generateKeyPairSync('ed25519');
  const manifest = { schemaVersion: 1, setId: 'fixed', nested: { b: 2, a: 1 } };
  const signature = sign(null, Buffer.from(canonicalJson(manifest)), first.privateKey);
  assert.equal(verify(null, Buffer.from(canonicalJson(manifest)), first.publicKey, signature), true);
  assert.equal(verify(null, Buffer.from(canonicalJson({ ...manifest, setId: 'tampered' })), first.publicKey, signature), false);
  assert.equal(verify(null, Buffer.from(canonicalJson(manifest)), second.publicKey, signature), false);
  assert.match(publicKeyFingerprint(first.publicKey.export({ type: 'spki', format: 'pem' })), /^[a-f0-9]{64}$/);
});
