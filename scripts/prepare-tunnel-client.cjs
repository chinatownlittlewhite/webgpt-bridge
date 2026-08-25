const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const manifest = require("./tunnel-client-release.json");

const target = process.argv[2];
const supportedTargets = new Set(["darwin-universal", "darwin-arm64", "windows-amd64"]);
if (!supportedTargets.has(target)) throw new Error(`Unsupported tunnel-client target: ${target || "(missing)"}`);

if (target === "darwin-universal" && process.platform !== "darwin") {
  throw new Error(`Target ${target} must be prepared on darwin, current host is ${process.platform}/${process.arch}`);
}
if (target === "darwin-arm64" && (process.platform !== "darwin" || process.arch !== "arm64")) {
  throw new Error(`Target ${target} must be prepared on darwin/arm64, current host is ${process.platform}/${process.arch}`);
}
if (target === "windows-amd64" && (process.platform !== "win32" || process.arch !== "x64")) {
  throw new Error(`Target ${target} must be prepared on win32/x64, current host is ${process.platform}/${process.arch}`);
}

const root = path.resolve(__dirname, "..");
const work = path.join(root, "build", ".tunnel-client-download");
const output = path.join(root, "build", "tunnel-client");

function releaseUrl(file) {
  return `${manifest.baseUrl}/${file}`;
}

async function fetchBytes(file) {
  const response = await fetch(releaseUrl(file), { redirect: "follow" });
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${releaseUrl(file)}`);
  return Buffer.from(await response.arrayBuffer());
}

async function downloadTo(file, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, await fetchBytes(file));
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function run(command, args, { capture = false } = {}) {
  const result = spawnSync(command, args, capture
    ? { encoding: "utf8", shell: false, windowsHide: true }
    : { stdio: "inherit", shell: false, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
  return capture ? String(result.stdout || "") : "";
}

function extractArchive(archive, destination) {
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  if (process.platform === "darwin") run("/usr/bin/ditto", ["-x", "-k", archive, destination]);
  else run("tar.exe", ["-xf", archive, "-C", destination]);
}

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = findFile(full, name);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) {
      return full;
    }
  }
  return "";
}

async function stageArchive(asset, expectedSha256, label) {
  if (!asset?.file || !asset?.executable || !/^[a-f0-9]{64}$/.test(String(expectedSha256 || ""))) {
    throw new Error(`Incomplete tunnel-client asset metadata for ${label}`);
  }
  const stage = path.join(work, label);
  const archive = path.join(stage, asset.file);
  const extracted = path.join(stage, "extracted");
  await downloadTo(asset.file, archive);
  const actual = sha256(archive);
  if (actual !== expectedSha256) {
    throw new Error(`SHA-256 mismatch for ${asset.file}: expected ${expectedSha256}, got ${actual}`);
  }
  extractArchive(archive, extracted);
  const binary = findFile(extracted, asset.executable);
  if (!binary) throw new Error(`Archive does not contain ${asset.executable}: ${asset.file}`);
  const cloudflared = findFile(extracted, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
  return { asset, expectedSha256, extracted, binary, cloudflared };
}

function copyBundleFrom(staged) {
  const bundleDir = path.dirname(staged.binary);
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  fs.cpSync(bundleDir, output, { recursive: true, force: true });

  for (const candidate of ["LICENSE", "LICENSE.txt", "NOTICE", "NOTICE.txt"]) {
    const source = findFile(staged.extracted, candidate);
    if (source && !fs.existsSync(path.join(output, path.basename(source)))) {
      fs.copyFileSync(source, path.join(output, path.basename(source)));
    }
  }
}

function makeUniversal(outputName, arm64File, amd64File) {
  if (!arm64File || !amd64File) throw new Error(`Universal bundle is missing one architecture for ${outputName}`);
  const destination = path.join(output, outputName);
  const temporary = `${destination}.universal`;
  run("/usr/bin/lipo", ["-create", arm64File, amd64File, "-output", temporary]);
  const arches = run("/usr/bin/lipo", ["-archs", temporary], { capture: true }).trim().split(/\s+/);
  if (!arches.includes("arm64") || !arches.includes("x86_64")) {
    fs.rmSync(temporary, { force: true });
    throw new Error(`Universal ${outputName} is missing required architectures: ${arches.join(" ")}`);
  }
  fs.renameSync(temporary, destination);
  fs.chmodSync(destination, 0o755);
}

function writeProvenance(bundleTarget, assets) {
  fs.writeFileSync(path.join(output, "BUNDLED_SOURCE.json"), `${JSON.stringify({
    project: "openai/tunnel-client",
    version: manifest.version,
    source: manifest.source,
    bundleTarget,
    assets: assets.map(({ target: sourceTarget, file, sha256: digest }) => ({ target: sourceTarget, file, sha256: digest })),
    license: manifest.license,
  }, null, 2)}\n`);
}

async function prepareUniversalDarwin() {
  const armAsset = manifest.assets["darwin-arm64"];
  const amdAsset = manifest.assets["darwin-amd64"];
  if (!armAsset?.sha256 || !amdAsset?.sha256) throw new Error("Both macOS release archives must have pinned SHA-256 values");
  const arm = await stageArchive(armAsset, armAsset.sha256, "darwin-arm64");
  const amd = await stageArchive(amdAsset, amdAsset.sha256, "darwin-amd64");

  if (!arm.cloudflared || !amd.cloudflared) {
    throw new Error("Supported macOS release archives must both contain the bundled cloudflared companion");
  }
  if (path.dirname(arm.binary) !== path.dirname(arm.cloudflared) || path.dirname(amd.binary) !== path.dirname(amd.cloudflared)) {
    throw new Error("tunnel-client and cloudflared must be adjacent inside both macOS release archives");
  }

  copyBundleFrom(arm);
  makeUniversal("tunnel-client", arm.binary, amd.binary);
  makeUniversal("cloudflared", arm.cloudflared, amd.cloudflared);
  writeProvenance("darwin-universal", [
    { target: "darwin-arm64", file: armAsset.file, sha256: armAsset.sha256 },
    { target: "darwin-amd64", file: amdAsset.file, sha256: amdAsset.sha256 },
  ]);
}

async function preparePinnedSingle(singleTarget) {
  const asset = manifest.assets[singleTarget];
  if (!asset?.sha256) throw new Error(`Target ${singleTarget} has no pinned SHA-256 and cannot be prepared directly`);
  const staged = await stageArchive(asset, asset.sha256, singleTarget);
  copyBundleFrom(staged);
  const bundled = path.join(output, asset.executable);
  if (!fs.existsSync(bundled)) throw new Error(`Normalized bundle is missing ${asset.executable}`);
  if (process.platform !== "win32") {
    fs.chmodSync(bundled, 0o755);
    const cloudflared = findFile(output, "cloudflared");
    if (cloudflared) fs.chmodSync(cloudflared, 0o755);
  }
  writeProvenance(singleTarget, [{ target: singleTarget, file: asset.file, sha256: asset.sha256 }]);
}

(async () => {
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(output, { recursive: true, force: true });
  try {
    if (target === "darwin-universal") await prepareUniversalDarwin();
    else await preparePinnedSingle(target);
    console.log(`Prepared OpenAI tunnel-client v${manifest.version} for ${target}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
})().catch((error) => {
  fs.rmSync(output, { recursive: true, force: true });
  console.error(error.stack || error.message);
  process.exit(1);
});
