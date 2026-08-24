const test = require("node:test");
const assert = require("node:assert/strict");
const { buildTrustedCommandPath } = require("../src/host-path.cjs");

test("macOS Agent PATH includes Homebrew and the selected Node directory", () => {
  const knownDirectories = new Set([
    "/Users/test/.nvm/versions/node/v22/bin",
    "/Users/test/Library/Application Support/local-agent-host/tools/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    "/custom/bin",
  ]);
  const result = buildTrustedCommandPath({
    nodePath: "/Users/test/.nvm/versions/node/v22/bin/node",
    additionalPaths: ["/Users/test/Library/Application Support/local-agent-host/tools/bin"],
    env: { PATH: "/custom/bin:/missing/bin" },
    platform: "darwin",
    isDirectory: (candidate) => knownDirectories.has(candidate),
  }).split(":");

  assert.deepEqual(result, [
    "/Users/test/.nvm/versions/node/v22/bin",
    "/Users/test/Library/Application Support/local-agent-host/tools/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    "/custom/bin",
  ]);
});
