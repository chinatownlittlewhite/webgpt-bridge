const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("desktop broker wires known-folder and fixed health methods and clears helper state on stop", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.cjs"), "utf8");
  assert.match(main, /createKnownFolderAccess/);
  assert.match(main, /createLoopbackHealthProbe/);
  assert.match(main, /local_list_known_folder/);
  assert.match(main, /local_read_known_folder/);
  assert.match(main, /local_probe_health/);
  assert.match(main, /localKnownFolderAccess\s*=\s*undefined/);
  assert.match(main, /localHealthProbe\s*=\s*undefined/);
});
