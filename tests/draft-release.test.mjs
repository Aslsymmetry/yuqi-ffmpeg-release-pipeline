import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { recoverDraftRelease, testing } from '../scripts/create-draft-release.mjs';

const SHA = 'a'.repeat(40);
const digest = (content) => createHash('sha256').update(content).digest('hex');

function localAssets() {
  return testing.ASSET_NAMES.map((name, index) => {
    const content = Buffer.from(`asset-${index}-${name}`);
    return { name, content, size: content.length, sha256: digest(content) };
  });
}

function remoteAsset(local, overrides = {}) {
  return {
    id: overrides.id ?? Math.floor(Math.random() * 1_000_000) + 1,
    name: local.name,
    state: 'uploaded',
    size: local.size,
    digest: `sha256:${local.sha256}`,
    ...overrides,
  };
}

function harness(options = {}) {
  const assets = localAssets();
  const state = {
    release: options.release === undefined ? null : options.release,
    assets: options.assets ? [...options.assets] : [],
    createStatuses: [...(options.createStatuses ?? [])],
    listStatuses: [...(options.listStatuses ?? [])],
    uploadStatuses: new Map(Object.entries(options.uploadStatuses ?? {}).map(([name, values]) => [name, [...values]])),
    createCount: 0,
    listCount: 0,
    uploadCount: 0,
    waits: [],
    logs: [],
    timeoutCount: 0,
  };
  const draft = () => ({
    id: 77, tag_name: 'ffmpeg-9.0.1-lame-3.100-r1', target_commitish: SHA,
    draft: true, prerelease: false, ...state.release,
  });
  const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
    status, headers: { 'content-type': 'application/json', ...headers },
  });
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    if (url.hostname === 'api.github.com' && url.pathname.includes('/git/ref/tags/')) {
      return json({ object: { type: 'commit', sha: SHA } });
    }
    if (url.hostname === 'api.github.com' && url.pathname.endsWith('/releases') && init.method !== 'POST') {
      state.listCount += 1;
      const status = state.listStatuses.shift() ?? 200;
      if (status !== 200) return json({ message: 'list response body must stay secret' }, status, options.retryAfter ? { 'retry-after': options.retryAfter } : {});
      const page = Number(url.searchParams.get('page'));
      if (options.releasePages) return json(options.releasePages[page - 1] ?? []);
      return json(state.release ? [draft()] : []);
    }
    if (url.hostname === 'api.github.com' && url.pathname.endsWith('/releases') && init.method === 'POST') {
      state.createCount += 1;
      const outcome = state.createStatuses.shift() ?? 201;
      const status = typeof outcome === 'number' ? outcome : outcome.status;
      if (typeof outcome === 'object' && outcome.persistDraft) state.release = {};
      if (status !== 201) return json({ message: 'create response body must stay secret' }, status, options.retryAfter ? { 'retry-after': options.retryAfter } : {});
      state.release = {};
      return json(draft(), 201);
    }
    if (url.hostname === 'api.github.com' && /\/releases\/77\/assets$/.test(url.pathname)) return json(state.assets);
    if (url.hostname === 'api.github.com' && url.pathname.endsWith('/releases/77')) return json(draft());
    if (url.hostname === 'uploads.github.com' && url.pathname.endsWith('/releases/77/assets')) {
      const name = url.searchParams.get('name');
      state.uploadCount += 1;
      const statuses = state.uploadStatuses.get(name) ?? [];
      const status = statuses.shift() ?? 201;
      state.uploadStatuses.set(name, statuses);
      if (status !== 201) return json({ message: 'upload response body and signed?token=secret' }, status, options.retryAfter ? { 'retry-after': options.retryAfter } : {});
      const local = assets.find((asset) => asset.name === name);
      const uploaded = remoteAsset(local, options.uploadMismatch?.name === name ? options.uploadMismatch : {});
      state.assets.push(uploaded);
      return json(uploaded, 201);
    }
    throw new Error(`Unexpected mock request: ${url.hostname}${url.pathname}`);
  };
  const config = {
    token: 'github-token-must-not-appear', repository: 'owner/repository', runId: '123',
    sha: SHA, assets,
  };
  const dependencies = {
    fetchImpl,
    sleep: async (milliseconds) => { state.waits.push(milliseconds); },
    timeoutFactory: () => { state.timeoutCount += 1; return undefined; },
    logger: (line) => state.logs.push(line),
  };
  return { assets, config, dependencies, state, run: () => recoverDraftRelease(config, dependencies) };
}

