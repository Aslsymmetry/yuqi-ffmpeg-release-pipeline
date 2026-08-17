import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_ORIGIN = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const ARTIFACT_NAME = 'verified-build-output';
const ARTIFACT_DESTINATION = 'build/output';
const EXPECTED_FILES = new Map([
  ['ffmpeg', 0o755],
  ['ffprobe', 0o755],
  ['lib/libmp3lame.0.dylib', 0o644],
]);
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 72 * 1024 * 1024;
const MAX_ATTEMPTS = 4;
const REQUEST_TIMEOUT_MS = 60_000;
const TRANSIENT_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'ECONNREFUSED',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
]);
const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

class DownloadError extends Error {
  constructor(message, { code, status, retryAfter } = {}) {
    super(message);
    this.name = 'DownloadError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function required(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseDigest(value, name) {
  if (!/^sha256:[a-f0-9]{64}$/.test(value ?? '')) throw new Error(`${name} must be a lowercase SHA-256 digest`);
  return value;
}

function safeRepository(value) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value ?? '')) throw new Error('GITHUB_REPOSITORY is invalid');
  return value;
}

function positiveInteger(value, name) {
  if (!/^[1-9][0-9]*$/.test(value ?? '') || !Number.isSafeInteger(Number(value))) throw new Error(`${name} is invalid`);
  return Number(value);
}

function retryAfterMilliseconds(value, now = Date.now()) {
  if (!value) return undefined;
  const seconds = Number(value);
  const milliseconds = Number.isFinite(seconds) && seconds >= 0
    ? seconds * 1000
    : Date.parse(value) - now;
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return undefined;
  return Math.min(milliseconds, 30_000);
}

function errorCode(error) {
  let current = error;
  while (current) {
    if (typeof current.code === 'string') return current.code;
    current = current.cause;
  }
  return undefined;
}

function retryClassification(error) {
  if (error instanceof DownloadError && TRANSIENT_STATUSES.has(error.status)) return `HTTP ${error.status}`;
  const code = errorCode(error);
  return TRANSIENT_CODES.has(code) ? code : undefined;
}

async function withRetry(operation, { sleep, logger, hostname, now }) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      logger(`artifact host=${hostname} attempt=${attempt}/${MAX_ATTEMPTS}`);
      return await operation(attempt);
    } catch (error) {
      const classification = retryClassification(error);
      if (!classification || attempt === MAX_ATTEMPTS) {
        logger(`artifact attempt=${attempt}/${MAX_ATTEMPTS} status=${classification ?? 'non-retryable'} final-failure=true`);
        throw error;
      }
      const delay = error.retryAfter ?? Math.min(1000 * (2 ** (attempt - 1)), 4000);
      logger(`artifact attempt=${attempt}/${MAX_ATTEMPTS} status=${classification} retry-in-ms=${delay}`);
      await sleep(delay, now);
    }
  }
  throw new Error('unreachable retry state');
}

function responseError(response) {
  return new DownloadError(`GitHub API request failed with HTTP ${response.status}`, {
    status: response.status,
    retryAfter: retryAfterMilliseconds(response.headers.get('retry-after')),
  });
}

async function discardResponse(response) {
  try { await response.body?.cancel(); } catch { /* The failed body is intentionally discarded. */ }
}

async function fetchChecked(fetchImpl, url, options, timeoutFactory) {
  const response = await fetchImpl(url, { ...options, redirect: 'manual', signal: timeoutFactory(REQUEST_TIMEOUT_MS) });
  return response;
}

function validateRedirect(location) {
  let url;
  try { url = new URL(location); } catch { throw new Error('Artifact redirect URL is invalid'); }
  if (url.protocol !== 'https:') throw new Error('Artifact redirect must use HTTPS');
  const host = url.hostname.toLowerCase();
  if (isIP(host) || host === 'localhost') throw new Error('Artifact redirect host is forbidden');
  const allowed = host === 'results-receiver.actions.githubusercontent.com'
    || (host.endsWith('.blob.core.windows.net') && host.length > '.blob.core.windows.net'.length);
  if (!allowed) throw new Error('Artifact redirect host is not allowlisted');
  return url;
}

async function consumeLimited(response, maximum = MAX_ARCHIVE_BYTES) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximum) throw new Error('Artifact exceeds maximum download size');
  if (!response.body) throw new Error('Artifact response has no body');
  const chunks = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new Error('Artifact exceeds maximum download size');
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  if (size === 0) throw new Error('Artifact download is empty');
  return Buffer.concat(chunks, size);
}

function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error('ZIP end-of-central-directory record is missing');
}

function validateZipPath(name) {
  if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw new Error('ZIP contains an unsafe path');
  const segments = name.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) throw new Error('ZIP contains a path traversal entry');
}

