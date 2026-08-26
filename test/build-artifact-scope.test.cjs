const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const workflow = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "build-desktop.yml"), "utf8");

test("PR desktop artifacts contain distributable release assets without unpacked app trees", () => {
  assert.doesNotMatch(workflow, /path:\s*release\/\*/);
  assert.match(workflow, /release\/WebGPT Bridge-\*-win-x64\.exe/);
  assert.match(workflow, /release\/latest\.yml/);
  assert.match(workflow, /release\/WebGPT Bridge-\*-mac-universal\.dmg/);
  assert.match(workflow, /release\/WebGPT Bridge-\*-mac-universal\.zip/);
  assert.match(workflow, /release\/latest-mac\.yml/);
});
