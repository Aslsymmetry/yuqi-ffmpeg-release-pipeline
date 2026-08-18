import assert from 'node:assert/strict';
import test from 'node:test';
import { runReleasePreflight } from '../scripts/release-preflight.mjs';

const SHA = 'a'.repeat(40);
const TAG = 'ffmpeg-9.0.1-lame-3.100-r2';
const base = {
  PUBLISH_REQUESTED: 'true', GITHUB_REPOSITORY: 'Aslsymmetry/yuqi-ffmpeg-release-pipeline', GITHUB_REF_TYPE: 'tag',
  GITHUB_REF_NAME: TAG, GITHUB_REF: `refs/tags/${TAG}`, GITHUB_SHA: SHA, GITHUB_TOKEN: 'secret-test-token',
};
const response = (value) => ({ ok: true, status: 200, json: async () => value, headers: new Headers() });
const annotated = (file, args) => args[1] === '-t' ? 'tag\n' : `${SHA}\n`;

test('publish=false and tag push preflight return release_allowed=false without network or git', async () => {
  for (const environment of [{ PUBLISH_REQUESTED: 'false' }, { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: TAG }]) {
    let called = false;
    const result = await runReleasePreflight(environment, { fetchImpl: async () => { called = true; } });
    assert.equal(result.allowed, false);
    assert.match(result.output, /release_allowed=false/);
    assert.equal(called, false);
  }
});

test('main publish=true is rejected before production and before network', async () => {
  let called = false;
  await assert.rejects(runReleasePreflight({ ...base, GITHUB_REF_TYPE: 'branch', GITHUB_REF: 'refs/heads/main', GITHUB_REF_NAME: 'main' }, { fetchImpl: async () => { called = true; } }), /tag ref/);
  assert.equal(called, false);
});

test('valid annotated r2 tag yields exact release outputs', async () => {
  const result = await runReleasePreflight(base, { execFile: annotated, fetchImpl: async () => response([]), timeoutFactory: () => undefined });
  assert.equal(result.allowed, true);
  for (const line of ['release_allowed=true', `release_tag=${TAG}`, 'release_title=FFmpeg 9.0.1 + LAME 3.100 r2', 'asset_base=yuqi-ffmpeg-9.0.1-lame-3.100-macos-arm64-r2', 'manifest_schema_version=1', 'minimum_consumer_schema_version=1', 'signing_key_generation=v1']) assert.ok(result.output.includes(line));
});



test('valid annotated r3 tag requires schema v2 and v2 signing generation', async () => {
  const tag = 'ffmpeg-9.0.1-lame-3.100-r3';
  const environment = {
    ...base,
    GITHUB_REF_NAME: tag,
    GITHUB_REF: `refs/tags/${tag}`,
  };
  const result = await runReleasePreflight(environment, { execFile: annotated, fetchImpl: async () => response([]), timeoutFactory: () => undefined });
  for (const line of ['manifest_schema_version=2', 'minimum_consumer_schema_version=2', 'signing_key_generation=v2']) {
    assert.ok(result.output.includes(line));
  }
});

test('annotated tag target mismatch is rejected before API lookup', async () => {
  let called = false;
  const execFile = (file, args) => args[1] === '-t' ? 'tag\n' : `${'b'.repeat(40)}\n`;
  await assert.rejects(runReleasePreflight(base, { execFile, fetchImpl: async () => { called = true; } }), /target/);
  assert.equal(called, false);
});

test('published Release blocks preflight', async () => {
  const release = { id: 1, tag_name: TAG, draft: false, prerelease: false, target_commitish: SHA };
  await assert.rejects(runReleasePreflight(base, { execFile: annotated, fetchImpl: async () => response([release]), timeoutFactory: () => undefined }), /published Release/);
});

test('duplicate exact-tag Release state fails closed', async () => {
  const release = { id: 1, tag_name: TAG, draft: true, prerelease: false, target_commitish: SHA };
  await assert.rejects(runReleasePreflight(base, { execFile: annotated, fetchImpl: async () => response([release, { ...release, id: 2 }]), timeoutFactory: () => undefined }), /Multiple Releases/);
});

test('preflight errors do not expose token, Authorization or response bodies', async () => {
  const messages = [];
  try { await runReleasePreflight(base, { execFile: annotated, fetchImpl: async () => ({ ok: false, status: 403, body: { cancel: async () => {} }, headers: new Headers() }), timeoutFactory: () => undefined }); } catch (error) { messages.push(error.message); }
  const log = messages.join('\n');
  assert.equal(log.includes(base.GITHUB_TOKEN), false);
  assert.equal(/Authorization|response body/i.test(log), false);
});
