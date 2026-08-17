import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSET_BASE, RELEASE_TAG, ROOT } from './lib.mjs';

const API_ORIGIN = 'https://api.github.com';
const UPLOAD_ORIGIN = 'https://uploads.github.com';
const API_VERSION = '2022-11-28';
const MAX_ATTEMPTS = 4;
const REQUEST_TIMEOUT_MS = 60_000;
const TRANSIENT_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'ECONNREFUSED',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
]);
const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const ASSET_NAMES = [
  `${ASSET_BASE}.zip`,
  `${ASSET_BASE}.manifest.json`,
  `${ASSET_BASE}.manifest.sig`,
  `${ASSET_BASE}.SHA256SUMS`,
];

class ApiError extends Error {
  constructor(stage, status, retryAfter) {
    super(`${stage} failed with HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

const sha256Buffer = (buffer) => createHash('sha256').update(buffer).digest('hex');

function required(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function safeRepository(value) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value ?? '')) throw new Error('GITHUB_REPOSITORY is invalid');
  return value;
}

function retryAfterMilliseconds(value, now = Date.now()) {
  if (!value) return undefined;
  const seconds = Number(value);
  const milliseconds = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Date.parse(value) - now;
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
  if (error instanceof ApiError && TRANSIENT_STATUSES.has(error.status)) return `HTTP ${error.status}`;
  const code = errorCode(error);
  return TRANSIENT_CODES.has(code) ? code : undefined;
}

async function discardResponse(response) {
  try { await response.body?.cancel(); } catch { /* A failed response body is never logged. */ }
}

function diagnostic(context, stage, details = {}) {
  const fields = [
    `release run=${context.runId}`,
    `sha=${context.sha}`,
    `tag=${RELEASE_TAG}`,
    `stage=${stage}`,
  ];
  for (const [name, value] of Object.entries(details)) if (value !== undefined) fields.push(`${name}=${value}`);
  context.logger(fields.join(' '));
}

async function withRetry(context, stage, operation) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      const classification = retryClassification(error);
      if (!classification || attempt === MAX_ATTEMPTS) {
        diagnostic(context, stage, { status: classification ?? 'non-retryable', attempt: `${attempt}/${MAX_ATTEMPTS}`, final: true });
        throw error;
      }
      const delay = error.retryAfter ?? 1000 * (2 ** (attempt - 1));
      diagnostic(context, stage, { status: classification, attempt: `${attempt}/${MAX_ATTEMPTS}`, retryInMs: delay });
      await context.sleep(delay);
    }
  }
  throw new Error('Unreachable retry state');
}

async function requestJsonOnce(context, { origin = API_ORIGIN, pathname, method = 'GET', body, stage, allow404 = false }) {
  const url = new URL(pathname, origin);
  if (url.origin !== origin || url.protocol !== 'https:') throw new Error(`${stage} URL violates fixed HTTPS origin policy`);
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${context.token}`,
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': 'yuqi-ffmpeg-release-pipeline',
  };
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const response = await context.fetchImpl(url, {
    method, headers, body: payload, redirect: 'error', signal: context.timeoutFactory(REQUEST_TIMEOUT_MS),
  });
  if (allow404 && response.status === 404) {
    await discardResponse(response);
    return null;
  }
  if (!response.ok) {
    const error = new ApiError(stage, response.status, retryAfterMilliseconds(response.headers.get('retry-after')));
    await discardResponse(response);
    throw error;
  }
  return response.json();
}

async function requestJson(context, options) {
  return withRetry(context, options.stage, () => requestJsonOnce(context, options));
}

async function resolveTagTarget(context) {
  let object = (await requestJson(context, {
    pathname: `/repos/${context.repository}/git/ref/tags/${encodeURIComponent(RELEASE_TAG)}`,
    stage: 'verify-tag',
  }))?.object;
  for (let depth = 0; depth < 4 && object?.type === 'tag'; depth += 1) {
    object = (await requestJson(context, {
      pathname: `/repos/${context.repository}/git/tags/${object.sha}`,
      stage: 'verify-annotated-tag',
    }))?.object;
  }
  if (object?.type !== 'commit' || object.sha !== context.sha) throw new Error('Release tag target does not match GITHUB_SHA');
}

function validateRelease(release, context) {
  if (!Number.isSafeInteger(release?.id) || release.id <= 0) throw new Error('Draft Release ID is invalid');
  if (release.tag_name !== RELEASE_TAG) throw new Error('Draft Release tag mismatch');
  if (release.draft !== true) throw new Error('A published Release already exists for this tag');
  if (release.prerelease !== false) throw new Error('Draft Release prerelease state is forbidden');
  if (release.target_commitish !== context.sha) throw new Error('Draft Release target commit mismatch');
  return release;
}

async function lookupRelease(context) {
  return requestJson(context, {
    pathname: `/repos/${context.repository}/releases/tags/${encodeURIComponent(RELEASE_TAG)}`,
    stage: 'lookup-draft', allow404: true,
  });
}

async function ensureDraft(context) {
  return withRetry(context, 'ensure-draft', async () => {
    const existing = await lookupRelease(context);
    if (existing) return validateRelease(existing, context);
    const created = await requestJsonOnce(context, {
      pathname: `/repos/${context.repository}/releases`, method: 'POST', stage: 'create-draft',
      body: {
        tag_name: RELEASE_TAG,
        target_commitish: context.sha,
        name: 'FFmpeg 9.0.1 + LAME 3.100 r1',
        draft: true,
        prerelease: false,
      },
    });
    return validateRelease(created, context);
  });
}

function validateRemoteAsset(remote, local) {
  if (!Number.isSafeInteger(remote?.id) || remote.id <= 0 || remote.name !== local.name) throw new Error(`Remote asset identity mismatch: ${local.name}`);
  if (remote.state !== 'uploaded') throw new Error(`Remote asset is not fully uploaded: ${local.name}`);
  if (remote.size !== local.size) throw new Error(`Remote asset size mismatch: ${local.name}`);
  if (remote.digest !== `sha256:${local.sha256}`) throw new Error(`Remote asset SHA-256 mismatch: ${local.name}`);
  return remote;
}

async function listAssets(context, releaseId) {
  const assets = await requestJson(context, {
    pathname: `/repos/${context.repository}/releases/${releaseId}/assets?per_page=100`,
    stage: 'list-assets',
  });
  if (!Array.isArray(assets) || assets.length >= 100) throw new Error('Remote asset list is invalid or exceeds policy');
  const names = new Set();
  for (const asset of assets) {
    if (names.has(asset.name)) throw new Error(`Duplicate remote asset name: ${asset.name}`);
    names.add(asset.name);
  }
  return assets;
}

async function uploadAsset(context, releaseId, local) {
  const pathname = `/repos/${context.repository}/releases/${releaseId}/assets?name=${encodeURIComponent(local.name)}`;
  const url = new URL(pathname, UPLOAD_ORIGIN);
  return withRetry(context, `upload-${local.name}`, async () => {
    const current = await listAssets(context, releaseId);
    const recovered = current.find((asset) => asset.name === local.name);
    if (recovered) return validateRemoteAsset(recovered, local);
    const response = await context.fetchImpl(url, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${context.token}`,
        'Content-Type': 'application/octet-stream',
        'X-GitHub-Api-Version': API_VERSION,
        'User-Agent': 'yuqi-ffmpeg-release-pipeline',
      },
      body: local.content,
      redirect: 'error',
      signal: context.timeoutFactory(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const error = new ApiError(`upload-${local.name}`, response.status, retryAfterMilliseconds(response.headers.get('retry-after')));
      await discardResponse(response);
      throw error;
    }
    return validateRemoteAsset(await response.json(), local);
  });
}

async function loadLocalAssets(directory = path.join(ROOT, 'dist')) {
  return Promise.all(ASSET_NAMES.map(async (name) => {
    const file = path.join(directory, name);
    const content = await readFile(file);
    const size = (await stat(file)).size;
    if (size <= 0 || size !== content.length) throw new Error(`Local release asset is invalid: ${name}`);
    return { name, content, size, sha256: sha256Buffer(content) };
  }));
}

export async function recoverDraftRelease(config, dependencies = {}) {
  const context = {
    ...config,
    fetchImpl: dependencies.fetchImpl ?? globalThis.fetch,
    sleep: dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
    timeoutFactory: dependencies.timeoutFactory ?? ((milliseconds) => AbortSignal.timeout(milliseconds)),
    logger: dependencies.logger ?? console.error,
  };
  await resolveTagTarget(context);
  const draft = await ensureDraft(context);
  diagnostic(context, 'draft-ready', { draftId: draft.id });
  const initial = await listAssets(context, draft.id);
  const expectedNames = new Set(config.assets.map((asset) => asset.name));
  for (const remote of initial) if (!expectedNames.has(remote.name)) throw new Error(`Unexpected remote asset in Draft: ${remote.name}`);
  const verified = [];
  for (const local of config.assets) {
    const remote = initial.find((asset) => asset.name === local.name);
    if (remote) {
      validateRemoteAsset(remote, local);
      verified.push(local.name);
      diagnostic(context, 'reuse-asset', { draftId: draft.id, verifiedAsset: local.name });
    } else {
      await uploadAsset(context, draft.id, local);
      const afterUpload = await listAssets(context, draft.id);
      const uploaded = afterUpload.find((asset) => asset.name === local.name);
      if (!uploaded) throw new Error(`Uploaded asset is missing from Draft: ${local.name}`);
      validateRemoteAsset(uploaded, local);
      verified.push(local.name);
      diagnostic(context, 'uploaded-asset', { draftId: draft.id, verifiedAsset: local.name });
    }
  }
  const finalRelease = validateRelease(await requestJson(context, {
    pathname: `/repos/${context.repository}/releases/${draft.id}`,
    stage: 'verify-final-draft',
  }), context);
  const finalAssets = await listAssets(context, draft.id);
  if (finalAssets.length !== config.assets.length) throw new Error('Final Draft asset count mismatch');
  for (const local of config.assets) validateRemoteAsset(finalAssets.find((asset) => asset.name === local.name), local);
  diagnostic(context, 'complete', { draftId: finalRelease.id, verifiedAsset: verified.join(',') });
  return { draftId: finalRelease.id, verifiedAssets: verified };
}

function configFromEnvironment(environment = process.env) {
  const sha = required(environment.GITHUB_SHA, 'GITHUB_SHA');
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('GITHUB_SHA is invalid');
  if (environment.GITHUB_REF !== `refs/tags/${RELEASE_TAG}`) throw new Error('GITHUB_REF does not match the exact protected release tag');
  return {
    token: required(environment.GITHUB_TOKEN, 'GITHUB_TOKEN'),
    repository: safeRepository(environment.GITHUB_REPOSITORY),
    runId: required(environment.GITHUB_RUN_ID, 'GITHUB_RUN_ID'),
    sha,
    assets: null,
  };
}

export const testing = { ASSET_NAMES, retryAfterMilliseconds, validateRemoteAsset };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let config;
  try {
    config = configFromEnvironment();
    config.assets = await loadLocalAssets();
    await recoverDraftRelease(config);
  } catch (error) {
    const code = errorCode(error);
    const safe = code && TRANSIENT_CODES.has(code) ? code : error instanceof ApiError ? `HTTP ${error.status}` : 'policy-error';
    const detail = error instanceof ApiError || (code && TRANSIENT_CODES.has(code)) ? safe : error.message;
    const safeDetail = /(?:https?:\/\/|authorization|bearer|token=|private key)/i.test(detail) ? 'redacted unsafe error detail' : detail;
    console.error(`release run=${config?.runId ?? 'unknown'} sha=${config?.sha ?? 'unknown'} tag=${RELEASE_TAG} stage=failed status=${safe} detail=${safeDetail}`);
    process.exitCode = 1;
  }
}
