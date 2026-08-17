import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const lock = JSON.parse(await readFile(new URL('../config/source-lock.json', import.meta.url)));
const workflow = await readFile(new URL('../.github/workflows/build-release.yml', import.meta.url), 'utf8');
const build = await readFile(new URL('../scripts/build-ffmpeg-arm64.sh', import.meta.url), 'utf8');

test('source policy pins official HTTPS sources and hashes', () => {
  assert.equal(new URL(lock.ffmpeg.sourceUrl).hostname, 'ffmpeg.org');
  assert.equal(new URL(lock.lame.sourceUrl).hostname, 'downloads.sourceforge.net');
  assert.match(lock.ffmpeg.sha256, /^[a-f0-9]{64}$/);
  assert.match(lock.lame.patchSha256, /^[a-f0-9]{64}$/);
});

test('build policy is arm64 LGPL, offline runtime, and relative LAME', () => {
  for (const token of ['--disable-gpl', '--disable-nonfree', '--disable-network', '--disable-autodetect', '@loader_path/lib/libmp3lame.0.dylib']) assert.ok(build.includes(token));
  assert.ok(build.includes('uname -m'));
});

test('workflow uses official arm64 label and publishing is explicit and draft', () => {
  assert.ok(workflow.includes('runs-on: macos-15'));
  assert.ok(workflow.includes("inputs.publish == true"));
  assert.ok(workflow.includes('--draft'));
  assert.ok(workflow.includes('YUQI_FFMPEG_ED25519_PRIVATE_KEY_PEM'));
});
