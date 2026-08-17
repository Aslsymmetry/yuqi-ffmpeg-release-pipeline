import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const file = process.argv[2];
if (!file) throw new Error('Usage: normalize-macho-uuid.mjs MACHO_FILE');
const data = await readFile(file);
if (data.length < 32 || data.readUInt32LE(0) !== 0xfeedfacf) throw new Error('Only little-endian 64-bit Mach-O is supported');
const commandCount = data.readUInt32LE(16);
const commandBytes = data.readUInt32LE(20);
let offset = 32;
let uuidOffset = null;
for (let index = 0; index < commandCount; index += 1) {
  if (offset + 8 > data.length || offset + 8 > 32 + commandBytes) throw new Error('Malformed Mach-O load commands');
  const command = data.readUInt32LE(offset);
  const size = data.readUInt32LE(offset + 4);
  if (size < 8 || offset + size > data.length || offset + size > 32 + commandBytes) throw new Error('Malformed Mach-O load command size');
  if (command === 0x1b) {
    if (size !== 24 || uuidOffset !== null) throw new Error('Expected exactly one valid LC_UUID');
    uuidOffset = offset + 8;
  }
  offset += size;
}
if (uuidOffset === null) throw new Error('LC_UUID is missing');

const normalized = Buffer.from(data);
normalized.fill(0, uuidOffset, uuidOffset + 16);
const uuid = createHash('sha256').update(normalized).digest().subarray(0, 16);
uuid[6] = (uuid[6] & 0x0f) | 0x50;
uuid[8] = (uuid[8] & 0x3f) | 0x80;
uuid.copy(data, uuidOffset);
await writeFile(file, data);
const hex = uuid.toString('hex').toUpperCase();
console.log(`[repro] normalized LC_UUID=${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`);
