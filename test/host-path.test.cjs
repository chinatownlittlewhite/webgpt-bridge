const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildTrustedCommandPath,
  preferredNodeCandidates,
  selectSupportedNode,
  windowsNodeCandidates,
} = require("../src/host-path.cjs");

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

test("Windows Node discovery covers version managers, per-user installs, Scoop, and absolute PATH candidates", () => {
  assert.equal(typeof windowsNodeCandidates, "function");
  const candidates = windowsNodeCandidates({
    env: {
      ProgramFiles: "C:\\Program Files",
      LOCALAPPDATA: "C:\\Users\\ck\\AppData\\Local",
      USERPROFILE: "C:\\Users\\ck",
      NVM_SYMLINK: "C:\\nvm4w\\nodejs",
      FNM_MULTISHELL_PATH: "C:\\Users\\ck\\AppData\\Local\\fnm_multishells\\123",
      VOLTA_HOME: "C:\\Users\\ck\\AppData\\Local\\Volta",
      SCOOP: "C:\\Users\\ck\\scoop",
      PATH: "C:\\portable\\node22;C:\\Windows\\System32",
    },
  });

  assert.deepEqual(candidates, [
    "C:\\nvm4w\\nodejs\\node.exe",
    "C:\\Users\\ck\\AppData\\Local\\fnm_multishells\\123\\node.exe",
    "C:\\Users\\ck\\AppData\\Local\\Volta\\bin\\node.exe",
    "C:\\Program Files\\nodejs\\node.exe",
    "C:\\Program Files\\Volta\\node.exe",
    "C:\\Users\\ck\\AppData\\Local\\Programs\\nodejs\\node.exe",
    "C:\\Users\\ck\\scoop\\apps\\nodejs-lts\\current\\node.exe",
    "C:\\Users\\ck\\scoop\\apps\\nodejs\\current\\node.exe",
    "C:\\portable\\node22\\node.exe",
    "C:\\Windows\\System32\\node.exe",
  ]);
});

test("Windows prefers explicit overrides, then bundled Node, then discovered system candidates", () => {
  assert.equal(typeof preferredNodeCandidates, "function");
  const candidates = preferredNodeCandidates({
    settingsNodePath: "C:\\custom\\node.exe",
    lpcNodePath: "C:\\override\\node.exe",
    bundledNodePath: "D:\\WebGPT Bridge\\resources\\node-runtime\\node.exe",
    platform: "win32",
    env: { ProgramFiles: "C:\\Program Files", PATH: "" },
    nvmCandidates: [],
  });
  assert.deepEqual(candidates.slice(0, 4), [
    "C:\\custom\\node.exe",
    "C:\\override\\node.exe",
    "D:\\WebGPT Bridge\\resources\\node-runtime\\node.exe",
    "C:\\Program Files\\nodejs\\node.exe",
  ]);

  const versions = new Map([
    ["D:\\WebGPT Bridge\\resources\\node-runtime\\node.exe", "v22.23.2"],
    ["C:\\Program Files\\nodejs\\node.exe", "v18.16.0"],
  ]);
  assert.equal(
    selectSupportedNode(candidates, (candidate) => versions.get(candidate) || ""),
    "D:\\WebGPT Bridge\\resources\\node-runtime\\node.exe",
  );
});
