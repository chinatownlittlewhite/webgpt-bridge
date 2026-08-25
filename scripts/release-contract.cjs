const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");

function verifyTagVersion({ tag, version }) {
  const expected = `v${String(version || "")}`;
  if (!version || tag !== expected) {
    throw new Error(`tag/version mismatch: expected ${expected}, got ${String(tag || "")}`);
  }
  return { tag, version };
}

function readUpdateManifest(file) {
  const value = yaml.load(fs.readFileSync(file, "utf8"), { schema: yaml.JSON_SCHEMA });
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("manifest root must be an object");
  }
  return value;
}

function safeAssetName(value) {
  const raw = String(value || "");
  let name;
  try {
    name = decodeURIComponent(raw);
  } catch {
    throw new Error(`unsafe asset name: ${raw}`);
  }
  if (!name || path.basename(name) !== name || name.includes("..") || /[\\/\0]/.test(name)) {
    throw new Error(`unsafe asset name: ${raw}`);
  }
  return name;
}

function sha512Base64(file) {
  return crypto.createHash("sha512").update(fs.readFileSync(file)).digest("base64");
}

function sha256Hex(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function validateManifest({ manifest, version, assetDir }) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("manifest root must be an object");
  }
  if (String(manifest.version || "") !== String(version || "")) {
    throw new Error(`manifest version mismatch: expected ${version}, got ${String(manifest.version || "")}`);
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error("manifest files must be non-empty");
  }
  const seen = new Set();
  const entries = manifest.files.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("manifest file entry must be an object");
    const name = safeAssetName(entry.url);
    const key = name.toLowerCase();
    if (seen.has(key)) throw new Error(`duplicate asset reference: ${name}`);
    seen.add(key);
    return { entry, name };
  });
  const validated = [];
  for (const { entry, name } of entries) {
    const expectedHash = String(entry.sha512 || "");
    if (!expectedHash) throw new Error(`missing sha512 for ${name}`);
    const file = path.join(assetDir, name);
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error(`referenced asset missing: ${name}`);
    const actualHash = sha512Base64(file);
    if (actualHash !== expectedHash) throw new Error(`sha512 mismatch for ${name}`);
    validated.push(name);
  }
  return validated;
}

module.exports = {
  verifyTagVersion,
  readUpdateManifest,
  validateManifest,
  safeAssetName,
  sha512Base64,
  sha256Hex,
};
