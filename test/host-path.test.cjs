const test = require("node:test");
const assert = require("node:assert/strict");
const { buildTrustedCommandPath, selectSupportedNode, windowsNodeCandidates } = require("../src/host-path.cjs");

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

test("Node selection skips candidates older than Node 20", () => {
  assert.equal(typeof selectSupportedNode, "function");
  const versions = new Map([
    ["C:\\Program Files\\nodejs\\node.exe", "v18.16.0"],
    ["C:\\tools\\node22\\node.exe", "v22.23.2"],
  ]);
  assert.equal(
    selectSupportedNode([...versions.keys()], (candidate) => versions.get(candidate)),
    "C:\\tools\\node22\\node.exe",
  );
  assert.equal(selectSupportedNode(["node20"], () => "v20.0.0"), "node20");
  assert.equal(selectSupportedNode(["broken"], () => "not-a-version"), "");
});

test("Windows Node discovery covers version-manager and per-user installs without inherited PATH", () => {
  assert.equal(typeof windowsNodeCandidates, "function");
  const candidates = windowsNodeCandidates({
    env: {
      ProgramFiles: "C:\\Program Files",
      LOCALAPPDATA: "C:\\Users\\ck\\AppData\\Local",
      USERPROFILE: "C:\\Users\\ck",
      NVM_SYMLINK: "C:\\nvm4w\\nodejs",
      NVM_HOME: "C:\\Users\\ck\\AppData\\Roaming\\nvm",
      VOLTA_HOME: "C:\\Users\\ck\\AppData\\Local\\Volta",
      SCOOP: "C:\\Users\\ck\\scoop",
      PATH: "",
    },
  });

  assert.deepEqual(candidates, [
    "C:\\nvm4w\\nodejs\\node.exe",
    "C:\\Users\\ck\\AppData\\Roaming\\nvm\\node.exe",
    "C:\\Users\\ck\\AppData\\Local\\Volta\\bin\\node.exe",
    "C:\\Program Files\\nodejs\\node.exe",
    "C:\\Users\\ck\\AppData\\Local\\Programs\\nodejs\\node.exe",
    "C:\\Users\\ck\\scoop\\apps\\nodejs-lts\\current\\node.exe",
    "C:\\Users\\ck\\scoop\\apps\\nodejs\\current\\node.exe",
  ]);
});
