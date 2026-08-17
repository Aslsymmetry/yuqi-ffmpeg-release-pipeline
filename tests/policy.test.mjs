import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const lock = JSON.parse(await readFile(new URL('../config/source-lock.json', import.meta.url)));
const workflow = await readFile(new URL('../.github/workflows/build-release.yml', import.meta.url), 'utf8');
const build = await readFile(new URL('../scripts/build-ffmpeg-arm64.sh', import.meta.url), 'utf8');
const releaseVerifier = await readFile(new URL('../scripts/verify-production-signing-key.mjs', import.meta.url), 'utf8');

function jobBlock(yaml, jobName) {
  const lines = yaml.split(/\r?\n/);
  const jobStart = lines.findIndex((line) => line === `  ${jobName}:`);
  assert.notEqual(jobStart, -1, `${jobName} job is missing`);
  const jobEndOffset = lines.slice(jobStart + 1).findIndex((line) => /^  [A-Za-z0-9_-]+:$/.test(line));
  const jobEnd = jobEndOffset === -1 ? lines.length : jobStart + 1 + jobEndOffset;
  return lines.slice(jobStart, jobEnd);
}

function jobSteps(yaml, jobName) {
  const jobLines = jobBlock(yaml, jobName);
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
  assert.ok(workflow.includes('npm run release:draft'));
  assert.equal(workflow.includes('gh release create'), false);
  assert.ok(workflow.includes('YUQI_FFMPEG_ED25519_PRIVATE_KEY_PEM'));
  assert.ok(workflow.includes('environment: production'));
  assert.ok(workflow.includes('npm run release:verify-key'));
  assert.equal(releaseVerifier.includes('console.log'), false);
  assert.equal(releaseVerifier.includes('console.error'), false);
});

test('release job preserves artifact output by checking out before download', () => {
  const steps = jobSteps(workflow, 'release');
  const checkout = stepIndex(steps, (step) => step.kind === 'uses' && step.value.startsWith('actions/checkout@'), 'checkout');
  const setupNode = stepIndex(steps, (step) => step.kind === 'uses' && step.value.startsWith('actions/setup-node@'), 'setup-node');
  const npmCi = stepIndex(steps, (step) => step.kind === 'run' && step.value === 'npm ci --ignore-scripts', 'npm ci');
  const secretCheck = stepIndex(steps, (step) => step.kind === 'name' && step.value === 'Require exact protected tag and signing secret', 'signing secret check');
  const download = stepIndex(steps, (step) => step.kind === 'name' && step.value === 'Download and verify exact build artifact', 'internal artifact download');
  const identity = stepIndex(steps, (step) => step.kind === 'name' && step.value === 'Verify production signing identity against pinned trust', 'signing identity verification');
  const sign = stepIndex(steps, (step) => step.kind === 'name' && step.value === 'Sign with protected release key', 'release signing');
  const publish = stepIndex(steps, (step) => step.kind === 'name' && step.value === 'Recover or create verified Draft Release', 'draft release recovery');

  assert.ok(checkout < download);
  assert.ok(setupNode < download);
  assert.ok(npmCi < download);
  assert.ok(npmCi < secretCheck);
  assert.ok(secretCheck < download);
  assert.ok(download < identity);
  assert.ok(download < sign);
  assert.ok(download < publish);
  assert.ok(steps[publish].lines.some((line) => /^        run: npm run release:draft$/.test(line)));
  assert.ok(steps[download].lines.some((line) => /^          ARTIFACT_DESTINATION: build\/output$/.test(line)));
  assert.ok(steps[download].lines.some((line) => /^        run: node scripts\/download-build-artifact\.mjs$/.test(line)));
  assert.equal(steps[checkout].lines.some((line) => /^          clean:\s*false\s*$/.test(line)), false);
  assert.ok(steps[secretCheck].lines.some((line) => /^          test -n "\$SIGNING_KEY"$/.test(line)));
  assert.equal(steps[secretCheck].lines.some((line) => /(?:echo|printf|cat).*SIGNING_KEY/.test(line)), false);
});

test('workflow hands exact upload identity to internal artifact consumers', () => {
  const buildJob = jobBlock(workflow, 'build').join('\n');
  const releaseJob = jobBlock(workflow, 'release').join('\n');
  const verifyJob = jobBlock(workflow, 'verify-artifact-handoff').join('\n');
  assert.match(buildJob, /outputs:\n      artifact-id: \$\{\{ steps\.upload_build_output\.outputs\['artifact-id'\] \}\}\n      artifact-digest: \$\{\{ steps\.upload_build_output\.outputs\['artifact-digest'\] \}\}/);
  assert.match(buildJob, /- id: upload_build_output\n        uses: actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7\.0\.1/);
  assert.match(buildJob, /name: Require artifact identity outputs/);
  assert.match(buildJob, /test -n "\$ARTIFACT_ID"/);
  assert.match(buildJob, /test -n "\$ARTIFACT_DIGEST"/);
  for (const job of [releaseJob, verifyJob]) {
    assert.match(job, /EXPECTED_ARTIFACT_ID: \$\{\{ needs\.build\.outputs\['artifact-id'\] \}\}/);
    assert.match(job, /EXPECTED_ARTIFACT_DIGEST: \$\{\{ needs\.build\.outputs\['artifact-digest'\] \}\}/);
    assert.match(job, /actions: read/);
  }
  assert.equal(workflow.includes('actions/download-artifact@'), false);
});

test('non-production handoff job is isolated from production identity', () => {
  const verifyJob = jobBlock(workflow, 'verify-artifact-handoff').join('\n');
  const releaseJob = jobBlock(workflow, 'release').join('\n');
  assert.match(verifyJob, /if: github\.event_name == 'workflow_dispatch' && inputs\.publish == false/);
  assert.equal(verifyJob.includes('environment: production'), false);
  assert.equal(verifyJob.includes('YUQI_FFMPEG_ED25519_PRIVATE_KEY_PEM'), false);
  assert.equal(verifyJob.includes('Require exact protected tag and signing secret'), false);
  assert.match(releaseJob, /environment: production/);
  assert.match(releaseJob, /Require exact protected tag and signing secret/);
});

test('unchanged official actions remain pinned to expected full SHAs', () => {
  assert.match(workflow, /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\.0\.1/g);
  assert.match(workflow, /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7\.0\.0/g);
  assert.match(workflow, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7\.0\.1/);
});

test('reproducibility job preserves normal build and handoff paths', () => {
  const job = jobBlock(workflow, 'verify-reproducibility').join('\n');
  assert.match(job, /inputs\.publish == false && inputs\.reproducibility_check == true/);
  assert.equal(job.includes('environment: production'), false);
  assert.equal(job.includes('PRIVATE_KEY'), false);
  assert.match(job, /YUQI_FFMPEG_BUILD_ROOT="\$first"/);
  assert.match(job, /YUQI_FFMPEG_BUILD_ROOT="\$second"/);
  assert.match(job, /compare-reproducibility\.mjs/);
  assert.match(jobBlock(workflow, 'build').join('\n'), /upload_build_output/);
  assert.match(jobBlock(workflow, 'verify-artifact-handoff').join('\n'), /download-build-artifact\.mjs/);
});