test('first HTTP 429 retries and creates one Draft', async () => {
  const context = harness({ createStatuses: [429, 201] });
  await context.run();
  assert.equal(context.state.createCount, 2);
  assert.deepEqual(context.state.waits, [1000]);
});

test('first page matching Draft is reused', async () => {
  const context = harness({ release: {} });
  await context.run();
  assert.equal(context.state.createCount, 0);
  assert.ok(context.state.listCount >= 1);
});

test('second page matching Draft is reused', async () => {
  const fillers = Array.from({ length: 100 }, (_, index) => ({
    id: 1000 + index, tag_name: `other-${index}`, target_commitish: SHA, draft: false, prerelease: false,
  }));
  const context = harness({ releasePages: [fillers, [{ id: 77, tag_name: 'ffmpeg-9.0.1-lame-3.100-r1', target_commitish: SHA, draft: true, prerelease: false }]] });
  await context.run();
  assert.equal(context.state.createCount, 0);
  assert.ok(context.state.listCount >= 2);
});

test('other tags are ignored before creating the Draft', async () => {
  const context = harness({ releasePages: [[{ id: 88, tag_name: 'other-tag', target_commitish: SHA, draft: false, prerelease: false }]] });
  await context.run();
  assert.equal(context.state.createCount, 1);
});

test('multiple Releases for the exact tag fail closed', async () => {
  const matching = { tag_name: 'ffmpeg-9.0.1-lame-3.100-r1', target_commitish: SHA, draft: true, prerelease: false };
  const context = harness({ releasePages: [[{ id: 77, ...matching }, { id: 78, ...matching }]] });
  await assert.rejects(context.run(), /Multiple Releases/);
  assert.equal(context.state.createCount, 0);
});

test('List releases retries first HTTP 429 then succeeds', async () => {
  const context = harness({ release: {}, listStatuses: [429, 200] });
  await context.run();
  assert.deepEqual(context.state.waits, [1000]);
  assert.equal(context.state.createCount, 0);
});

test('List releases retries two HTTP 503 responses then succeeds', async () => {
  const context = harness({ release: {}, listStatuses: [503, 503, 200] });
  await context.run();
  assert.deepEqual(context.state.waits, [1000, 2000]);
});

test('List releases Retry-After is applied and capped', async () => {
  const context = harness({ release: {}, listStatuses: [429, 200], retryAfter: '90' });
  await context.run();
  assert.deepEqual(context.state.waits, [30_000]);
});

test('maximum full List releases pages fail closed', async () => {
  const pages = Array.from({ length: testing.MAX_RELEASE_PAGES }, (_, page) => Array.from({ length: 100 }, (__, index) => ({
    id: page * 100 + index + 1, tag_name: `other-${page}-${index}`, target_commitish: SHA, draft: false, prerelease: false,
  })));
  const context = harness({ releasePages: pages });
  await assert.rejects(context.run(), /exceeded .* full pages/);
  assert.equal(context.state.createCount, 0);
});

test('non-array List releases response fails closed', async () => {
  const context = harness({ releasePages: [{ not: 'an array' }] });
  await assert.rejects(context.run(), /not an array/);
  assert.equal(context.state.createCount, 0);
});

test('lost transient POST response is recovered by listing before another POST', async () => {
  const context = harness({ createStatuses: [{ status: 503, persistDraft: true }] });
  await context.run();
  assert.equal(context.state.createCount, 1);
  assert.equal(context.state.listCount, 2);
  assert.ok(context.state.release);
});

