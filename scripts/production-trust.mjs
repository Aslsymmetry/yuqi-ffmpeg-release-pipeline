import { createPublicKey, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, publicKeyFingerprint } from './lib.mjs';

export const PRODUCTION_PUBLIC_KEY_PATH = path.join(ROOT, 'trust/production/yuqi-ffmpeg-ed25519-public.pem');
export const PRODUCTION_FINGERPRINT_PATH = path.join(ROOT, 'trust/production/yuqi-ffmpeg-ed25519-fingerprint.txt');

export function parseProductionFingerprint(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length !== 2) throw new Error('Production trust metadata must contain exactly fingerprint and keyId.');
  const fingerprint = lines[0].match(/^fingerprint=([a-f0-9]{64})$/)?.[1];
  const keyId = lines[1].match(/^keyId=(ed25519-sha256:[a-f0-9]{16})$/)?.[1];
  if (!fingerprint || !keyId || keyId !== `ed25519-sha256:${fingerprint.slice(0, 16)}`) {
    throw new Error('Production trust metadata is invalid.');
  }
  return { fingerprint, keyId };
}

function ed25519SpkiDer(pem) {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Production public key must be Ed25519.');
  return key.export({ type: 'spki', format: 'der' });
}

export function verifyProductionSigningIdentity({ derivedPublicPem, trustedPublicPem, fingerprintText }) {
  const derivedDer = ed25519SpkiDer(derivedPublicPem);
  const trustedDer = ed25519SpkiDer(trustedPublicPem);
  const { fingerprint, keyId } = parseProductionFingerprint(fingerprintText);
  if (derivedDer.length !== trustedDer.length || !timingSafeEqual(derivedDer, trustedDer)) {
    throw new Error('Production signing key does not match the pinned public key.');
  }
  if (publicKeyFingerprint(trustedPublicPem) !== fingerprint) {
    throw new Error('Pinned production public key fingerprint mismatch.');
  }
  return { fingerprint, keyId };
}

export async function verifyPinnedProductionSigningIdentity(derivedPublicPem) {
  const [trustedPublicPem, fingerprintText] = await Promise.all([
    readFile(PRODUCTION_PUBLIC_KEY_PATH, 'utf8'),
    readFile(PRODUCTION_FINGERPRINT_PATH, 'utf8'),
  ]);
  return verifyProductionSigningIdentity({ derivedPublicPem, trustedPublicPem, fingerprintText });
}
