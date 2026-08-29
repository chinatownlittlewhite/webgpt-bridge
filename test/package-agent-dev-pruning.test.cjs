const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createBuilderConfig } = require("../build/electron-builder-options.cjs");
const agentLock = require("../agent-runtime/package-lock.json");

function devOnlyAgentPackagePaths() {
  return Object.entries(agentLock.packages || {})
    .filter(([packagePath, metadata]) => packagePath.startsWith("node_modules/") && metadata?.dev === true)
    .map(([packagePath]) => packagePath)
    .sort();
}

test("desktop packaging excludes every lockfile-marked Agent dev-only dependency", () => {
  const config = createBuilderConfig({});
  const expectedExcludes = devOnlyAgentPackagePaths()
    .map((packagePath) => `!agent-runtime/${packagePath}/**/*`);

  assert.ok(expectedExcludes.length > 0, "fixture lockfile must contain dev-only Agent dependencies");
  for (const pattern of expectedExcludes) {
    assert.ok(config.files.includes(pattern), `missing production-package exclusion: ${pattern}`);
  }

  assert.equal(config.files.includes("!agent-runtime/node_modules/@modelcontextprotocol/server/**/*"), false);
  assert.equal(config.files.includes("!agent-runtime/node_modules/@modelcontextprotocol/core/**/*"), false);
  assert.equal(config.files.includes("!agent-runtime/node_modules/@modelcontextprotocol/node/**/*"), false);
  assert.equal(config.files.includes("!agent-runtime/node_modules/node-pty/**/*"), false);
});

test("production Agent packaging excludes package-manager bin shims", () => {
  const config = createBuilderConfig({});
  assert.ok(config.files.includes("!agent-runtime/node_modules/.bin/**/*"));
});

test("Agent dev-package exclusions are deterministic and remain narrower than node_modules", () => {
  const config = createBuilderConfig({});
  const excludes = config.files.filter((entry) => entry.startsWith("!agent-runtime/node_modules/") && entry !== "!agent-runtime/node_modules/.bin/**/*");
  assert.deepEqual(excludes, [...excludes].sort());
  assert.equal(excludes.includes("!agent-runtime/node_modules/**/*"), false);
  assert.equal(excludes.some((entry) => entry.includes("../")), false);
  assert.equal(path.isAbsolute(excludes[0] || ""), false);
});
