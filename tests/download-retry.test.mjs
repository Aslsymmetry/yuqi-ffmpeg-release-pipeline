import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { DownloadPolicyError, MAX_ATTEMPTS, downloadWithRetry } from '../scripts/download-sources.mjs';

const url = 'https://ffmpeg.org/releases/source.tar.xz?token=do-not-log';
const policy = { name: 'source.tar.xz', max: 1024, hosts: ['ffmpeg.org'] };

function response({ status = 200, url: finalUrl = 'https://ffmpeg.org/releases/source.tar.xz', body = 'fixture', retryAfter = null } = {}) {
  let cancelled = false;
  return {
    status,
    ok: status >= 200 && status < 300,
    url: finalUrl,
    headers: { get: (name) => name === 'retry-after' ? retryAfter : name === 'content-length' ? String(Buffer.byteLength(body)) : null },
    body: { cancel: async () => { cancelled = true; } },
    arrayBuffer: async () => Buffer.from(body),
    wasCancelled: () => cancelled,
  };
}

function networkError(code, secret = '') {
  const cause = Object.assign(new Error(`response body ${secret}`), { code });
  return new TypeError(`fetch failed ${secret}`, { cause });
}

function harness(sequence, overrides = {}) {
  const logs = [];
  const delays = [];
  const signals = [];
  let calls = 0;
  return {
    dependencies: {
      fetchImpl: async () => {
        const item = sequence[calls++];
        if (item instanceof Error) throw item;
        return item;
      },
      sleep: async (delay) => { delays.push(delay); },
      timeoutSignal: (milliseconds) => {
        const signal = { milliseconds, sequence: signals.length + 1 };
        signals.push(signal);
        return signal;
      },
      log: (line) => logs.push(line),
      now: () => 1_700_000_000_000,
      ...overrides,
    },
    logs,
    delays,
    signals,
    calls: () => calls,
  };
}

test('first ECONNRESET retries and second attempt succeeds', async () => {
  const run = harness([networkError('ECONNRESET'), response()]);
  const result = await downloadWithRetry(url, policy, run.dependencies);
  assert.equal(result.bytes.toString(), 'fixture');
  assert.equal(run.calls(), 2);
  assert.deepEqual(run.delays, [1000]);
});

test('two HTTP 503 responses are discarded before success', async () => {
  const first = response({ status: 503 });
  const second = response({ status: 503 });
  const run = harness([first, second, response()]);
  await downloadWithRetry(url, policy, run.dependencies);
  assert.equal(first.wasCancelled(), true);
  assert.equal(second.wasCancelled(), true);
  assert.deepEqual(run.delays, [1000, 2000]);
});

test('valid Retry-After takes precedence and is capped at 30 seconds', async () => {
  const run = harness([response({ status: 429, retryAfter: '45' }), response()]);
  await downloadWithRetry(url, policy, run.dependencies);
  assert.deepEqual(run.delays, [30000]);
});

test('maximum attempts fail closed', async () => {
  const run = harness(Array.from({ length: MAX_ATTEMPTS }, () => networkError('ETIMEDOUT')));
  await assert.rejects(downloadWithRetry(url, policy, run.dependencies), (error) => error.cause?.code === 'ETIMEDOUT');
  assert.equal(run.calls(), 4);
  assert.deepEqual(run.delays, [1000, 2000, 4000]);
  assert.match(run.logs.at(-1), /Download failed.*4\/4.*ETIMEDOUT/);
});

test('SHA-256 mismatch policy failure is not retried', async () => {
  const expected = '0'.repeat(64);
  const run = harness([response(), response()], {
    validateBytes: async (bytes) => {
      if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new DownloadPolicyError('SHA-256 mismatch');
    },
  });
  await assert.rejects(downloadWithRetry(url, policy, run.dependencies), /SHA-256 mismatch/);
  assert.equal(run.calls(), 1);
  assert.deepEqual(run.delays, []);
});

test('disallowed redirect host is not retried', async () => {
  const run = harness([response({ url: 'https://example.invalid/source.tar.xz' }), response()]);
  await assert.rejects(downloadWithRetry(url, policy, run.dependencies), /Redirect target rejected/);
  assert.equal(run.calls(), 1);
});

test('HTTP 404 is not retried', async () => {
  const run = harness([response({ status: 404 }), response()]);
  await assert.rejects(downloadWithRetry(url, policy, run.dependencies), /HTTP 404/);
  assert.equal(run.calls(), 1);
});

test('every retry creates a fresh timeout signal', async () => {
  const run = harness([networkError('EAI_AGAIN'), networkError('UND_ERR_SOCKET'), response()]);
  await downloadWithRetry(url, policy, run.dependencies);
  assert.equal(run.signals.length, 3);
  assert.equal(new Set(run.signals).size, 3);
  assert.ok(run.signals.every(({ milliseconds }) => milliseconds === 180000));
});

test('logs never expose query strings, tokens, or response bodies', async () => {
  const secret = 'SECRET_RESPONSE_BODY';
  const run = harness([networkError('ECONNRESET', secret), response()]);
  await downloadWithRetry(url, policy, run.dependencies);
  const output = run.logs.join('\n');
  assert.equal(output.includes('token=do-not-log'), false);
  assert.equal(output.includes('do-not-log'), false);
  assert.equal(output.includes(secret), false);
  assert.equal(output.includes('fixture'), false);
  assert.match(output, /ffmpeg\.org.*1\/4/);
});
