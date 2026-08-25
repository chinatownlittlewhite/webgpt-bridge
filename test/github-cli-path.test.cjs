const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const resolver = require("../src/github-cli-path.cjs");

test("desktop GitHub CLI resolver prefers app-managed tools then Windows standard locations then PATH", () => {
  assert.equal(typeof resolver.resolveDesktopGitHubCli, "function");
  const env = {
    ProgramFiles: "C:\\Program Files",
    LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
  };
  const appToolsBin = "C:\\Bridge\\tools\\bin";
  const appGh = path.win32.join(appToolsBin, "gh.exe");
  const standardGh = path.win32.join(env.ProgramFiles, "GitHub CLI", "gh.exe");
  const seen = [];
  const first = resolver.resolveDesktopGitHubCli({
    platform: "win32",
    env,
    appToolsBin,
    exists(candidate) { seen.push(candidate); return candidate === appGh || candidate === standardGh; },
    findInPath: () => "C:\\legacy\\gh.exe",
  });
  assert.equal(first, appGh);
  assert.equal(seen[0], appGh);

  const second = resolver.resolveDesktopGitHubCli({
    platform: "win32",
    env,
    appToolsBin,
    exists: (candidate) => candidate === standardGh,
    findInPath: () => "C:\\legacy\\gh.exe",
  });
  assert.equal(second, standardGh);
});

test("desktop GitHub CLI resolver sees a newly installed WinGet link on a later call without caching", () => {
  const env = { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" };
  const wingetGh = path.win32.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", "gh.exe");
  let installed = false;
  const options = {
    platform: "win32",
    env,
    appToolsBin: "C:\\Bridge\\tools\\bin",
    exists: (candidate) => installed && candidate === wingetGh,
    findInPath: () => null,
  };
  assert.equal(resolver.resolveDesktopGitHubCli(options), "");
  installed = true;
  assert.equal(resolver.resolveDesktopGitHubCli(options), wingetGh);
});

test("desktop GitHub CLI resolver falls back to PATH and returns empty when unavailable", () => {
  const viaPath = "/opt/homebrew/bin/gh";
  assert.equal(resolver.resolveDesktopGitHubCli({
    platform: "darwin",
    env: {},
    appToolsBin: "/app/tools/bin",
    exists: (candidate) => candidate === viaPath,
    findInPath: () => viaPath,
  }), viaPath);
  assert.equal(resolver.resolveDesktopGitHubCli({
    platform: "darwin",
    env: {},
    appToolsBin: "/app/tools/bin",
    exists: () => false,
    findInPath: () => null,
  }), "");
});
