import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const workflow = await readFile(path.join(root, '.github/workflows/build-release.yml'), 'utf8');
const build = await readFile(path.join(root, 'scripts/build-ffmpeg-arm64.sh'), 'utf8');
const stages = ['link', 'strip', 'postprocess', 'pre-codesign', 'post-codesign', 'final'];
const components = ['ffmpeg', 'ffprobe', 'libmp3lame'];

async function fixture(directory, overrides = {}) {
  await mkdir(directory, { recursive: true });
  for (const component of components) for (const stage of stages) {
    const sha256 = overrides[`${component}-${stage}`] ?? 'a'.repeat(64);
    await writeFile(path.join(directory, `${component}-${stage}.json`), `${JSON.stringify({ component, stage, sha256, machOUuid: null })}\n`);
  }
}

test('stage comparison passes exact reports and identifies ffmpeg first mismatch', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'yuqi-repro-test-'));
  try {
    const first = path.join(temporary, 'first');
    const second = path.join(temporary, 'second');
    await fixture(first);
    await fixture(second);
    execFileSync(process.execPath, [path.join(root, 'scripts/compare-reproducibility.mjs'), first, second]);
    await fixture(second, Object.fromEntries(stages.slice(2).map((stage) => [`ffmpeg-${stage}`, 'b'.repeat(64)])));
    const mismatch = spawnSync(process.execPath, [path.join(root, 'scripts/compare-reproducibility.mjs'), first, second], { encoding: 'utf8' });
    assert.notEqual(mismatch.status, 0);
    assert.match(`${mismatch.stdout}${mismatch.stderr}`, /Non-reproducible final build files: ffmpeg/);

    await fixture(second, { 'libmp3lame-link': 'b'.repeat(64), 'libmp3lame-strip': 'b'.repeat(64), 'libmp3lame-postprocess': 'b'.repeat(64) });
    const normalized = execFileSync(process.execPath, [path.join(root, 'scripts/compare-reproducibility.mjs'), first, second], { encoding: 'utf8' });
    assert.match(normalized, /"firstDifference": "link"/);
    assert.match(normalized, /"resolvedAt": "pre-codesign"/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('build records every stage and normalizes deterministic output metadata', () => {
  for (const component of components) for (const stage of stages) assert.ok(build.includes(`${component} ${stage}`));
  assert.match(build, /codesign --remove-signature/);
  assert.match(build, /normalize-macho-uuid\.mjs/);
  assert.match(build, /chmod 0755/);
  assert.match(build, /chmod 0644/);
  assert.match(build, /touch -t/);
  assert.match(build, /xattr -c/);
});

test('Mach-O UUID normalization is deterministic and preserves an executable UUID', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'yuqi-uuid-test-'));
  try {
    const first = path.join(temporary, 'first');
    const second = path.join(temporary, 'second');
    const fixture = Buffer.alloc(64, 0);
    fixture.writeUInt32LE(0xfeedfacf, 0);
    fixture.writeUInt32LE(0x0100000c, 4);
    fixture.writeUInt32LE(1, 16);
    fixture.writeUInt32LE(24, 20);
    fixture.writeUInt32LE(0x1b, 32);
    fixture.writeUInt32LE(24, 36);
    Buffer.from('00112233445566778899aabbccddeeff', 'hex').copy(fixture, 40);
    await writeFile(first, fixture);
    await writeFile(second, fixture);
    for (const candidate of [first, second]) {
      execFileSync(process.execPath, [path.join(root, 'scripts/normalize-macho-uuid.mjs'), candidate]);
    }
    assert.deepEqual(await readFile(first), await readFile(second));
    const uuid = (await readFile(first)).subarray(40, 56);
    assert.equal(uuid[6] >> 4, 5);
    assert.equal(uuid[8] >> 6, 2);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('reproducibility workflow uses isolated roots without production identity', () => {
  const start = workflow.indexOf('  verify-reproducibility:');
  const end = workflow.indexOf('\n  release:', start);
  assert.ok(start > 0 && end > start);
  const job = workflow.slice(start, end);
  assert.match(job, /inputs\.publish == false && inputs\.reproducibility_check == true/);
  assert.match(job, /yuqi-repro-first/);
  assert.match(job, /yuqi-repro-second/);
  assert.match(job, /test "\$first" != "\$second"/);
  assert.match(job, /compare-reproducibility\.mjs/);
  assert.equal(job.includes('environment: production'), false);
  assert.equal(job.includes('YUQI_FFMPEG_ED25519_PRIVATE_KEY_PEM'), false);
  assert.equal(job.includes('inputs.publish == true'), false);
});
