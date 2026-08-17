import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { downloadBuildArtifact, testing } from '../scripts/download-build-artifact.mjs';

const FILES = {
  ffmpeg: Buffer.from('mock arm64 ffmpeg'),
  ffprobe: Buffer.from('mock arm64 ffprobe'),
  'lib/libmp3lame.0.dylib': Buffer.from('mock arm64 lame'),
};

function zip(entries = FILES, modes = {}) {
  const locals = [];
  const centrals = [];
  let localOffset = 0;
  for (const [name, contentValue] of Object.entries(entries)) {
    const content = Buffer.from(contentValue);
    const nameBuffer = Buffer.from(name);
    const crc = testing.crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(0, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22); local.writeUInt16LE(nameBuffer.length, 26);
    locals.push(local, nameBuffer, content);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x031e, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8); central.writeUInt16LE(0, 10); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(content.length, 20); central.writeUInt32LE(content.length, 24); central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(((modes[name] ?? 0o100755) << 16) >>> 0, 38); central.writeUInt32LE(localOffset, 42);
    centrals.push(central, nameBuffer);
    localOffset += local.length + nameBuffer.length + content.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  const count = Object.keys(entries).length;
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(count, 8); eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12); eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...locals, centralBuffer, eocd]);
}

function fixture(overrides = {}) {
  const archive = overrides.archive ?? zip();
  const digest = `sha256:${createHash('sha256').update(archive).digest('hex')}`;
  const config = {
    token: 'token-that-must-not-be-logged', repository: 'owner/repository', runId: 123,
    sha: 'a'.repeat(40), artifactId: 456, digest, artifactName: 'verified-build-output',
    destination: '', ...overrides.config,
  };
  const metadata = {
    id: 456, name: 'verified-build-output', expired: false, size_in_bytes: archive.length,
    digest, workflow_run: { id: 123, head_sha: 'a'.repeat(40) }, ...overrides.metadata,
  };
  return { archive, config, metadata };
}

