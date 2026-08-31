const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const preload = fs.readFileSync(path.join(root, "src", "preload.cjs"), "utf8");
const renderer = fs.readFileSync(path.join(root, "src", "renderer", "renderer.js"), "utf8");

test("preload exposes one bounded capabilities call rather than subprocess primitives", () => {
  assert.match(preload, /capabilities\s*:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(["']host:capabilities["']\)/);
  assert.doesNotMatch(preload, /spawn|execFile|child_process/);
});

test("renderer consumes stable diagnostic codes and never renders raw stderr fields", () => {
  for (const code of ["CLI_UNAVAILABLE", "NOT_AUTHENTICATED", "UPSTREAM_ERROR", "HEALTH_DEGRADED"]) {
    assert.match(renderer, new RegExp(code));
  }
  assert.doesNotMatch(renderer, /\.stderr\b|\.raw\b|\.token\b/);
  assert.match(renderer, /api\.capabilities\(\)/);
});
