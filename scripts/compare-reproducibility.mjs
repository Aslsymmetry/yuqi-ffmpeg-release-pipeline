import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const [firstArg, secondArg] = process.argv.slice(2);
if (!firstArg || !secondArg) throw new Error('Usage: compare-reproducibility.mjs FIRST_REPORT_DIR SECOND_REPORT_DIR');
const components = ['ffmpeg', 'ffprobe', 'libmp3lame'];
const stages = ['link', 'strip', 'postprocess', 'pre-codesign', 'post-codesign', 'final'];

async function load(directory, component, stage) {
  return JSON.parse(await readFile(path.join(directory, `${component}-${stage}.json`), 'utf8'));
}

const result = { schemaVersion: 1, reproducible: true, canonicalSetSha256: '', components: {} };
for (const component of components) {
  let firstDifference = null;
  const comparisons = [];
  for (const stage of stages) {
    const [first, second] = await Promise.all([load(firstArg, component, stage), load(secondArg, component, stage)]);
    const equal = first.sha256 === second.sha256;
    comparisons.push({ stage, equal, firstSha256: first.sha256, secondSha256: second.sha256, firstUuid: first.machOUuid, secondUuid: second.machOUuid });
    if (!equal && !firstDifference) firstDifference = stage;
  }
  const final = comparisons.find((comparison) => comparison.stage === 'final');
  if (!final?.equal) result.reproducible = false;
  const resolvedAt = firstDifference ? comparisons.find((comparison) => comparison.equal && stages.indexOf(comparison.stage) > stages.indexOf(firstDifference))?.stage ?? null : null;
  result.components[component] = { firstDifference, resolvedAt, comparisons };
}

for (const directory of [firstArg, secondArg]) {
  const names = (await readdir(directory)).sort();
  const expected = components.flatMap((component) => stages.map((stage) => `${component}-${stage}.json`)).sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error(`Unexpected stage report set in ${path.basename(directory)}`);
  for (const name of names) if (!(await stat(path.join(directory, name))).isFile()) throw new Error(`Non-file report: ${name}`);
}
const canonicalSet = components.map((component) => {
  const final = result.components[component].comparisons.find((comparison) => comparison.stage === 'final');
  return `${component}\0${final.firstSha256}\n`;
}).join('');
result.canonicalSetSha256 = createHash('sha256').update(canonicalSet).digest('hex');
const canonical = `${JSON.stringify(result)}\n`;
console.log(JSON.stringify(result, null, 2));
console.log(`[repro] comparison-sha256=${createHash('sha256').update(canonical).digest('hex')}`);
if (!result.reproducible) {
  const summary = components.filter((component) => !result.components[component].comparisons.at(-1).equal).map((component) => component).join(', ');
  throw new Error(`Non-reproducible final build files: ${summary}`);
}
