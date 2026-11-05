// Generates extension/icons/{16,48,128}.png — a rounded indigo square with a white ring.
// Run: node tools/make-icons.js
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

function crc32(buf) {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  let crc = 0xFFFFFFFF;
  for (const b of buf) crc = t[(crc ^ b) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const cx = size / 2, cy = size / 2;
  const rOut = size * 0.72, rIn = size * 0.44, corner = size * 0.22;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter none
    for (let x = 0; x < size; x++) {
      const i = y * (size * 4 + 1) + 1 + x * 4;
      // rounded-rect test
      const dx = Math.max(Math.abs(x - cx) - (size / 2 - corner), 0);
      const dy = Math.max(Math.abs(y - cy) - (size / 2 - corner), 0);
      const inSquare = Math.hypot(dx, dy) <= corner;
      const d = Math.hypot(x - cx, y - cy);
      if (!inSquare) { raw[i + 3] = 0; continue; }
      if (d <= rOut && d >= rIn) { raw[i] = 255; raw[i + 1] = 255; raw[i + 2] = 255; raw[i + 3] = 255; }
      else { raw[i] = 0x4f; raw[i + 1] = 0x46; raw[i + 2] = 0xe5; raw[i + 3] = 255; }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

const out = path.join(__dirname, "..", "extension", "icons");
fs.mkdirSync(out, { recursive: true });
for (const s of [16, 48, 128]) {
  fs.writeFileSync(path.join(out, `icon${s}.png`), png(s));
  console.log(`wrote icons/icon${s}.png`);
}
