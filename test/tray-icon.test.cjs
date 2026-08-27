const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const root = path.join(__dirname, "..");
const helperPath = path.join(root, "src", "tray-icon.cjs");

function pngBuffer(dataUrl) {
  assert.match(dataUrl, /^data:image\/png;base64,/);
  const raw = Buffer.from(dataUrl.split(",", 2)[1], "base64");
  assert.equal(raw.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  return raw;
}

function pngSize(dataUrl) {
  const raw = pngBuffer(dataUrl);
  return { width: raw.readUInt32BE(16), height: raw.readUInt32BE(20) };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function decodeRgbaPng(dataUrl) {
  const raw = pngBuffer(dataUrl);
  const width = raw.readUInt32BE(16);
  const height = raw.readUInt32BE(20);
  assert.equal(raw[24], 8, "tray PNG must use 8-bit channels");
  assert.equal(raw[25], 6, "tray PNG must use RGBA color");
  assert.equal(raw[28], 0, "tray PNG must be non-interlaced");
  const idat = [];
  for (let offset = 8; offset < raw.length;) {
    const length = raw.readUInt32BE(offset);
    const type = raw.subarray(offset + 4, offset + 8).toString("ascii");
    if (type === "IDAT") idat.push(raw.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const inflated = zlib.inflateSync(Buffer.concat(idat));
  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const pixels = Buffer.alloc(stride * height);
  let inputOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[inputOffset++];
    for (let x = 0; x < stride; x += 1) {
      const encoded = inflated[inputOffset++];
      const left = x >= bytesPerPixel ? pixels[y * stride + x - bytesPerPixel] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= bytesPerPixel ? pixels[(y - 1) * stride + x - bytesPerPixel] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = Math.floor((left + up) / 2);
      else if (filter === 4) predictor = paeth(left, up, upLeft);
      else assert.equal(filter, 0, `unsupported PNG filter ${filter}`);
      pixels[y * stride + x] = (encoded + predictor) & 0xff;
    }
  }
  return { width, height, pixels };
}

test("Windows tray uses a real PNG raster instead of an unsupported SVG NativeImage", () => {
  assert.equal(fs.existsSync(helperPath), true, "tray icon helper must exist");
  const { trayIconDataUrl } = require(helperPath);
  const windows = trayIconDataUrl("win32");
  const size = pngSize(windows);
  assert.ok(size.width >= 32 && size.height >= 32, `Windows tray PNG must be at least 32x32, got ${size.width}x${size.height}`);
});

test("Windows tray PNG has visible pixels and enough contrast to avoid a blank taskbar icon", () => {
  const { trayIconDataUrl } = require(helperPath);
  const { width, height, pixels } = decodeRgbaPng(trayIconDataUrl("win32"));
  let visible = 0;
  let minLuma = 255;
  let maxLuma = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const alpha = pixels[i + 3];
    if (alpha === 0) continue;
    visible += 1;
    const luma = 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
    minLuma = Math.min(minLuma, luma);
    maxLuma = Math.max(maxLuma, luma);
  }
  assert.ok(visible >= width * height * 0.25, `Windows tray icon is too transparent: ${visible}/${width * height} visible pixels`);
  assert.ok(maxLuma - minLuma >= 80, `Windows tray icon contrast is too low: ${maxLuma - minLuma}`);
});

test("macOS keeps a template-capable monochrome PNG while Windows uses a distinct high-contrast raster", () => {
  assert.equal(fs.existsSync(helperPath), true, "tray icon helper must exist");
  const { trayIconDataUrl } = require(helperPath);
  const mac = trayIconDataUrl("darwin");
  const windows = trayIconDataUrl("win32");
  const macSize = pngSize(mac);
  assert.ok(macSize.width >= 18 && macSize.height >= 18);
  assert.notEqual(mac, windows);
});

test("main process creates the tray from the platform PNG helper and keeps macOS template behavior", () => {
  const main = fs.readFileSync(path.join(root, "src", "main.cjs"), "utf8");
  assert.match(main, /require\("\.\/tray-icon\.cjs"\)/);
  assert.match(main, /trayIconDataUrl\(process\.platform\)/);
  assert.match(main, /image\.isEmpty\(\)/);
  assert.match(main, /process\.platform === "darwin"[\s\S]*setTemplateImage\(true\)/);
  const trayStart = main.indexOf("function trayIcon()");
  const trayEnd = main.indexOf("\nfunction dockIcon()", trayStart);
  assert.ok(trayStart >= 0 && trayEnd > trayStart);
  const traySource = main.slice(trayStart, trayEnd);
  assert.doesNotMatch(traySource, /image\/svg\+xml/);
});
