const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createBuilderConfig } = require("../build/electron-builder-options.cjs");

test("packaged Agent receives the generated canonical registry at its sandbox-local runtime path", () => {
  const root = path.join(__dirname, "..");
  const config = createBuilderConfig({});
  assert.ok(config.extraResources.some((entry) => (
    entry.from === "agent-runtime/shared"
      && entry.to === "app.asar.unpacked/agent-runtime/shared"
  )));
  const sync = fs.readFileSync(path.join(root, "agent-runtime", "scripts", "sync-canonical-registry.mjs"), "utf8");
  assert.match(sync, /shared["'],\s*["']tool-registry\.cjs/);
  assert.match(sync, /projected\.equals\(bytes\)/);
});
