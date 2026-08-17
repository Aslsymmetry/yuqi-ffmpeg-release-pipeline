import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './lib.mjs';
import lock from '../config/source-lock.json' with { type: 'json' };

export const MAX_ATTEMPTS = 4;
const BACKOFF_MS = [1_000, 2_000, 4_000];
const RETRYABLE_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'ECONNREFUSED',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
]);
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export class DownloadPolicyError extends Error {}

const allow = new Map([
  [lock.ffmpeg.sourceUrl, { name: `ffmpeg-${lock.ffmpeg.version}.tar.xz`, max: 40_000_000, hosts: ['ffmpeg.org'] }],
  [lock.ffmpeg.signatureUrl, { name: `ffmpeg-${lock.ffmpeg.version}.tar.xz.asc`, max: 100_000, hosts: ['ffmpeg.org'] }],
  [lock.ffmpeg.signingKeyUrl, { name: 'ffmpeg-devel.asc', max: 500_000, hosts: ['ffmpeg.org'] }],
  [lock.lame.sourceUrl, { name: `lame-${lock.lame.version}.tar.gz`, max: 5_000_000, hosts: ['downloads.sourceforge.net', 'sourceforge.net'], hostSuffix: '.dl.sourceforge.net' }],
]);
const hostAllowed = (hostname, policy) => policy.hosts.includes(hostname) || Boolean(policy.hostSuffix && hostname.endsWith(policy.hostSuffix) && hostname.length > policy.hostSuffix.length);

function networkCode(error) {
  for (let current = error; current; current = current.cause) {
    if (typeof current.code === 'string' && RETRYABLE_CODES.has(current.code)) return current.code;
  }
  return null;
}

function retryAfterMs(value, now) {
  if (!value) return null;
  const seconds = Number(value);
  const milliseconds = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : Date.parse(value) - now();
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? Math.min(milliseconds, 30_000) : null;
}

const defaultSleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function discardBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // The failed response is already unusable; retry state must not retain it.
  }
}

export async function downloadWithRetry(url, policy, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const sleep = dependencies.sleep ?? defaultSleep;
  const timeoutSignal = dependencies.timeoutSignal ?? ((milliseconds) => AbortSignal.timeout(milliseconds));
  const log = dependencies.log ?? console.log;
  const now = dependencies.now ?? Date.now;
  const initial = new URL(url);
  if (initial.protocol !== 'https:' || !hostAllowed(initial.hostname, policy)) throw new DownloadPolicyError(`Source URL rejected: ${initial.hostname}`);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let response;
    log(`Downloading ${initial.hostname} attempt ${attempt}/${MAX_ATTEMPTS}`);
    try {
      response = await fetchImpl(url, {
        redirect: 'follow',
        signal: timeoutSignal(180_000),
        headers: { 'user-agent': 'Yuqi-FFmpeg-Release-Pipeline/1' },
      });
      const final = new URL(response.url);
      if (final.protocol !== 'https:' || !hostAllowed(final.hostname, policy)) throw new DownloadPolicyError(`Redirect target rejected: ${final.hostname}`);
      if (!response.ok || !response.body) {
        if (!RETRYABLE_STATUSES.has(response.status)) throw new DownloadPolicyError(`HTTP ${response.status} downloading ${initial.hostname}`);
        const error = new Error(`HTTP_${response.status}`);
        error.retryClass = `HTTP ${response.status}`;
        error.retryAfter = response.headers.get('retry-after');
        throw error;
      }
      const length = Number(response.headers.get('content-length') ?? 0);
      if (length > policy.max) throw new DownloadPolicyError(`Download too large: ${policy.name}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length || bytes.length > policy.max) throw new DownloadPolicyError(`Invalid download size: ${policy.name}`);
      await dependencies.validateBytes?.(bytes);
      return { bytes, finalHostname: final.hostname };
    } catch (error) {
      await discardBody(response);
      if (error instanceof DownloadPolicyError) {
        log(`Download failed for ${initial.hostname} on attempt ${attempt}/${MAX_ATTEMPTS} (non-retryable policy)`);
        throw error;
      }
      const retryClass = error.retryClass ?? networkCode(error);
      if (!retryClass) throw error;
      if (attempt === MAX_ATTEMPTS) {
        log(`Download failed for ${initial.hostname} after ${attempt}/${MAX_ATTEMPTS} attempts (${retryClass})`);
        throw error;
      }
      const delay = retryAfterMs(error.retryAfter, now) ?? BACKOFF_MS[attempt - 1];
      log(`Retryable ${retryClass} from ${initial.hostname} on attempt ${attempt}/${MAX_ATTEMPTS}; waiting ${delay}ms`);
      await sleep(delay);
    }
  }
  throw new Error('Unreachable download retry state');
}

export async function downloadSources() {
  const output = path.join(ROOT, 'build', 'downloads');
  await mkdir(output, { recursive: true });
  for (const [url, policy] of allow) {
    const destination = path.join(output, policy.name);
    const temporary = `${destination}.partial`;
    await rm(temporary, { force: true });
    try {
      const { bytes, finalHostname } = await downloadWithRetry(url, policy);
      await writeFile(temporary, bytes, { mode: 0o600 });
      await rm(destination, { force: true });
      await rename(temporary, destination);
      console.log(`${policy.name} ${bytes.length} bytes from ${finalHostname}`);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await downloadSources();
}
