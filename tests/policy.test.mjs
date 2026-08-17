import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const lock = JSON.parse(await readFile(new URL('../config/source-lock.json', import.meta.url)));
const workflow = await readFile(new URL('../.github/workflows/build-release.yml', import.meta.url), 'utf8');
const build = await readFile(new URL('../scripts/build-ffmpeg-arm64.sh', import.meta.url), 'utf8');
const releaseVerifier = await readFile(new URL('../scripts/verify-production-signing-key.mjs', import.meta.url), 'utf8');

function releaseJobSteps(yaml) {
  const lines = yaml.split(/\r?\n/);
  const releaseStart = lines.findIndex((line) => line === '  release:');
  assert.notEqual(releaseStart, -1, 'release job is missing');
  const releaseEndOffset = lines.slice(releaseStart + 1).findIndex((line) => /^  [A-Za-z0-9_-]+:$/.test(line));
  const releaseEnd = releaseEndOffset === -1 ? lines.length : releaseStart + 1 + releaseEndOffset;
  const jobLines = lines.slice(releaseStart, releaseEnd);
  const stepsStart = jobLines.findIndex((line) => line === '    steps:');
  assert.notEqual(stepsStart, -1, 'release steps are missing');
  const steps = [];
  for (const line of jobLines.slice(stepsStart + 1)) {
    const start = line.match(/^      - (uses|name|run):\s*(.+)$/);
    if (start) steps.push({ kind: start[1], value: start[2], lines: [line] });
    else if (steps.length) steps.at(-1).lines.push(line);
  }
  return steps;
}

function stepIndex(steps, predicate, description) {
  const index = steps.findIndex(predicate);
  assert.notEqual(index, -1, `${description} step is missing`);
  return index;
}

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
  assert.ok(workflow.includes('environment: production'));
  assert.ok(workflow.includes('npm run release:verify-key'));
  assert.equal(releaseVerifier.includes('console.log'), false);
  assert.equal(releaseVerifier.includes('console.error'), false);
});

test('release job preserves artifact output by checking out before download', () => {
  const steps = releaseJobSteps(workflow);
  const checkout = stepIndex(steps, (step) => step.kind === 'uses' && step.value.startsWith('actions/checkout@'), 'checkout');
  const setupNode = stepIndex(steps, (step) => step.kind === 'uses' && step.value.startsWith('actions/setup-node@'), 'setup-node');
  const npmCi = stepIndex(steps, (step) => step.kind === 'run' && step.value === 'npm ci --ignore-scripts', 'npm ci');
  const secretCheck = stepIndex(steps, (step) => step.kind === 'name' && step.value === 'Require exact protected tag and signing secret', 'signing secret check');
  const download = stepIndex(steps, (step) => step.kind === 'uses' && step.value.startsWith('actions/download-artifact@'), 'download-artifact');
  const identity = stepIndex(steps, (step) => step.kind === 'name' && step.value === 'Verify production signing identity against pinned trust', 'signing identity verification');
  const sign = stepIndex(steps, (step) => step.kind === 'name' && step.value === 'Sign with protected release key', 'release signing');
  const publish = stepIndex(steps, (step) => step.kind === 'name' && step.value === 'Publish four immutable assets', 'draft release publishing');

  assert.ok(checkout < download);
  assert.ok(setupNode < download);
  assert.ok(npmCi < download);
  assert.ok(npmCi < secretCheck);
  assert.ok(secretCheck < download);
  assert.ok(download < identity);
  assert.ok(download < sign);
  assert.ok(download < publish);
  assert.ok(steps[download].lines.some((line) => /^          path: build\/output$/.test(line)));
  assert.equal(steps[checkout].lines.some((line) => /^          clean:\s*false\s*$/.test(line)), false);
  assert.ok(steps[secretCheck].lines.some((line) => /^          test -n "\$SIGNING_KEY"$/.test(line)));
  assert.equal(steps[secretCheck].lines.some((line) => /(?:echo|printf|cat).*SIGNING_KEY/.test(line)), false);
});
