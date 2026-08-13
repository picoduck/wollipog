/**
 * Derives the Wollipog icon set (apps/web/public/icons/) from the ORIGINAL brand art
 * (assets/wollipog-logo.png — the full lockup: pixel-platypus tile + wordmark) using pure
 * node:zlib PNG decode/encode — no image dependencies (this repo runs on Windows ARM64
 * where native modules are a hazard).
 *
 * Pipeline: decode the lockup → isolate the TILE (the first non-transparent horizontal
 * band; the wordmark below is separated by a transparent gap) → square-pad → box-filter
 * resample:
 *  - "any" icons (192/512): the tile with its own rounded corners/outline on transparency.
 *  - maskable 512 / apple-touch 180: tile at 80% composited on a full-bleed slate square
 *    (the platform applies its own mask; iOS composites transparency onto black).
 *
 * Rerun with: node scripts/generate-pwa-icons.mjs
 */

import { deflateSync, inflateSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "assets", "wollipog-logo.png");
const OUT = join(ROOT, "apps", "web", "public", "icons");

/** Full-bleed background behind the maskable/apple-touch tile (the logo's slate). */
const BG = [0x3c, 0x58, 0x72];

/* ------------------------------- PNG codec -------------------------------- */
// Portable CRC-32 (ISO 3309, the PNG one): node:zlib.crc32 only exists from Node 22.2, and
// the repo's engine floor is >=22.0 — ten lines beats a version fence for build tooling.
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Encode an RGBA image { w, h, data } (data = w*h*4 bytes). */
function encodePng({ w, h, data }) {
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0; // filter: none
    data.copy(raw, y * (1 + w * 4) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Decode an 8-bit RGBA non-interlaced PNG (what the brand file is; asserted). */
function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    throw new Error("not a PNG");
  }
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  if (buf[24] !== 8 || buf[25] !== 6 || buf[28] !== 0) {
    throw new Error(`unsupported PNG shape (need 8-bit RGBA non-interlaced): depth=${buf[24]} color=${buf[25]} interlace=${buf[28]}`);
  }
  const idat = [];
  for (let o = 8; o < buf.length; ) {
    const len = buf.readUInt32BE(o);
    const type = buf.subarray(o + 4, o + 8).toString("ascii");
    if (type === "IDAT") idat.push(buf.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * 4;
  const data = Buffer.alloc(w * h * 4);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = y * stride;
    const prev = out - stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? data[out + x - 4] : 0;
      const up = y > 0 ? data[prev + x] : 0;
      const upLeft = y > 0 && x >= 4 ? data[prev + x - 4] : 0;
      let v = line[x];
      if (filter === 1) v += left;
      else if (filter === 2) v += up;
      else if (filter === 3) v += (left + up) >> 1;
      else if (filter === 4) v += paeth(left, up, upLeft);
      else if (filter !== 0) throw new Error(`unsupported PNG filter ${filter}`);
      data[out + x] = v & 0xff;
    }
  }
  return { w, h, data };
}

/* ------------------------------ image ops --------------------------------- */

const ALPHA_MIN = 16;

/** Rows that contain any visible pixel. */
function contentRows(img) {
  const rows = new Uint8Array(img.h);
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      if (img.data[(y * img.w + x) * 4 + 3] >= ALPHA_MIN) {
        rows[y] = 1;
        break;
      }
    }
  }
  return rows;
}

/**
 * The tile = the FIRST contiguous content band (the wordmark below is separated by a run
 * of fully transparent rows). Returns its square-padded bounding box crop.
 */
