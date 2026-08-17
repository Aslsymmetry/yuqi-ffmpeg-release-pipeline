import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPECTED_ENTRIES, canonicalJson, sha256 } from './lib.mjs';

const [zip, externalManifest] = process.argv.slice(2);
if (!externalManifest) throw new Error('Usage: verify-release-package ZIP EXTERNAL_MANIFEST');
const listed = execFileSync('/usr/bin/zipinfo', ['-1', zip], { encoding: 'utf8' }).trim().split(/\r?\n/);
if (JSON.stringify([...listed].sort()) !== JSON.stringify([...EXPECTED_ENTRIES].sort())) throw new Error(`ZIP entry structure mismatch: ${JSON.stringify(listed)}`);
for (const entry of listed) {
  if (entry.startsWith('/') || entry.includes('..') || entry.includes('\\') || /[\0\r\n]/.test(entry)) throw new Error(`Unsafe ZIP path: ${entry}`);
}
const modes = execFileSync('/usr/bin/zipinfo', ['-l', zip], { encoding: 'utf8' }).split(/\r?\n/).filter((line) => /^[dl-][rwx-]{9}/.test(line));
if (modes.some((line) => line.startsWith('l'))) throw new Error('Symbolic links are forbidden in release ZIP');
const manifest = JSON.parse(await readFile(externalManifest, 'utf8'));
if (manifest.manifestKind !== 'release-envelope' || manifest.packageSha256 !== await sha256(zip) || manifest.packageSize !== (await stat(zip)).size || manifest.packageFilename !== path.basename(zip)) throw new Error('Package envelope hash, size, or filename mismatch');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'yuqi-ffmpeg-package-'));
try {
  execFileSync('/usr/bin/ditto', ['-x', '-k', zip, temporary]);
  const payload = path.join(temporary, 'yuqi-ffmpeg');
  const internal = JSON.parse(await readFile(path.join(payload, 'manifest.json'), 'utf8'));
  if (internal.manifestKind !== 'payload' || internal.packageSha256 !== null || internal.setId !== manifest.setId || canonicalJson(internal.files) !== canonicalJson(manifest.files)) throw new Error('Internal payload manifest does not match signed release envelope');
  for (const record of Object.values(internal.files)) if (await sha256(path.join(payload, record.path)) !== record.sha256) throw new Error(`Payload hash mismatch: ${record.path}`);
  execFileSync(process.execPath, [fileURLToPath(new URL('./verify-release-set.mjs', import.meta.url)), payload], { stdio: 'ignore' });
} finally {
  await rm(temporary, { recursive: true, force: true });
}
console.log('Release package structure, envelope and payload verified');