function responses(metadata, archive, archiveStatuses = []) {
  let phase = 0;
  let statusIndex = 0;
  return async (url, options) => {
    const target = new URL(url);
    if (target.hostname === 'api.github.com' && !target.pathname.endsWith('/zip')) {
      return new Response(JSON.stringify(metadata), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (target.hostname === 'api.github.com') {
      const status = archiveStatuses[statusIndex++] ?? 302;
      if (status !== 302) return new Response('body-must-not-be-logged', { status, headers: { 'retry-after': status === 429 ? '0' : undefined } });
      return new Response(null, { status: 302, headers: { location: 'https://results-receiver.actions.githubusercontent.com/path?token=signed-secret' } });
    }
    phase += 1;
    return new Response(archive, { status: 200, headers: { 'content-length': String(archive.length) } });
  };
}

async function execute(t, overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yuqi-artifact-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const data = fixture(overrides);
  data.config.destination = path.join(directory, 'build/output');
  const logs = [];
  const waits = [];
  let timeoutCount = 0;
  const dependencies = {
    fetchImpl: overrides.fetchImpl ?? responses(data.metadata, data.archive, overrides.archiveStatuses),
    sleep: async (milliseconds) => { waits.push(milliseconds); },
    logger: (line) => logs.push(line),
    timeoutFactory: () => { timeoutCount += 1; return undefined; },
    verifySet: overrides.verifySet ?? (async () => {}),
  };
  const run = () => downloadBuildArtifact(data.config, dependencies);
  return { ...data, directory, logs, waits, run, timeoutCount: () => timeoutCount };
}

test('valid metadata and exact ZIP install successfully', async (t) => {
  const context = await execute(t);
  const result = await context.run();
  assert.equal(result.installed, true);
  assert.deepEqual(result.files, Object.keys(FILES));
  assert.equal((await stat(path.join(context.config.destination, 'ffmpeg'))).isFile(), true);
  assert.equal((await stat(path.join(context.config.destination, 'lib/libmp3lame.0.dylib'))).mode & 0o111, 0);
});

test('build output digest accepts bare lowercase hex and normalizes exactly once', () => {
  const hex = 'a'.repeat(64);
  assert.equal(testing.parseBuildOutputDigest(hex), `sha256:${hex}`);
});

test('API metadata digest accepts only the prefixed lowercase form', () => {
  const normalized = `sha256:${'a'.repeat(64)}`;
  assert.equal(testing.parseMetadataDigest(normalized), normalized);
  assert.throws(() => testing.parseMetadataDigest('a'.repeat(64)), /sha256: prefix/);
});

for (const [label, digest] of [
  ['sha256 prefix', `sha256:${'a'.repeat(64)}`],
  ['uppercase hex', 'A'.repeat(64)],
  ['short length', 'a'.repeat(63)],
  ['long length', 'a'.repeat(65)],
  ['non-hex character', `${'a'.repeat(63)}g`],
]) test(`build output digest rejects ${label}`, () => {
  assert.throws(() => testing.parseBuildOutputDigest(digest), /64 lowercase hexadecimal characters without a prefix/);
});

test('normalized build output and API metadata digests compare successfully', async (t) => {
  const archive = zip();
  const hex = createHash('sha256').update(archive).digest('hex');
  const context = await execute(t, { archive, config: { digest: testing.parseBuildOutputDigest(hex) } });
  await context.run();
});

test('API and normalized build output digest mismatch is fail-closed without retry', async (t) => {
  const context = await execute(t, { metadata: { digest: `sha256:${'b'.repeat(64)}` } });
  await assert.rejects(context.run(), /metadata digest mismatch/);
  assert.deepEqual(context.waits, []);
});

for (const [label, metadata, message] of [
  ['artifact ID mismatch', { id: 999 }, /ID mismatch/],
  ['artifact name mismatch', { name: 'other' }, /name mismatch/],
  ['workflow run ID mismatch', { workflow_run: { id: 999, head_sha: 'a'.repeat(40) } }, /run ID mismatch/],
  ['head SHA mismatch', { workflow_run: { id: 123, head_sha: 'b'.repeat(40) } }, /head SHA mismatch/],
  ['expired artifact', { expired: true }, /expired/],
  ['metadata digest mismatch', { digest: `sha256:${'b'.repeat(64)}` }, /metadata digest mismatch/],
  ['metadata size mismatch', { size_in_bytes: 1 }, /size does not match metadata/],
]) test(`${label} is rejected`, async (t) => {
  const context = await execute(t, { metadata });
  await assert.rejects(context.run(), message);
});

test('downloaded ZIP digest mismatch is not retried', async (t) => {
  const context = await execute(t, { config: { digest: `sha256:${'b'.repeat(64)}` }, metadata: { digest: `sha256:${'b'.repeat(64)}` } });
  await assert.rejects(context.run(), /Downloaded artifact digest mismatch/);
  assert.deepEqual(context.waits, []);
});

test('first 429 is retried and succeeds', async (t) => {
  const context = await execute(t, { archiveStatuses: [429, 302] });
  await context.run();
  assert.deepEqual(context.waits, [0]);
});

test('two 503 responses are retried and succeed', async (t) => {
  const context = await execute(t, { archiveStatuses: [503, 503, 302] });
  await context.run();
  assert.deepEqual(context.waits, [1000, 2000]);
});

test('Retry-After is applied and capped at 30 seconds', () => {
  assert.equal(testing.retryAfterMilliseconds('12'), 12_000);
  assert.equal(testing.retryAfterMilliseconds('90'), 30_000);
});

test('retry limit fails closed after four attempts', async (t) => {
  const context = await execute(t, { archiveStatuses: [503, 503, 503, 503] });
  await assert.rejects(context.run(), /HTTP 503/);
  assert.deepEqual(context.waits, [1000, 2000, 4000]);
});

for (const status of [404, 410]) test(`HTTP ${status} is not retried`, async (t) => {
  const context = await execute(t, { archiveStatuses: [status] });
  await assert.rejects(context.run(), new RegExp(`HTTP ${status}`));
  assert.deepEqual(context.waits, []);
});

test('every request receives a fresh timeout signal', async (t) => {
  const context = await execute(t, { archiveStatuses: [503, 302] });
  await context.run();
  assert.equal(context.timeoutCount(), 4);
});

for (const [label, location, message] of [
  ['non-allowlisted redirect', 'https://evil.example/artifact?token=secret', /not allowlisted/],
  ['HTTP redirect', 'http://results-receiver.actions.githubusercontent.com/artifact', /must use HTTPS/],
]) test(`${label} is rejected`, async (t) => {
  const context = await execute(t);
  context.run = () => downloadBuildArtifact(context.config, {
    fetchImpl: async (url) => new URL(url).pathname.endsWith('/zip')
      ? new Response(null, { status: 302, headers: { location } })
      : new Response(JSON.stringify(context.metadata), { status: 200 }),
    sleep: async () => {}, logger: () => {}, timeoutFactory: () => undefined, verifySet: async () => {},
  });
  await assert.rejects(context.run(), message);
});

for (const [label, entries, modes, message] of [
  ['path traversal', { ffmpeg: FILES.ffmpeg, ffprobe: FILES.ffprobe, '../escape': Buffer.from('x') }, {}, /path traversal/],
  ['symlink', FILES, { ffmpeg: 0o120777 }, /symlink or special/],
  ['unexpected file', { ffmpeg: FILES.ffmpeg, ffprobe: FILES.ffprobe, unexpected: Buffer.from('x') }, {}, /unexpected file/],
]) test(`ZIP ${label} is rejected`, async (t) => {
  const archive = zip(entries, modes);
  const context = await execute(t, { archive });
  await assert.rejects(context.run(), message);
});

test('staging verification failure leaves an existing destination unchanged', async (t) => {
  const context = await execute(t, { verifySet: async () => { throw new Error('verification failed'); } });
  await mkdir(context.config.destination, { recursive: true });
  await writeFile(path.join(context.config.destination, 'sentinel'), 'unchanged');
  await assert.rejects(context.run(), /verification failed/);
  assert.equal(await readFile(path.join(context.config.destination, 'sentinel'), 'utf8'), 'unchanged');
});

test('logs exclude token, signed query, and response body', async (t) => {
  const context = await execute(t, { archiveStatuses: [429, 302] });
  await context.run();
  const logs = context.logs.join('\n');
  assert.equal(logs.includes(context.config.token), false);
  assert.equal(logs.includes('signed-secret'), false);
  assert.equal(logs.includes('body-must-not-be-logged'), false);
  assert.equal(logs.includes('?token='), false);
});