function cropTile(img) {
  const rows = contentRows(img);
  let top = rows.indexOf(1);
  if (top < 0) throw new Error("brand image is fully transparent?");
  let bottom = top;
  let gap = 0;
  for (let y = top; y < img.h; y++) {
    if (rows[y]) {
      bottom = y;
      gap = 0;
    } else if (++gap >= Math.round(img.h * 0.01)) break; // ≥1% empty rows = band over
  }
  let left = img.w;
  let right = 0;
  for (let y = top; y <= bottom; y++) {
    for (let x = 0; x < img.w; x++) {
      if (img.data[(y * img.w + x) * 4 + 3] >= ALPHA_MIN) {
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  const bw = right - left + 1;
  const bh = bottom - top + 1;
  const side = Math.max(bw, bh);
  const out = { w: side, h: side, data: Buffer.alloc(side * side * 4) };
  const ox = Math.floor((side - bw) / 2);
  const oy = Math.floor((side - bh) / 2);
  for (let y = 0; y < bh; y++) {
    img.data.copy(out.data, ((y + oy) * side + ox) * 4, ((top + y) * img.w + left) * 4, ((top + y) * img.w + right + 1) * 4);
  }
  return out;
}

/**
 * Area-weighted box-filter resample with premultiplied alpha: each source pixel
 * contributes by its FRACTIONAL overlap with the output box (a 1.5px span is 1.0 + 0.5,
 * not two equal halves), so pixel-art edges land where they should at non-integer ratios.
 */
function resize(img, size) {
  const out = { w: size, h: size, data: Buffer.alloc(size * size * 4) };
  const sx = img.w / size;
  const sy = img.h / size;
  for (let y = 0; y < size; y++) {
    const fy0 = y * sy;
    const fy1 = (y + 1) * sy;
    for (let x = 0; x < size; x++) {
      const fx0 = x * sx;
      const fx1 = (x + 1) * sx;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let area = 0;
      for (let py = Math.floor(fy0); py < Math.min(img.h, Math.ceil(fy1)); py++) {
        const wy = Math.min(fy1, py + 1) - Math.max(fy0, py);
        if (wy <= 0) continue;
        for (let px = Math.floor(fx0); px < Math.min(img.w, Math.ceil(fx1)); px++) {
          const wx = Math.min(fx1, px + 1) - Math.max(fx0, px);
          if (wx <= 0) continue;
          const wgt = wx * wy;
          const o = (py * img.w + px) * 4;
          const al = img.data[o + 3] * wgt;
          r += img.data[o] * al;
          g += img.data[o + 1] * al;
          b += img.data[o + 2] * al;
          a += al;
          area += wgt;
        }
      }
      const o = (y * size + x) * 4;
      if (a > 0) {
        out.data[o] = Math.round(r / a);
        out.data[o + 1] = Math.round(g / a);
        out.data[o + 2] = Math.round(b / a);
        out.data[o + 3] = Math.round(a / area);
      }
    }
  }
  return out;
}

/** Tile at `scale` of the canvas, alpha-composited on a solid full-bleed background. */
function fullBleed(tile, size, scale) {
  const inner = resize(tile, Math.round(size * scale));
  const out = { w: size, h: size, data: Buffer.alloc(size * size * 4) };
  for (let i = 0; i < size * size; i++) {
    out.data[i * 4] = BG[0];
    out.data[i * 4 + 1] = BG[1];
    out.data[i * 4 + 2] = BG[2];
    out.data[i * 4 + 3] = 255;
  }
  const off = Math.floor((size - inner.w) / 2);
  for (let y = 0; y < inner.h; y++) {
    for (let x = 0; x < inner.w; x++) {
      const si = (y * inner.w + x) * 4;
      const a = inner.data[si + 3] / 255;
      if (a === 0) continue;
      const di = ((y + off) * size + (x + off)) * 4;
      out.data[di] = Math.round(inner.data[si] * a + out.data[di] * (1 - a));
      out.data[di + 1] = Math.round(inner.data[si + 1] * a + out.data[di + 1] * (1 - a));
      out.data[di + 2] = Math.round(inner.data[si + 2] * a + out.data[di + 2] * (1 - a));
      out.data[di + 3] = 255;
    }
  }
  return out;
}

/* ------------------------- desktop icon containers ------------------------- */
// Tauri's bundle.icon list needs .ico (Windows exe/installer) and .icns (macOS). Both
// formats accept embedded payloads we can produce purely: ICO holds classic 32bpp DIB
// entries (small sizes; maximum compatibility) plus a PNG entry for 256; ICNS holds PNG
// payloads under the modern icXX type codes.

/** One classic ICO DIB entry: BITMAPINFOHEADER + bottom-up BGRA + zeroed AND mask. */
function icoDib(img) {
  const { w, h, data } = img;
  const maskStride = Math.ceil(w / 32) * 4; // 1-bit rows padded to 32 bits
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(w, 4);
  header.writeInt32LE(h * 2, 8); // XOR + AND heights
  header.writeUInt16LE(1, 12); // planes
  header.writeUInt16LE(32, 14); // bpp
  header.writeUInt32LE(w * h * 4 + maskStride * h, 20); // biSizeImage
  const xor = Buffer.alloc(w * h * 4);
  const mask = Buffer.alloc(maskStride * h); // 1 = transparent, for pre-alpha renderers
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      const d = ((h - 1 - y) * w + x) * 4; // bottom-up
      xor[d] = data[s + 2]; // B
      xor[d + 1] = data[s + 1]; // G
      xor[d + 2] = data[s]; // R
      xor[d + 3] = data[s + 3]; // A
      if (data[s + 3] < 128) mask[(h - 1 - y) * maskStride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return Buffer.concat([header, xor, mask]);
}

/** ICO container: DIB entries for the small sizes, PNG for 256. 32px leads — pinned
 * tauri-codegen decodes ENTRY ZERO for the default window icon, so a 16px-first order
 * would hand Windows a blocky upscale for taskbar/Alt-Tab. */
function encodeIco(tile) {
  const entries = [32, 16, 24, 48, 64, 128].map((s) => ({ size: s, data: icoDib(resize(tile, s)) }));
  entries.push({ size: 256, data: encodePng(resize(tile, 256)) });
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(1, 2); // type: icon
  dir.writeUInt16LE(entries.length, 4);
  let offset = 6 + entries.length * 16;
  const heads = entries.map((e) => {
    const h = Buffer.alloc(16);
    h[0] = e.size === 256 ? 0 : e.size; // 0 = 256
    h[1] = e.size === 256 ? 0 : e.size;
    h.writeUInt16LE(1, 4); // planes
    h.writeUInt16LE(32, 6); // bpp
    h.writeUInt32LE(e.data.length, 8);
    h.writeUInt32LE(offset, 12);
    offset += e.data.length;
    return h;
  });
  return Buffer.concat([dir, ...heads, ...entries.map((e) => e.data)]);
}

/** ICNS container: PNG payloads under the modern type codes. */
function encodeIcns(tile) {
  const TYPES = [
    ["ic11", 32], // 16pt@2x
    ["ic12", 64], // 32pt@2x
    ["ic07", 128],
    ["ic08", 256],
    ["ic09", 512],
    ["ic10", 1024], // 512pt@2x — Finder's largest Retina view (upscaled from the 768px tile,
    // still sharper than letting Finder scale the 512 at display time)
  ];
  const entries = TYPES.map(([type, size]) => {
    const png = encodePng(resize(tile, size));
    const head = Buffer.alloc(8);
    head.write(type, 0, "ascii");
    head.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([head, png]);
  });
  const total = entries.reduce((n, e) => n + e.length, 8);
  const head = Buffer.alloc(8);
  head.write("icns", 0, "ascii");
  head.writeUInt32BE(total, 4);
  return Buffer.concat([head, ...entries]);
}

/* --------------------------------- main ----------------------------------- */

const tile = cropTile(decodePng(readFileSync(SRC)));

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "icon-192.png"), encodePng(resize(tile, 192)));
writeFileSync(join(OUT, "icon-512.png"), encodePng(resize(tile, 512)));
writeFileSync(join(OUT, "icon-maskable-512.png"), encodePng(fullBleed(tile, 512, 0.8)));
writeFileSync(join(OUT, "apple-touch-icon.png"), encodePng(fullBleed(tile, 180, 0.84)));

// The desktop shell's bundle icons: everything Tauri scaffolds (tauri.conf.json lists the
// core five; the Square*/StoreLogo sizes feed the MSIX/appx targets) so no legacy icon
// survives anywhere in a packaged app.
const DESKTOP = join(ROOT, "apps", "desktop", "src-tauri", "icons");
mkdirSync(DESKTOP, { recursive: true });
const DESKTOP_PNGS = [
  ["32x32.png", 32],
  ["64x64.png", 64],
  ["128x128.png", 128],
  ["128x128@2x.png", 256],
  ["icon.png", 512],
  ["StoreLogo.png", 50],
  ["Square30x30Logo.png", 30],
  ["Square44x44Logo.png", 44],
  ["Square71x71Logo.png", 71],
  ["Square89x89Logo.png", 89],
  ["Square107x107Logo.png", 107],
  ["Square142x142Logo.png", 142],
  ["Square150x150Logo.png", 150],
  ["Square284x284Logo.png", 284],
  ["Square310x310Logo.png", 310],
];
for (const [name, size] of DESKTOP_PNGS) writeFileSync(join(DESKTOP, name), encodePng(resize(tile, size)));
writeFileSync(join(DESKTOP, "icon.ico"), encodeIco(tile));
writeFileSync(join(DESKTOP, "icon.icns"), encodeIcns(tile));

console.log(`derived 4 web + ${DESKTOP_PNGS.length + 2} desktop Wollipog icons (tile ${tile.w}px) from ${SRC}`);
