const fs = require("node:fs");
const path = require("node:path");
const { readUpdateManifest, validateManifest } = require("./release-contract.cjs");

const MAC_VARIANTS = Object.freeze(["arm64", "x64", "universal"]);

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || "" : "";
}

function requireFile(dir, name) {
  const file = path.join(dir, name);
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error(`required release asset missing: ${name}`);
  return file;
}

function basenames(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name);
}

function macDistributables(version) {
  return MAC_VARIANTS.flatMap((variant) => [
    `WebGPT-Bridge-${version}-mac-${variant}.dmg`,
    `WebGPT-Bridge-${version}-mac-${variant}.zip`,
  ]);
}

function assertOnlyExpectedFiles(dir, expectedNames, label) {
  const expected = new Set(expectedNames.map((name) => name.toLowerCase()));
  for (const name of basenames(dir)) {
    if (name === "SHA256SUMS") continue;
    if (!expected.has(name.toLowerCase())) throw new Error(`unexpected ${label} release asset: ${name}`);
  }
}

function validateReleaseAssets({ version, windowsDir, macDir }) {
  if (!version || !windowsDir || !macDir) throw new Error("--version, --windows, and --mac are required");
  const winInstaller = `WebGPT-Bridge-${version}-win-x64.exe`;
  const winBlockmap = `${winInstaller}.blockmap`;
  requireFile(windowsDir, winInstaller);
  requireFile(windowsDir, winBlockmap);

  const macArtifacts = macDistributables(version);
  for (const name of macArtifacts) {
    requireFile(macDir, name);
    requireFile(macDir, `${name}.blockmap`);
  }
  const macDmg = `WebGPT-Bridge-${version}-mac-universal.dmg`;
  const macZip = `WebGPT-Bridge-${version}-mac-universal.zip`;

  const latestWin = requireFile(windowsDir, "latest.yml");
  const latestMac = requireFile(macDir, "latest-mac.yml");
  const winReferences = validateManifest({ manifest: readUpdateManifest(latestWin), version, assetDir: windowsDir });
  const macReferences = validateManifest({ manifest: readUpdateManifest(latestMac), version, assetDir: macDir });
  if (!winReferences.includes(winInstaller)) throw new Error(`latest.yml does not reference exact installer: ${winInstaller}`);
  if (!macReferences.includes(macZip)) throw new Error(`latest-mac.yml does not reference exact updater ZIP: ${macZip}`);
  for (const reference of macReferences) {
    if (reference !== macZip && reference !== `${macZip}.blockmap`) {
      throw new Error(`latest-mac.yml must remain Universal-only: ${reference}`);
    }
  }

  assertOnlyExpectedFiles(windowsDir, [winInstaller, winBlockmap, "latest.yml"], "Windows");
  assertOnlyExpectedFiles(
    macDir,
    [
      ...macArtifacts,
      ...macArtifacts.map((name) => `${name}.blockmap`),
      "latest-mac.yml",
    ],
    "macOS",
  );

  const winNames = new Set(basenames(windowsDir).map((name) => name.toLowerCase()));
  for (const name of basenames(macDir)) {
    if (name === "SHA256SUMS") continue;
    if (winNames.has(name.toLowerCase())) throw new Error(`duplicate basename across platform release assets: ${name}`);
  }
  return { winInstaller, macDmg, macZip, macArtifacts, winReferences, macReferences };
}

if (require.main === module) {
  const result = validateReleaseAssets({
    version: argument("--version"),
    windowsDir: argument("--windows"),
    macDir: argument("--mac"),
  });
  console.log(JSON.stringify({ ok: true, ...result }));
}

module.exports = { MAC_VARIANTS, macDistributables, validateReleaseAssets };
