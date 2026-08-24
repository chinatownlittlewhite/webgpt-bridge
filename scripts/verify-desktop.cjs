const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const testDir = path.join(root, "test");
const tests = fs.readdirSync(testDir)
  .filter((name) => name.endsWith(".test.cjs"))
  .sort()
  .map((name) => path.join("test", name));

if (tests.length === 0) {
  console.error("No desktop tests found.");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...tests], {
  cwd: root,
  stdio: "inherit",
  shell: false,
  windowsHide: true,
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