test('HTTP 422 from Draft creation is not retried', async () => {
  const context = harness({ createStatuses: [422] });
  await assert.rejects(context.run(), /HTTP 422/);
  assert.equal(context.state.createCount, 1);
  assert.deepEqual(context.state.waits, []);
});

test('asset upload retries two HTTP 503 responses then succeeds', async () => {
  const assets = localAssets();
  const context = harness({ release: {}, uploadStatuses: { [assets[0].name]: [503, 503, 201] } });
  await context.run();
  assert.deepEqual(context.state.waits, [1000, 2000]);
  assert.equal(context.state.assets.length, 4);
});

test('Retry-After takes precedence and is capped at 30 seconds', async () => {
  const context = harness({ createStatuses: [429, 201], retryAfter: '90' });
  await context.run();
  assert.deepEqual(context.state.waits, [30_000]);
});

test('maximum retries fail closed', async () => {
  const context = harness({ createStatuses: [503, 503, 503, 503] });
  await assert.rejects(context.run(), /HTTP 503/);
  assert.equal(context.state.createCount, 4);
  assert.deepEqual(context.state.waits, [1000, 2000, 4000]);
});

for (const status of [401, 403]) test(`HTTP ${status} is not retried`, async () => {
  const context = harness({ createStatuses: [status] });
  await assert.rejects(context.run(), new RegExp(`HTTP ${status}`));
  assert.equal(context.state.createCount, 1);
  assert.deepEqual(context.state.waits, []);
});

test('an existing matching Draft is reused', async () => {
  const context = harness({ release: {} });
  await context.run();
  assert.equal(context.state.createCount, 0);
});

test('an existing published Release is rejected', async () => {
  const context = harness({ release: { draft: false } });
  await assert.rejects(context.run(), /published Release already exists/);
  assert.equal(context.state.uploadCount, 0);
});

test('a Draft targeting a different commit is rejected', async () => {
  const context = harness({ release: { target_commitish: 'b'.repeat(40) } });
  await assert.rejects(context.run(), /target commit mismatch/);
  assert.equal(context.state.uploadCount, 0);
});

test('a partial valid Draft uploads only missing assets', async () => {
  const locals = localAssets();
  const context = harness({ release: {}, assets: [remoteAsset(locals[0], { id: 1 })] });
  const result = await context.run();
  assert.equal(context.state.uploadCount, 3);
  assert.equal(context.state.assets.length, 4);
  assert.equal(result.verifiedAssets.length, 4);
});

test('same asset name with different hash is rejected without overwrite', async () => {
  const locals = localAssets();
  const context = harness({ release: {}, assets: [remoteAsset(locals[0], { id: 1, digest: `sha256:${'b'.repeat(64)}` })] });
  await assert.rejects(context.run(), /SHA-256 mismatch/);
  assert.equal(context.state.uploadCount, 0);
});

for (const [kind, change, message] of [
  ['size', (local) => ({ size: local.size + 1 }), /size mismatch/],
  ['hash', () => ({ digest: `sha256:${'b'.repeat(64)}` }), /SHA-256 mismatch/],
]) test(`post-upload ${kind} mismatch is rejected`, async () => {
  const locals = localAssets();
  const context = harness({ release: {}, uploadMismatch: { name: locals[0].name, ...change(locals[0]) } });
  await assert.rejects(context.run(), message);
});

test('rerunning reuses the same Draft and assets without duplicates', async () => {
  const context = harness();
  await context.run();
  const uploads = context.state.uploadCount;
  await context.run();
  assert.equal(context.state.createCount, 1);
  assert.equal(context.state.uploadCount, uploads);
  assert.equal(context.state.assets.length, 4);
});

test('diagnostics never expose token, URL query, or response body', async () => {
  const assets = localAssets();
  const context = harness({ release: {}, uploadStatuses: { [assets[0].name]: [503, 201] } });
  await context.run();
  const logs = context.state.logs.join('\n');
  assert.equal(logs.includes(context.config.token), false);
  assert.equal(logs.includes('?token='), false);
  assert.equal(logs.includes('response body'), false);
  assert.equal(logs.includes('Authorization'), false);
});
