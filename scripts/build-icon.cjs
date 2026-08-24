const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const root = path.resolve(__dirname, "..");
const buildDir = path.join(root, "build");
const svgPath = path.join(buildDir, "icon.svg");
const pngPath = path.join(buildDir, "icon.png");
const icnsPath = path.join(buildDir, "icon.icns");

const SPEC = Object.freeze({
  size: 1024,
  cornerRadius: 226,
  background: { from: [180, 96], to: [850, 920], colors: [[38, 49, 46], [13, 18, 17]] },
  accent: { from: [322, 384], to: [712, 650], colors: [[207, 249, 233], [86, 214, 174]] },
  white: [243, 247, 245],
  green: [86, 214, 174],
  dark: [15, 23, 21],
  ring: [221, 248, 238],
  strokeWidth: 92,
  leftPath: [[282, 596], [282, 508], [353, 437], [441, 437], [505, 437]],
  rightPath: [[742, 428], [742, 516], [671, 587], [583, 587], [519, 587]],
  leftNode: [282, 596, 62],
  rightNode: [742, 428, 62],
  center: [512, 512],
});

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function interpolateColor(a, b, t) {
  return [0, 1, 2].map((index) => Math.round(a[index] + (b[index] - a[index]) * t));
}

function gradientColor(point, gradient, scale) {
  const from = gradient.from.map((value) => value * scale);
  const to = gradient.to.map((value) => value * scale);
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const lengthSquared = dx * dx + dy * dy || 1;
  const t = clamp(((point[0] - from[0]) * dx + (point[1] - from[1]) * dy) / lengthSquared);
  return interpolateColor(gradient.colors[0], gradient.colors[1], t);
}

function blendPixel(pixels, width, x, y, color, coverage) {
  if (x < 0 || y < 0 || x >= width || y >= width || coverage <= 0) return;
  const offset = (y * width + x) * 4;
  const sourceAlpha = clamp(coverage);
  const destinationAlpha = pixels[offset + 3] / 255;
  const outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
  if (outputAlpha <= 0) return;
  for (let channel = 0; channel < 3; channel += 1) {
    pixels[offset + channel] = Math.round((color[channel] * sourceAlpha + pixels[offset + channel] * destinationAlpha * (1 - sourceAlpha)) / outputAlpha);
  }
  pixels[offset + 3] = Math.round(outputAlpha * 255);
}

function roundedRectDistance(x, y, size, radius) {
  const half = size / 2;
  const qx = Math.abs(x - half) - (half - radius);
  const qy = Math.abs(y - half) - (half - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - radius;
}

function drawBackground(pixels, size, scale) {
  const radius = SPEC.cornerRadius * scale;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const coverage = clamp(0.5 - roundedRectDistance(x + 0.5, y + 0.5, size, radius));
      if (coverage > 0) blendPixel(pixels, size, x, y, gradientColor([x + 0.5, y + 0.5], SPEC.background, scale), coverage);
    }
  }
}

function pointSegmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const denominator = dx * dx + dy * dy;
  const t = denominator ? clamp(((px - ax) * dx + (py - ay) * dy) / denominator) : 0;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

function cubicPoint(p0, p1, p2, p3, t) {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return [
    p0[0] * a + p1[0] * b + p2[0] * c + p3[0] * d,
    p0[1] * a + p1[1] * b + p2[1] * c + p3[1] * d,
  ];
}

function buildPathSegments(points, scale) {
  const scaled = points.map(([x, y]) => [x * scale, y * scale]);
  const segments = [];
  let previous = scaled[0];
  const steps = Math.max(12, Math.round(28 * scale));
  for (let index = 1; index <= steps; index += 1) {
    const current = cubicPoint(scaled[0], scaled[1], scaled[2], scaled[3], index / steps);
    segments.push([previous, current]);
    previous = current;
  }
  segments.push([scaled[3], scaled[4]]);
  return segments;
}

function pathMask(size, segments, radius) {
  const mask = new Uint8Array(size * size);
  for (const [[ax, ay], [bx, by]] of segments) {
    const minX = Math.max(0, Math.floor(Math.min(ax, bx) - radius - 1));
    const maxX = Math.min(size - 1, Math.ceil(Math.max(ax, bx) + radius + 1));
    const minY = Math.max(0, Math.floor(Math.min(ay, by) - radius - 1));
    const maxY = Math.min(size - 1, Math.ceil(Math.max(ay, by) + radius + 1));
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const distance = pointSegmentDistance(x + 0.5, y + 0.5, ax, ay, bx, by);
        const coverage = Math.round(clamp(radius + 0.5 - distance) * 255);
        const index = y * size + x;
        if (coverage > mask[index]) mask[index] = coverage;
      }
    }
  }
  return mask;
}

