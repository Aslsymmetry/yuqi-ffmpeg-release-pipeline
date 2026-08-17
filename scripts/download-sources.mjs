import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './lib.mjs';
import lock from '../config/source-lock.json' with { type: 'json' };

const output = path.join(ROOT, 'build', 'downloads');
await mkdir(output, { recursive: true });
const allow = new Map([
  [lock.ffmpeg.sourceUrl, { name: `ffmpeg-${lock.ffmpeg.version}.tar.xz`, max: 40_000_000, hosts: ['ffmpeg.org'] }],
  [lock.ffmpeg.signatureUrl, { name: `ffmpeg-${lock.ffmpeg.version}.tar.xz.asc`, max: 100_000, hosts: ['ffmpeg.org'] }],
  [lock.ffmpeg.signingKeyUrl, { name: 'ffmpeg-devel.asc', max: 500_000, hosts: ['ffmpeg.org'] }],
  [lock.lame.sourceUrl, { name: `lame-${lock.lame.version}.tar.gz`, max: 5_000_000, hosts: ['downloads.sourceforge.net', 'sourceforge.net'], hostSuffix: '.dl.sourceforge.net' }],
]);
const hostAllowed = (hostname, policy) => policy.hosts.includes(hostname) || Boolean(policy.hostSuffix && hostname.endsWith(policy.hostSuffix) && hostname.length > policy.hostSuffix.length);
for (const [url, policy] of allow) {
  const initial = new URL(url);
  if (initial.protocol !== 'https:' || !hostAllowed(initial.hostname, policy)) throw new Error(`Source URL rejected: ${url}`);
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180_000), headers: { 'user-agent': 'Yuqi-FFmpeg-Release-Pipeline/1' } });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} downloading ${initial.hostname}`);
  const final = new URL(response.url);
  if (final.protocol !== 'https:' || !hostAllowed(final.hostname, policy)) throw new Error(`Redirect target rejected: ${final.hostname}`);
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > policy.max) throw new Error(`Download too large: ${policy.name}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > policy.max) throw new Error(`Invalid download size: ${policy.name}`);
  const destination = path.join(output, policy.name);
  const temporary = `${destination}.partial`;
  await writeFile(temporary, bytes, { mode: 0o600 });
  await rm(destination, { force: true });
  await rename(temporary, destination);
  console.log(`${policy.name} ${bytes.length} bytes from ${final.hostname}`);
}
