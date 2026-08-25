const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const yaml = require("js-yaml");

const {
  verifyTagVersion,
  readUpdateManifest,
  validateManifest,
  sha512Base64,
  sha256Hex,
} = require("../scripts/release-contract.cjs");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "webgpt-release-contract-"));
}

test("release tag must exactly equal v + root version", () => {
  assert.doesNotThrow(() => verifyTagVersion({ tag: "v0.3.5", version: "0.3.5" }));
  assert.throws(() => verifyTagVersion({ tag: "v0.3.6", version: "0.3.5" }), /tag\/version mismatch/);
  assert.throws(() => verifyTagVersion({ tag: "0.3.5", version: "0.3.5" }), /tag\/version mismatch/);
});

test("root package and lockfile versions stay aligned for release tags", () => {
  const root = path.join(__dirname, "..");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages?.[""]?.version, pkg.version);
});

test("manifest validation requires same version existing assets and matching sha512", () => {
  const dir = tempDir();
  const asset = path.join(dir, "WebGPT Bridge-0.3.5-win-x64.exe");
  fs.writeFileSync(asset, "signed-installer-bytes");
  const manifestFile = path.join(dir, "latest.yml");
  fs.writeFileSync(manifestFile, yaml.dump({
    version: "0.3.5",
    files: [{ url: path.basename(asset), sha512: sha512Base64(asset), size: fs.statSync(asset).size }],
    path: path.basename(asset),
    sha512: sha512Base64(asset),
  }));

  const manifest = readUpdateManifest(manifestFile);
  assert.doesNotThrow(() => validateManifest({ manifest, version: "0.3.5", assetDir: dir }));
  assert.equal(sha256Hex(asset).length, 64);

  fs.appendFileSync(asset, "tamper");
  assert.throws(() => validateManifest({ manifest, version: "0.3.5", assetDir: dir }), /sha512 mismatch/);
});

test("manifest cannot reference an asset outside its release directory", () => {
  const dir = tempDir();
  assert.throws(() => validateManifest({
    manifest: { version: "0.3.5", files: [{ url: "../evil.exe", sha512: "x" }] },
    version: "0.3.5",
    assetDir: dir,
  }), /unsafe asset name/);
  assert.throws(() => validateManifest({
    manifest: { version: "0.3.5", files: [{ url: "%2e%2e%2fevil.exe", sha512: "x" }] },
    version: "0.3.5",
    assetDir: dir,
  }), /unsafe asset name/);
});

test("manifest validation rejects missing files duplicate references and version mismatch", () => {
  const dir = tempDir();
  assert.throws(() => validateManifest({ manifest: { version: "0.3.6", files: [{ url: "x.exe", sha512: "x" }] }, version: "0.3.5", assetDir: dir }), /manifest version mismatch/);
  assert.throws(() => validateManifest({ manifest: { version: "0.3.5", files: [] }, version: "0.3.5", assetDir: dir }), /files must be non-empty/);
  assert.throws(() => validateManifest({ manifest: { version: "0.3.5", files: [{ url: "x.exe", sha512: "x" }, { url: "x.exe", sha512: "x" }] }, version: "0.3.5", assetDir: dir }), /duplicate asset reference/);
});

test("update manifest parser accepts only a mapping document", () => {
  const dir = tempDir();
  const good = path.join(dir, "latest.yml");
  fs.writeFileSync(good, "version: 0.3.5\nfiles:\n  - url: app.zip\n    sha512: abc\n");
  assert.equal(readUpdateManifest(good).version, "0.3.5");
  const bad = path.join(dir, "bad.yml");
  fs.writeFileSync(bad, "- not\n- a\n- mapping\n");
  assert.throws(() => readUpdateManifest(bad), /manifest root must be an object/);
});

test("release asset CLI requires exact Windows and Universal macOS asset set", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "scripts", "validate-release-assets.cjs"), "utf8");
  assert.match(source, /WebGPT Bridge-\$\{version\}-win-x64\.exe/);
  assert.match(source, /WebGPT Bridge-\$\{version\}-mac-universal\.dmg/);
  assert.match(source, /WebGPT Bridge-\$\{version\}-mac-universal\.zip/);
  assert.match(source, /latest\.yml/);
  assert.match(source, /latest-mac\.yml/);
  assert.match(source, /duplicate basename/);
});

test("checksum writer includes only user-facing exe dmg and zip files", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "scripts", "write-release-checksums.cjs"), "utf8");
  assert.match(source, /\.exe/);
  assert.match(source, /\.dmg/);
  assert.match(source, /\.zip/);
  assert.doesNotMatch(source, /\.p8/);
  assert.match(source, /sha256Hex/);
});
