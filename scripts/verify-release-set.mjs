import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const directory = path.resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Usage: node verify-ffmpeg-set.mjs SET_DIRECTORY');
const ffmpeg = path.join(directory, 'ffmpeg');
const ffprobe = path.join(directory, 'ffprobe');
const lame = path.join(directory, 'lib', 'libmp3lame.0.dylib');
const files = { ffmpeg, ffprobe, libmp3lame: lame };
const run = (file, args, options = {}) => execFileSync(file, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 40 * 1024 * 1024, ...options });
const sha256 = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');

function dependencies(file) {
  const lines = run('/usr/bin/otool', ['-L', file]).split(/\r?\n/).slice(1).map((line) => line.trim().split(/\s+\(/)[0]).filter(Boolean);
  for (const dependency of lines) {
    const allowed = dependency === '@loader_path/lib/libmp3lame.0.dylib' || dependency.startsWith('/usr/lib/') || dependency.startsWith('/System/Library/');
    if (!allowed) throw new Error(`Non-portable dependency in ${path.basename(file)}: ${dependency}`);
    if (/\/opt\/homebrew|\/usr\/local|\/Users\//.test(dependency)) throw new Error(`Development-machine dependency in ${file}: ${dependency}`);
  }
  return lines;
}

const report = { schemaVersion: 1, setId: '', files: {}, smokeTests: [] };
for (const [name, file] of Object.entries(files)) {
  if ((await stat(file)).size < 1) throw new Error(`${name} is empty`);
  const description = run('/usr/bin/file', [file]).trim();
  const architectures = run('/usr/bin/lipo', ['-archs', file]).trim().split(/\s+/);
  if (!description.includes('Mach-O 64-bit') || architectures.length !== 1 || architectures[0] !== 'arm64') throw new Error(`${name} is not arm64-only Mach-O: ${description}`);
  report.files[name] = { path: path.relative(directory, file), sha256: await sha256(file), description, architectures, dependencies: dependencies(file) };
  const embedded = run('/usr/bin/strings', [file]);
  if (/\/tmp\/yuqi-ffmpeg-release-build|\/private\/tmp\/|\/var\/folders\/|\/Users\/|\/opt\/homebrew|\/usr\/local/.test(embedded)) throw new Error(`Build-machine path embedded in ${name}`);
}
report.setId = `ffmpeg-9.0.1-lame-3.100-arm64-${report.files.ffmpeg.sha256.slice(0, 8)}-${report.files.ffprobe.sha256.slice(0, 8)}-${report.files.libmp3lame.sha256.slice(0, 8)}`;
if (!report.files.ffmpeg.dependencies.includes('@loader_path/lib/libmp3lame.0.dylib')) throw new Error('ffmpeg does not use the bundled LAME install name');
if (!report.files.ffprobe.dependencies.includes('@loader_path/lib/libmp3lame.0.dylib')) throw new Error('ffprobe does not use the bundled LAME install name');
if (run('/usr/bin/otool', ['-D', lame]).trim().split(/\r?\n/).at(-1) !== '@loader_path/lib/libmp3lame.0.dylib') throw new Error('LAME dylib install name mismatch');

const ffmpegVersion = run(ffmpeg, ['-version']);
const ffprobeVersion = run(ffprobe, ['-version']);
if (!ffmpegVersion.startsWith('ffmpeg version 9.0.1') || !ffprobeVersion.startsWith('ffprobe version 9.0.1')) throw new Error('FFmpeg/FFprobe version mismatch');
const configuration = ffmpegVersion.split(/\r?\n/).find((line) => line.startsWith('configuration:'));
const probeConfiguration = ffprobeVersion.split(/\r?\n/).find((line) => line.startsWith('configuration:'));
if (!configuration || configuration !== probeConfiguration) throw new Error('FFmpeg/FFprobe configuration mismatch');
if (/--enable-(?:gpl|nonfree)/.test(configuration)) throw new Error('GPL or nonfree configuration is forbidden');
if (!configuration.includes('--enable-libmp3lame') || !configuration.includes('--disable-network')) throw new Error('Required LAME/network configuration is missing');
report.version = '9.0.1'; report.configuration = configuration;
for (const option of ['-formats', '-codecs', '-encoders', '-decoders', '-filters']) {
  if (run(ffmpeg, [option]).length < 100) throw new Error(`${option} produced no useful output`);
  report.smokeTests.push(option);
}

const temporary = path.join(os.tmpdir(), `yuqi-ffmpeg-smoke-${randomUUID()}`);
await mkdir(temporary, { recursive: true });
try {
  const source = path.join(temporary, '한글 및 공백 source.wav');
  run(ffmpeg, ['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5', '-c:a', 'pcm_s24le', source]);
  for (const [label, extension, args] of [
    ['MP3 libmp3lame 320k', 'mp3', ['-c:a', 'libmp3lame', '-b:a', '320k']],
    ['AIFF pcm_s24be', 'aiff', ['-c:a', 'pcm_s24be']],
    ['WAV pcm_s24le', 'wav', ['-c:a', 'pcm_s24le']],
    ['M4A AAC 256k', 'm4a', ['-c:a', 'aac', '-b:a', '256k']],
  ]) {
    const output = path.join(temporary, `한글 출력 ${label}.${extension}`);
    run(ffmpeg, ['-hide_banner', '-nostdin', '-y', '-i', source, '-vn', ...args, output]);
    const json = JSON.parse(run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,codec_type', '-of', 'json', output]));
    if (!(Number(json.format.duration) > 0) || !json.streams.some((stream) => stream.codec_type === 'audio')) throw new Error(`${label} probe failed`);
    report.smokeTests.push(label);
  }
  const video = path.join(temporary, '한글 영상.mp4');
  const merged = path.join(temporary, '한글 병합 영상.mp4');
  const copied = path.join(temporary, '한글 stream copy.mp4');
  run(ffmpeg, ['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=128x72:d=0.5', '-c:v', 'mpeg4', video]);
  run(ffmpeg, ['-hide_banner', '-nostdin', '-y', '-i', video, '-i', source, '-c:v', 'copy', '-c:a', 'aac', '-shortest', merged]);
  run(ffmpeg, ['-hide_banner', '-nostdin', '-y', '-i', merged, '-c', 'copy', copied]);
  const probe = JSON.parse(run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,codec_type,width,height', '-of', 'json', copied]));
  if (!probe.streams.some((stream) => stream.codec_type === 'video' && stream.width === 128 && stream.height === 72) || !probe.streams.some((stream) => stream.codec_type === 'audio')) throw new Error('MP4 merge/copy/JSON probe failed');
  report.smokeTests.push('MP4 video+audio merge', 'stream copy', 'ffprobe duration/codec/resolution/streams JSON', 'Korean and spaces path');
  const invalid = spawnSync(ffmpeg, ['-hide_banner', '-nostdin', '-i', path.join(temporary, 'missing-input')], { encoding: 'utf8', timeout: 10_000 });
  if (invalid.status === 0) throw new Error('Invalid input unexpectedly succeeded');
  report.smokeTests.push('invalid input nonzero exit');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
console.log(JSON.stringify(report, null, 2));
