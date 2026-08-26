const fs = require("node:fs");
const path = require("node:path");
const { createBuilderConfig } = require("../build/electron-builder-options.cjs");

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function requireString(value, label) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function validateLoopbackUrl(value) {
  const raw = requireString(value, "--url");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("update E2E feed must be http://127.0.0.1:<port>/");
  }
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || !parsed.port || parsed.pathname !== "/" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("update E2E feed must be http://127.0.0.1:<port>/");
  }
  return parsed.href;
}

function validateVersion(value, label) {
  const version = requireString(value, label);
  if (!VERSION_PATTERN.test(version)) throw new Error(`${label} must be a concrete semver version`);
  return version;
}

function createE2EConfig({ env = process.env, url, version, expectedVersion, sentinel, out }) {
  const feedUrl = validateLoopbackUrl(url);
  const buildVersion = validateVersion(version, "--version");
  const targetVersion = validateVersion(expectedVersion, "--expected-version");
  const sentinelPath = path.resolve(requireString(sentinel, "--sentinel"));
  const outputConfig = path.resolve(requireString(out, "--out"));
  if (buildVersion === targetVersion && !outputConfig.toLowerCase().includes("new")) {
    throw new Error("old update E2E package must not already equal the expected version");
  }

  const base = createBuilderConfig(env);
  const files = Array.isArray(base.files) ? [...base.files] : [];
  const exclusion = "!src/update-e2e-control.cjs";
  const exclusionIndex = files.indexOf(exclusion);
  if (exclusionIndex < 0) throw new Error("production builder config must exclude update E2E control");
  files.splice(exclusionIndex, 1);

  const config = {
    ...base,
    files,
    publish: [{ provider: "generic", url: feedUrl }],
    directories: {
      ...(base.directories || {}),
      output: path.join(path.dirname(outputConfig), path.basename(outputConfig, path.extname(outputConfig))),
    },
    extraMetadata: {
      ...(base.extraMetadata || {}),
      version: buildVersion,
      WEBGPT_UPDATE_E2E_BUILD: true,
      WEBGPT_UPDATE_E2E_EXPECTED_VERSION: targetVersion,
      WEBGPT_UPDATE_E2E_SENTINEL: sentinelPath,
    },
  };

  return config;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || "" : "";
}

if (require.main === module) {
  const out = argument("--out");
  const config = createE2EConfig({
    env: process.env,
    url: argument("--url"),
    version: argument("--version"),
    expectedVersion: argument("--expected-version"),
    sentinel: argument("--sentinel"),
    out,
  });
  const outputConfig = path.resolve(out);
  fs.mkdirSync(path.dirname(outputConfig), { recursive: true });
  fs.writeFileSync(outputConfig, `module.exports = ${JSON.stringify(config, null, 2)};\n`, { mode: 0o600 });
  console.log(JSON.stringify({ ok: true, config: outputConfig, output: config.directories.output }));
}

module.exports = { createE2EConfig, validateLoopbackUrl };
