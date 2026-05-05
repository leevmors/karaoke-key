// Generates 4 placeholder PNG icons (16/32/48/128) with a simple gradient
// disc + a music-note glyph. Pure Node, no deps.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const out = resolve(__dirname, "..", "public", "icons");
mkdirSync(out, { recursive: true });

const SIZES = [16, 32, 48, 128];

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function blend(c1, c2, t) {
  return [
    Math.round(lerp(c1[0], c2[0], t)),
    Math.round(lerp(c1[1], c2[1], t)),
    Math.round(lerp(c1[2], c2[2], t)),
  ];
}

function makeRGBA(size) {
  const px = new Uint8Array(size * size * 4);
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const r = size / 2 - 0.5;
  const cTop = [110, 231, 255]; // cyan
  const cBot = [255, 122, 182]; // pink
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > r) {
        px[i] = 0;
        px[i + 1] = 0;
        px[i + 2] = 0;
        px[i + 3] = 0;
        continue;
      }
      const t = y / (size - 1);
      const [cr, cg, cb] = blend(cTop, cBot, t);
      // soft edge
      const edge = Math.max(0, Math.min(1, r - d));
      const a = Math.round(255 * Math.min(1, edge / 1.2));
      px[i] = cr;
      px[i + 1] = cg;
      px[i + 2] = cb;
      px[i + 3] = a;
    }
  }
  // Draw a stylized music note in dark color near center
  const noteColor = [11, 13, 24];
  const stemX = Math.round(size * 0.5);
  const stemTop = Math.round(size * 0.26);
  const stemBot = Math.round(size * 0.66);
  const stemW = Math.max(1, Math.round(size * 0.06));
  for (let y = stemTop; y <= stemBot; y++) {
    for (let x = stemX; x < stemX + stemW; x++) {
      if (x < 0 || x >= size || y < 0 || y >= size) continue;
      const i = (y * size + x) * 4;
      px[i] = noteColor[0];
      px[i + 1] = noteColor[1];
      px[i + 2] = noteColor[2];
      px[i + 3] = 255;
    }
  }
  // Note head (filled ellipse)
  const headCx = stemX - Math.round(size * 0.06);
  const headCy = stemBot;
  const headRx = Math.max(2, Math.round(size * 0.13));
  const headRy = Math.max(2, Math.round(size * 0.1));
  for (let y = headCy - headRy; y <= headCy + headRy; y++) {
    for (let x = headCx - headRx; x <= headCx + headRx; x++) {
      if (x < 0 || x >= size || y < 0 || y >= size) continue;
      const nx = (x - headCx) / headRx;
      const ny = (y - headCy) / headRy;
      if (nx * nx + ny * ny <= 1) {
        const i = (y * size + x) * 4;
        px[i] = noteColor[0];
        px[i + 1] = noteColor[1];
        px[i + 2] = noteColor[2];
        px[i + 3] = 255;
      }
    }
  }
  // Flag at top of stem
  const flagX0 = stemX + stemW;
  const flagY0 = stemTop;
  const flagW = Math.max(2, Math.round(size * 0.18));
  const flagH = Math.max(2, Math.round(size * 0.16));
  for (let y = 0; y < flagH; y++) {
    const w = Math.round(flagW * (1 - y / flagH));
    for (let x = 0; x < w; x++) {
      const px_ = flagX0 + x;
      const py_ = flagY0 + y;
      if (px_ < 0 || px_ >= size || py_ < 0 || py_ >= size) continue;
      const i = (py_ * size + px_) * 4;
      px[i] = noteColor[0];
      px[i + 1] = noteColor[1];
      px[i + 2] = noteColor[2];
      px[i + 3] = 255;
    }
  }
  return px;
}

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = data.length;
  const buf = Buffer.alloc(8 + len + 4);
  buf.writeUInt32BE(len, 0);
  buf.write(type, 4, 4, "ascii");
  data.copy(buf, 8);
  const crcInput = Buffer.concat([Buffer.from(type, "ascii"), data]);
  buf.writeUInt32BE(crc32(crcInput), 8 + len);
  return buf;
}

function encodePNG(rgba, size) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(6, 9); // color type RGBA
  ihdr.writeUInt8(0, 10);
  ihdr.writeUInt8(0, 11);
  ihdr.writeUInt8(0, 12);
  // raw scanlines with filter byte 0
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }
  const idat = deflateSync(raw);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const s of SIZES) {
  const rgba = makeRGBA(s);
  const png = encodePNG(rgba, s);
  const file = resolve(out, `icon-${s}.png`);
  writeFileSync(file, png);
  console.log("wrote", file, png.length, "bytes");
}
