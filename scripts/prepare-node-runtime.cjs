const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const manifest = require("./node-runtime-release.json");

const target = process.argv[2];
if (target !== "windows-x64") throw new Error(`Unsupported Node runtime target: ${target || "(missing)"}`);
if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error(`Target ${target} must be prepared on win32/x64, current host is ${process.platform}/${process.arch}`);
}

const asset = manifest.assets[target];
if (!asset?.file || !asset?.executable || !/^[a-f0-9]{64}$/.test(String(asset.sha256 || "")) || !/^[a-f0-9]{64}$/.test(String(asset.nodeSha256 || ""))) {
  throw new Error(`Incomplete Node runtime asset metadata for ${target}`);
}

const root = path.resolve(__dirname, "..");
const work = path.join(root, "build", ".node-runtime-download");
const output = path.join(root, "build", "node-runtime");
const archive = path.join(work, asset.file);
const extracted = path.join(work, "extracted");

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

async function main() {
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const url = `${manifest.baseUrl}/${asset.file}`;
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`);
  fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()));

  const archiveDigest = sha256(archive);
  if (archiveDigest !== asset.sha256) {
    throw new Error(`SHA-256 mismatch for ${asset.file}: expected ${asset.sha256}, got ${archiveDigest}`);
  }

  fs.mkdirSync(extracted, { recursive: true });
  run("tar.exe", ["-xf", archive, "-C", extracted]);
  const nodeExe = findFile(extracted, asset.executable);
  if (!nodeExe) throw new Error(`Archive does not contain ${asset.executable}: ${asset.file}`);
  const nodeDigest = sha256(nodeExe);
  if (nodeDigest !== asset.nodeSha256) {
    throw new Error(`SHA-256 mismatch for ${asset.executable}: expected ${asset.nodeSha256}, got ${nodeDigest}`);
  }

  const version = run(nodeExe, ["--version"], { capture: true }).trim();
  if (version !== `v${manifest.version}`) throw new Error(`Bundled Node version mismatch: expected v${manifest.version}, got ${version}`);
  const license = findFile(extracted, "LICENSE");
  if (!license) throw new Error("Node release archive does not contain LICENSE");

  fs.mkdirSync(output, { recursive: true });
  fs.copyFileSync(nodeExe, path.join(output, "node.exe"));
  fs.copyFileSync(license, path.join(output, "LICENSE"));
  fs.writeFileSync(path.join(output, "BUNDLED_SOURCE.json"), `${JSON.stringify({
    project: manifest.project,
    version: manifest.version,
    source: manifest.source,
    target,
    file: asset.file,
    sha256: asset.sha256,
    nodeSha256: asset.nodeSha256,
    license: manifest.license,
  }, null, 2)}\n`);
  console.log(`Prepared Node.js v${manifest.version} for ${target}`);
}

main().finally(() => {
  fs.rmSync(work, { recursive: true, force: true });
}).catch((error) => {
  fs.rmSync(output, { recursive: true, force: true });
  console.error(error.stack || error.message);
  process.exit(1);
});
