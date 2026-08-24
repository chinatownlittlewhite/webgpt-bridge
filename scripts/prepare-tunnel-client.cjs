const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const manifest = require("./tunnel-client-release.json");

const target = process.argv[2];
const asset = manifest.assets[target];
if (!asset) throw new Error(`Unsupported tunnel-client target: ${target || "(missing)"}`);

const expectedHost = target === "darwin-arm64" ? ["darwin", "arm64"] : ["win32", "x64"];
if (process.platform !== expectedHost[0] || process.arch !== expectedHost[1]) {
  throw new Error(`Target ${target} must be prepared on ${expectedHost[0]}/${expectedHost[1]}, current host is ${process.platform}/${process.arch}`);
}

const root = path.resolve(__dirname, "..");
const work = path.join(root, "build", ".tunnel-client-download");
const archive = path.join(work, asset.file);
const extracted = path.join(work, "extracted");
const output = path.join(root, "build", "tunnel-client");
const url = `${manifest.baseUrl}/${asset.file}`;

async function download() {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`);
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: false, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}

function extract() {
  fs.rmSync(extracted, { recursive: true, force: true });
  fs.mkdirSync(extracted, { recursive: true });
  if (process.platform === "darwin") run("/usr/bin/ditto", ["-x", "-k", archive, extracted]);
  else run("tar.exe", ["-xf", archive, "-C", extracted]);
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

function normalizeBundle() {
  const binary = findFile(extracted, asset.executable);
  if (!binary) throw new Error(`Archive does not contain ${asset.executable}`);
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  fs.cpSync(path.dirname(binary), output, { recursive: true, force: true });

  for (const candidate of ["LICENSE", "LICENSE.txt", "NOTICE", "NOTICE.txt"]) {
    const source = findFile(extracted, candidate);
    if (source && !fs.existsSync(path.join(output, path.basename(source)))) {
      fs.copyFileSync(source, path.join(output, path.basename(source)));
    }
  }

  const bundled = path.join(output, asset.executable);
  if (!fs.existsSync(bundled)) throw new Error(`Normalized bundle is missing ${asset.executable}`);
  if (process.platform !== "win32") {
    fs.chmodSync(bundled, 0o755);
    const cloudflared = findFile(output, "cloudflared");
    if (cloudflared) fs.chmodSync(cloudflared, 0o755);
  }
  fs.writeFileSync(path.join(output, "BUNDLED_SOURCE.json"), `${JSON.stringify({
    project: "openai/tunnel-client",
    version: manifest.version,
    source: manifest.source,
    asset: asset.file,
    sha256: asset.sha256,
    license: manifest.license,
  }, null, 2)}\n`);
}

(async () => {
  fs.rmSync(work, { recursive: true, force: true });
  await download();
  const actual = sha256(archive);
  if (actual !== asset.sha256) throw new Error(`SHA-256 mismatch for ${asset.file}: expected ${asset.sha256}, got ${actual}`);
  extract();
  normalizeBundle();
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`Prepared OpenAI tunnel-client v${manifest.version} for ${target}`);
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