function paintMask(pixels, size, mask, colorForPixel) {
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const coverage = mask[y * size + x] / 255;
      if (coverage > 0) blendPixel(pixels, size, x, y, colorForPixel(x + 0.5, y + 0.5), coverage);
    }
  }
}

function drawCircle(pixels, size, cx, cy, radius, color) {
  const minX = Math.max(0, Math.floor(cx - radius - 1));
  const maxX = Math.min(size - 1, Math.ceil(cx + radius + 1));
  const minY = Math.max(0, Math.floor(cy - radius - 1));
  const maxY = Math.min(size - 1, Math.ceil(cy + radius + 1));
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const coverage = clamp(radius + 0.5 - Math.hypot(x + 0.5 - cx, y + 0.5 - cy));
      if (coverage > 0) blendPixel(pixels, size, x, y, color, coverage);
    }
  }
}

function renderRgba(size) {
  const scale = size / SPEC.size;
  const pixels = Buffer.alloc(size * size * 4);
  drawBackground(pixels, size, scale);

  const strokeRadius = SPEC.strokeWidth * scale / 2;
  const leftMask = pathMask(size, buildPathSegments(SPEC.leftPath, scale), strokeRadius);
  paintMask(pixels, size, leftMask, () => SPEC.white);

  const rightMask = pathMask(size, buildPathSegments(SPEC.rightPath, scale), strokeRadius);
  paintMask(pixels, size, rightMask, (x, y) => gradientColor([x, y], SPEC.accent, scale));

  drawCircle(pixels, size, SPEC.leftNode[0] * scale, SPEC.leftNode[1] * scale, SPEC.leftNode[2] * scale, SPEC.white);
  drawCircle(pixels, size, SPEC.rightNode[0] * scale, SPEC.rightNode[1] * scale, SPEC.rightNode[2] * scale, SPEC.green);

  const [centerX, centerY] = SPEC.center.map((value) => value * scale);
  drawCircle(pixels, size, centerX, centerY, 47 * scale, SPEC.ring);
  drawCircle(pixels, size, centerX, centerY, 29 * scale, SPEC.dark);
  return pixels;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  typeBuffer.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return output;
}

function renderPng(size) {
  const pixels = renderRgba(size);
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const rawOffset = y * (stride + 1);
    raw[rawOffset] = 0;
    pixels.copy(raw, rawOffset + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function icnsChunk(type, data) {
  const chunk = Buffer.alloc(8 + data.length);
  chunk.write(type, 0, 4, "ascii");
  chunk.writeUInt32BE(chunk.length, 4);
  data.copy(chunk, 8);
  return chunk;
}

function buildIcns() {
  const entries = [
    ["icp4", 16], ["icp5", 32], ["icp6", 64],
    ["ic07", 128], ["ic08", 256], ["ic09", 512], ["ic10", 1024],
    ["ic11", 32], ["ic12", 64], ["ic13", 256], ["ic14", 512],
  ];
  const pngCache = new Map();
  const pngFor = (size) => {
    if (!pngCache.has(size)) pngCache.set(size, renderPng(size));
    return pngCache.get(size);
  };
  const chunks = entries.map(([type, size]) => icnsChunk(type, pngFor(size)));
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(8);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(header.length + body.length, 4);
  return { buffer: Buffer.concat([header, body]), png1024: pngFor(1024) };
}

function renderSvg() {
  return `<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="180" y1="96" x2="850" y2="920" gradientUnits="userSpaceOnUse"><stop stop-color="#26312E"/><stop offset="1" stop-color="#0D1211"/></linearGradient>
    <linearGradient id="accent" x1="322" y1="384" x2="712" y2="650" gradientUnits="userSpaceOnUse"><stop stop-color="#CFF9E9"/><stop offset="1" stop-color="#56D6AE"/></linearGradient>
  </defs>
  <rect width="1024" height="1024" rx="226" fill="url(#bg)"/>
  <path d="M282 596c0-88 71-159 159-159h64" fill="none" stroke="#F3F7F5" stroke-width="92" stroke-linecap="round"/>
  <path d="M742 428c0 88-71 159-159 159h-64" fill="none" stroke="url(#accent)" stroke-width="92" stroke-linecap="round"/>
  <circle id="bridge-node-left" cx="282" cy="596" r="62" fill="#F3F7F5"/>
  <circle id="bridge-node-right" cx="742" cy="428" r="62" fill="#56D6AE"/>
  <circle cx="512" cy="512" r="38" fill="#0F1715" stroke="#DDF8EE" stroke-width="18"/>
</svg>\n`;
}

fs.mkdirSync(buildDir, { recursive: true });
const built = buildIcns();
fs.writeFileSync(svgPath, renderSvg());
fs.writeFileSync(pngPath, built.png1024);
fs.writeFileSync(icnsPath, built.buffer);
console.log(`Built ${path.relative(root, icnsPath)} and ${path.relative(root, pngPath)}`);