function parseZip(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  if (buffer.readUInt16LE(eocd + 4) !== 0 || buffer.readUInt16LE(eocd + 6) !== 0) throw new Error('Multi-disk ZIP is forbidden');
  const entriesOnDisk = buffer.readUInt16LE(eocd + 8);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  if (entriesOnDisk !== entryCount || entryCount !== EXPECTED_FILES.size) throw new Error('ZIP file count is invalid');
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (centralOffset + centralSize > eocd) throw new Error('ZIP central directory is invalid');
  const entries = [];
  let offset = centralOffset;
  let totalSize = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('ZIP central directory entry is invalid');
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > buffer.length || flags & 0x1 || ![0, 8].includes(method)) throw new Error('ZIP entry uses an unsupported format');
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    validateZipPath(name);
    if (!EXPECTED_FILES.has(name) || entries.some((entry) => entry.name === name)) throw new Error('ZIP contains an unexpected file');
    const mode = externalAttributes >>> 16;
    const type = mode & 0o170000;
    if (type && type !== 0o100000) throw new Error('ZIP contains a symlink or special file');
    totalSize += uncompressedSize;
    if (totalSize > MAX_UNCOMPRESSED_BYTES) throw new Error('ZIP uncompressed size exceeds the limit');
    entries.push({ name, flags, method, crc, compressedSize, uncompressedSize, localOffset });
    offset = end;
  }
  if (offset !== centralOffset + centralSize || new Set(entries.map(({ name }) => name)).size !== EXPECTED_FILES.size) throw new Error('ZIP structure is invalid');
  return entries;
}

let crcTable;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = Array.from({ length: 256 }, (_, index) => {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
      return value >>> 0;
    });
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function extractZip(buffer, entries, directory) {
  await mkdir(directory, { recursive: false });
  for (const entry of entries) {
    const offset = entry.localOffset;
    if (buffer.readUInt32LE(offset) !== 0x04034b50) throw new Error('ZIP local header is invalid');
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const localName = buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    if (localName !== entry.name) throw new Error('ZIP local and central paths differ');
    const dataStart = offset + 30 + nameLength + extraLength;
    const compressed = buffer.subarray(dataStart, dataStart + entry.compressedSize);
    if (compressed.length !== entry.compressedSize) throw new Error('ZIP entry data is truncated');
    const content = entry.method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: entry.uncompressedSize });
    if (content.length !== entry.uncompressedSize || crc32(content) !== entry.crc) throw new Error('ZIP entry integrity check failed');
    const target = path.join(directory, ...entry.name.split('/'));
    if (entry.name.includes('/')) await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, { flag: 'wx', mode: EXPECTED_FILES.get(entry.name) });
  }
  for (const [name, mode] of EXPECTED_FILES) {
    const target = path.join(directory, ...name.split('/'));
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Extracted artifact contains a non-regular file');
    await chmod(target, mode);
  }
}

function validateMetadata(metadata, expected) {
  if (metadata?.id !== expected.artifactId) throw new Error('Artifact ID mismatch');
  if (metadata?.name !== ARTIFACT_NAME || metadata.name !== expected.artifactName) throw new Error('Artifact name mismatch');
  if (metadata?.expired !== false) throw new Error('Artifact is expired');
  if (metadata?.workflow_run?.id !== expected.runId) throw new Error('Artifact workflow run ID mismatch');
  if (metadata?.workflow_run?.head_sha !== expected.sha) throw new Error('Artifact head SHA mismatch');
  const digest = parseDigest(metadata?.digest, 'Artifact metadata digest');
  if (digest !== expected.digest) throw new Error('Artifact metadata digest mismatch');
  if (!Number.isSafeInteger(metadata?.size_in_bytes) || metadata.size_in_bytes <= 0 || metadata.size_in_bytes > MAX_ARCHIVE_BYTES) throw new Error('Artifact metadata size is invalid');
}

function configFromEnvironment(environment = process.env) {
  const artifactName = required(environment.EXPECTED_ARTIFACT_NAME, 'EXPECTED_ARTIFACT_NAME');
  const destination = required(environment.ARTIFACT_DESTINATION, 'ARTIFACT_DESTINATION');
  if (artifactName !== ARTIFACT_NAME) throw new Error('EXPECTED_ARTIFACT_NAME violates policy');
  if (destination !== ARTIFACT_DESTINATION) throw new Error('ARTIFACT_DESTINATION violates policy');
  const sha = required(environment.GITHUB_SHA, 'GITHUB_SHA');
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('GITHUB_SHA is invalid');
  return {
    token: required(environment.GITHUB_TOKEN, 'GITHUB_TOKEN'),
    repository: safeRepository(environment.GITHUB_REPOSITORY),
    runId: positiveInteger(environment.GITHUB_RUN_ID, 'GITHUB_RUN_ID'),
    sha,
    artifactId: positiveInteger(environment.EXPECTED_ARTIFACT_ID, 'EXPECTED_ARTIFACT_ID'),
    digest: parseDigest(environment.EXPECTED_ARTIFACT_DIGEST, 'EXPECTED_ARTIFACT_DIGEST'),
    artifactName,
    destination: path.join(ROOT, ARTIFACT_DESTINATION),
  };
}

