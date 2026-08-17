import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [fileArg, component, stage, reportDirectoryArg] = process.argv.slice(2);
if (!fileArg || !component || !stage || !reportDirectoryArg) {
  throw new Error('Usage: capture-binary-stage.mjs FILE COMPONENT STAGE REPORT_DIRECTORY');
}
if (!/^(ffmpeg|ffprobe|libmp3lame)$/.test(component) || !/^[a-z0-9-]+$/.test(stage)) {
  throw new Error('Invalid component or stage');
}

const file = path.resolve(fileArg);
const reportDirectory = path.resolve(reportDirectoryArg);
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const safeRun = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
};
const data = await readFile(file);
const details = await stat(file);
const loadCommands = run('/usr/bin/otool', ['-l', file]);
const dependencies = run('/usr/bin/otool', ['-L', file])
  .split(/\r?\n/).slice(1).map((line) => line.trim().split(/\s+\(/)[0]).filter(Boolean);
const signature = safeRun('/usr/bin/codesign', ['-d', '-vvv', file]);
const signatureField = (name) => signature.output.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1] ?? null;
const uuid = loadCommands.match(/cmd LC_UUID\s+cmdsize \d+\s+uuid ([0-9A-F-]+)/)?.[1] ?? null;
const commandNames = [...loadCommands.matchAll(/^\s*cmd (LC_[A-Z0-9_]+)$/gm)].map((match) => match[1]);
const report = {
  schemaVersion: 1,
  component,
  stage,
  sha256: createHash('sha256').update(data).digest('hex'),
  size: details.size,
  mode: details.mode & 0o777,
  mtimeEpochSeconds: Math.trunc(details.mtimeMs / 1000),
  architecture: run('/usr/bin/lipo', ['-archs', file]).trim(),
  machOUuid: uuid,
  loadCommandSummary: {
    count: commandNames.length,
    sha256: createHash('sha256').update(commandNames.join('\n')).digest('hex'),
    names: commandNames,
  },
  dependencies,
  linkedLame: dependencies.find((dependency) => dependency.includes('libmp3lame.0.dylib')) ?? null,
  codeSignature: {
    present: signature.status === 0,
    identifier: signatureField('Identifier'),
    cdHash: signatureField('CDHash'),
    flags: signatureField('CodeDirectory')?.match(/\bflags=([^\s]+)/)?.[1] ?? null,
    timestampPresent: /^Timestamp=/m.test(signature.output),
  },
};
await mkdir(reportDirectory, { recursive: true });
const destination = path.join(reportDirectory, `${component}-${stage}.json`);
await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o644 });
console.log(`[repro] ${component}/${stage} sha256=${report.sha256} size=${report.size} uuid=${report.machOUuid ?? 'none'} signed=${report.codeSignature.present}`);
