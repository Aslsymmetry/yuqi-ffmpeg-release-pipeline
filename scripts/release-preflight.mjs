import { execFileSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseReleaseTag } from './release-metadata.mjs';

const API_ORIGIN = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const EXPECTED_REPOSITORY = 'Aslsymmetry/yuqi-ffmpeg-release-pipeline';
const MAX_RELEASE_PAGES = 10;
const REQUEST_TIMEOUT_MS = 60_000;

function required(environment, name) {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function outputLines(metadata, allowed) {
  const values = {
    release_allowed: String(allowed),
    release_tag: allowed ? metadata.releaseTag : '',
    release_title: allowed ? metadata.releaseTitle : '',
    asset_base: allowed ? metadata.assetBase : '',
    ffmpeg_version: allowed ? metadata.ffmpegVersion : '',
    lame_version: allowed ? metadata.lameVersion : '',
    revision_label: allowed ? metadata.revisionLabel : '',
    manifest_schema_version: allowed ? String(metadata.manifestSchemaVersion) : '',
    minimum_consumer_schema_version: allowed ? String(metadata.minimumConsumerSchemaVersion) : '',
    signing_key_generation: allowed ? metadata.signingKeyGeneration : '',
  };
  return `${Object.entries(values).map(([name, value]) => `${name}=${value}`).join('\n')}\n`;
}

function validateListItem(release) {
  if (!Number.isSafeInteger(release?.id) || release.id <= 0) throw new Error('Release list item ID is invalid');
  if (typeof release.tag_name !== 'string' || typeof release.draft !== 'boolean' || typeof release.prerelease !== 'boolean' || typeof release.target_commitish !== 'string') throw new Error('Release list item is invalid');
  return release;
}

async function findExactReleases(context, tag) {
  const matches = [];
  for (let page = 1; page <= MAX_RELEASE_PAGES; page += 1) {
    const url = new URL(`/repos/${context.repository}/releases?per_page=100&page=${page}`, API_ORIGIN);
    if (url.origin !== API_ORIGIN || url.protocol !== 'https:') throw new Error('Release lookup violates fixed API origin policy');
    const response = await context.fetchImpl(url, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${context.token}`, 'X-GitHub-Api-Version': API_VERSION, 'User-Agent': 'yuqi-ffmpeg-release-pipeline' },
      redirect: 'error', signal: context.timeoutFactory(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) { try { await response.body?.cancel(); } catch { /* never log bodies */ } throw new Error(`Release lookup failed with HTTP ${response.status}`); }
    const releases = await response.json();
    if (!Array.isArray(releases) || releases.length > 100) throw new Error('Release list response is invalid');
    for (const release of releases) if (validateListItem(release).tag_name === tag) matches.push(release);
    if (matches.length > 1) throw new Error('Multiple Releases exist for the exact tag');
    if (releases.length < 100) return matches;
  }
  throw new Error(`Release lookup exceeded ${MAX_RELEASE_PAGES} full pages`);
}

function verifyAnnotatedTag(environment, metadata, execFile = execFileSync) {
  const ref = `refs/tags/${metadata.releaseTag}`;
  const type = execFile('/usr/bin/git', ['cat-file', '-t', ref], { encoding: 'utf8' }).trim();
  if (type !== 'tag') throw new Error('Release tag must be annotated');
  const peeled = execFile('/usr/bin/git', ['rev-parse', `${ref}^{}`], { encoding: 'utf8' }).trim();
  if (peeled !== environment.GITHUB_SHA) throw new Error('Annotated tag target does not match GITHUB_SHA');
}

export async function runReleasePreflight(environment = process.env, dependencies = {}) {
  const publish = environment.PUBLISH_REQUESTED === 'true';
  if (!publish) return { allowed: false, output: outputLines({}, false) };
  const repository = required(environment, 'GITHUB_REPOSITORY');
  if (repository !== EXPECTED_REPOSITORY) throw new Error('Production repository mismatch');
  if (required(environment, 'GITHUB_REF_TYPE') !== 'tag') throw new Error('publish=true requires a tag ref');
  const tag = required(environment, 'GITHUB_REF_NAME');
  if (required(environment, 'GITHUB_REF') !== `refs/tags/${tag}`) throw new Error('GITHUB_REF and GITHUB_REF_NAME mismatch');
  if (!/^[a-f0-9]{40}$/.test(required(environment, 'GITHUB_SHA'))) throw new Error('GITHUB_SHA is invalid');
  const metadata = parseReleaseTag(tag);
  verifyAnnotatedTag(environment, metadata, dependencies.execFile ?? execFileSync);
  const matches = await findExactReleases({
    repository,
    token: required(environment, 'GITHUB_TOKEN'),
    fetchImpl: dependencies.fetchImpl ?? globalThis.fetch,
    timeoutFactory: dependencies.timeoutFactory ?? ((milliseconds) => AbortSignal.timeout(milliseconds)),
  }, metadata.releaseTag);
  if (matches.length > 1) throw new Error('Multiple Releases exist for the exact tag');
  if (matches[0]?.draft === false) throw new Error('A published Release already exists for this tag');
  if (matches[0] && (matches[0].draft !== true || matches[0].prerelease !== false || matches[0].target_commitish !== environment.GITHUB_SHA)) throw new Error('Existing Draft Release state is invalid');
  return { allowed: true, metadata, output: outputLines(metadata, true) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runReleasePreflight();
    await appendFile(required(process.env, 'GITHUB_OUTPUT'), result.output);
    console.log(`release preflight allowed=${result.allowed}`);
  } catch (error) {
    const safe = /(?:https?:\/\/|authorization|bearer|token|private key)/i.test(error.message) ? 'preflight policy failure' : error.message;
    console.error(`release preflight failed: ${safe}`);
    process.exitCode = 1;
  }
}

export const testing = { MAX_RELEASE_PAGES, EXPECTED_REPOSITORY, outputLines };