export async function downloadBuildArtifact(config, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const logger = dependencies.logger ?? console.error;
  const timeoutFactory = dependencies.timeoutFactory ?? ((milliseconds) => AbortSignal.timeout(milliseconds));
  const verifySet = dependencies.verifySet ?? ((directory) => execFileSync(process.execPath, [path.join(ROOT, 'scripts/verify-release-set.mjs'), directory], { stdio: 'inherit', timeout: 300_000 }));
  const metadataUrl = new URL(`/repos/${config.repository}/actions/artifacts/${config.artifactId}`, API_ORIGIN);
  const archiveUrl = new URL(`/repos/${config.repository}/actions/artifacts/${config.artifactId}/zip`, API_ORIGIN);
  const apiHeaders = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${config.token}`,
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': 'yuqi-ffmpeg-release-pipeline',
  };
  const metadataResponse = await withRetry(async () => {
    const response = await fetchChecked(fetchImpl, metadataUrl, { headers: apiHeaders }, timeoutFactory);
    if (!response.ok) {
      const error = responseError(response);
      await discardResponse(response);
      throw error;
    }
    return response;
  }, { sleep, logger, hostname: 'api.github.com' });
  const metadata = await metadataResponse.json();
  validateMetadata(metadata, config);
  logger(`artifact id=${config.artifactId} name=${config.artifactName} metadata-verified=true`);

  const archive = await withRetry(async () => {
    const redirectResponse = await fetchChecked(fetchImpl, archiveUrl, { headers: apiHeaders }, timeoutFactory);
    if (redirectResponse.status !== 302) {
      const error = responseError(redirectResponse);
      await discardResponse(redirectResponse);
      throw error;
    }
    const redirect = validateRedirect(redirectResponse.headers.get('location'));
    await discardResponse(redirectResponse);
    logger(`artifact id=${config.artifactId} redirect-host=${redirect.hostname}`);
    const response = await fetchChecked(fetchImpl, redirect, { headers: { 'User-Agent': 'yuqi-ffmpeg-release-pipeline' } }, timeoutFactory);
    if (!response.ok) {
      const error = responseError(response);
      await discardResponse(response);
      throw error;
    }
    return consumeLimited(response);
  }, { sleep, logger, hostname: 'api.github.com' });
  if (archive.length !== metadata.size_in_bytes) throw new Error('Downloaded artifact size does not match metadata');
  const digest = `sha256:${createHash('sha256').update(archive).digest('hex')}`;
  if (digest !== config.digest || digest !== metadata.digest) throw new Error('Downloaded artifact digest mismatch');

  const entries = parseZip(archive);
  const destination = path.resolve(config.destination);
  const parent = path.dirname(destination);
  await mkdir(parent, { recursive: true });
  const stagingRoot = await mkdtemp(path.join(parent, '.artifact-staging-'));
  const zipPath = path.join(stagingRoot, 'artifact.zip');
  const extracted = path.join(stagingRoot, 'output');
  let installed = false;
  try {
    await writeFile(zipPath, archive, { flag: 'wx', mode: 0o600 });
    await extractZip(archive, entries, extracted);
    await verifySet(extracted);
    try {
      await lstat(destination);
      throw new Error('Artifact destination already exists');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await rename(extracted, destination);
    installed = true;
    logger(`artifact id=${config.artifactId} name=${config.artifactName} digest-verified=true installed=true`);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
  return { installed, digest, files: [...EXPECTED_FILES.keys()] };
}

export const testing = {
  ARTIFACT_NAME, ARTIFACT_DESTINATION, MAX_ATTEMPTS, MAX_ARCHIVE_BYTES,
  crc32, parseZip, retryAfterMilliseconds, validateRedirect, validateMetadata,
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const config = configFromEnvironment();
    await downloadBuildArtifact(config);
  } catch (error) {
    const code = errorCode(error);
    const detail = code && TRANSIENT_CODES.has(code) ? `transient network error ${code}` : error.message;
    const safeDetail = /(?:https?:\/\/|authorization|bearer|token=|private key)/i.test(detail) ? 'redacted unsafe error detail' : detail;
    console.error(`Artifact handoff failed: ${safeDetail}`);
    process.exitCode = 1;
  }
}
