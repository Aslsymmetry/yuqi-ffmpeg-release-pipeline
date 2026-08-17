import { createHash, createPublicKey } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const EXPECTED_ENTRIES = [
  'yuqi-ffmpeg/', 'yuqi-ffmpeg/ffmpeg', 'yuqi-ffmpeg/ffprobe', 'yuqi-ffmpeg/lib/',
  'yuqi-ffmpeg/lib/libmp3lame.0.dylib', 'yuqi-ffmpeg/manifest.json',
  'yuqi-ffmpeg/build-provenance.json', 'yuqi-ffmpeg/SHA256SUMS',
  'yuqi-ffmpeg/licenses/', 'yuqi-ffmpeg/licenses/FFmpeg-LGPL-2.1.txt',
  'yuqi-ffmpeg/licenses/LAME-LGPL-2.0.txt', 'yuqi-ffmpeg/source-information/',
  'yuqi-ffmpeg/source-information/FFmpeg-source-information.txt',
];
export const sha256 = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');
export const fileRecord = async (file, path) => ({ path, sha256: await sha256(file), size: (await stat(file)).size, architecture: 'arm64' });
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}
export function publicKeyFingerprint(pem) {
  const der = createPublicKey(pem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex');
}
