const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const helperPath = path.join(root, "src", "tray-icon.cjs");

function pngSize(dataUrl) {
  assert.match(dataUrl, /^data:image\/png;base64,/);
  const raw = Buffer.from(dataUrl.split(",", 2)[1], "base64");
  assert.equal(raw.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  return { width: raw.readUInt32BE(16), height: raw.readUInt32BE(20) };
}

test("Windows tray uses a real PNG raster instead of an unsupported SVG NativeImage", () => {
  assert.equal(fs.existsSync(helperPath), true, "tray icon helper must exist");
  const { trayIconDataUrl } = require(helperPath);
  const windows = trayIconDataUrl("win32");
  const size = pngSize(windows);
  assert.ok(size.width >= 32 && size.height >= 32, `Windows tray PNG must be at least 32x32, got ${size.width}x${size.height}`);
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
  assert.match(main, /process\.platform === "darwin"[\s\S]*setTemplateImage\(true\)/);
  const trayStart = main.indexOf("function trayIcon()");
  const trayEnd = main.indexOf("\nfunction dockIcon()", trayStart);
  assert.ok(trayStart >= 0 && trayEnd > trayStart);
  const traySource = main.slice(trayStart, trayEnd);
  assert.doesNotMatch(traySource, /image\/svg\+xml/);
});
