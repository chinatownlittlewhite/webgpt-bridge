import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const module = await import("../src/github-cli.js").catch(() => ({}));

test("GitHub CLI resolver prefers trusted explicit path and reports version", () => {
  assert.equal(typeof module.resolveGitHubCli, "function");
  if (typeof module.resolveGitHubCli !== "function") return;
  const explicit = "C:\\Bridge\\tools\\gh.exe";
  const result = module.resolveGitHubCli({
    platform: "win32",
    env: {},
    explicitPath: explicit,
    exists: (candidate) => candidate === explicit,
    findInPath: () => null,
    runVersion: (candidate) => ({ ok: candidate === explicit, version: "2.98.0", detail: "gh version 2.98.0" }),
    runAuth: () => ({ authenticated: true }),
  });
  assert.deepEqual(result, {
    status: "ready",
    resolvedPath: explicit,
    version: "2.98.0",
    authStatus: "authenticated",
    usable: true,
    reason: "GitHub CLI 2.98.0 is available and authenticated",
    remediation: null,
  });
});

test("GitHub CLI resolver scans Windows common install locations before PATH", () => {
  assert.equal(typeof module.resolveGitHubCli, "function");
  if (typeof module.resolveGitHubCli !== "function") return;
  const env = {
    ProgramFiles: "C:\\Program Files",
    LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
  };
  const expected = path.win32.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", "gh.exe");
  const seen = [];
  const result = module.resolveGitHubCli({
    platform: "win32",
    env,
    exists(candidate) {
      seen.push(candidate);
      return candidate === expected;
    },
    findInPath: () => "C:\\legacy\\gh.exe",
    runVersion: () => ({ ok: true, version: "2.97.0", detail: "gh version 2.97.0" }),
    runAuth: () => ({ authenticated: true }),
  });
  assert.equal(result.status, "ready");
  assert.equal(result.resolvedPath, expected);
  assert.ok(seen.includes(path.win32.join(env.ProgramFiles, "GitHub CLI", "gh.exe")));
  assert.ok(seen.includes(path.win32.join(env.LOCALAPPDATA, "Programs", "GitHub CLI", "gh.exe")));
});

test("GitHub CLI resolver reports an installed but unauthenticated CLI as unusable", () => {
  const explicit = "/trusted/gh";
  const result = module.resolveGitHubCli({
    platform: "darwin",
    env: {},
    explicitPath: explicit,
    exists: (candidate) => candidate === explicit,
    findInPath: () => null,
    runVersion: () => ({ ok: true, version: "2.98.0", detail: "gh version 2.98.0" }),
    runAuth: () => ({ authenticated: false }),
  });
  assert.equal(result.status, "unauthenticated");
  assert.equal(result.authStatus, "unauthenticated");
  assert.equal(result.usable, false);
  assert.match(result.remediation, /gh auth login/i);
});

test("GitHub CLI resolver reports missing and broken states with remediation", () => {
  assert.equal(typeof module.resolveGitHubCli, "function");
  if (typeof module.resolveGitHubCli !== "function") return;
  const missing = module.resolveGitHubCli({
    platform: "win32",
    env: {},
    exists: () => false,
    findInPath: () => null,
    runVersion: () => ({ ok: false, detail: "not run" }),
  });
  assert.equal(missing.status, "missing");
  assert.equal(missing.resolvedPath, null);
  assert.match(missing.remediation, /GitHub CLI/i);

  const brokenPath = "C:\\Program Files\\GitHub CLI\\gh.exe";
  const broken = module.resolveGitHubCli({
    platform: "win32",
    env: { ProgramFiles: "C:\\Program Files" },
    exists: (candidate) => candidate === brokenPath,
    findInPath: () => null,
    runVersion: () => ({ ok: false, detail: "exit 1" }),
  });
  assert.equal(broken.status, "broken");
  assert.equal(broken.resolvedPath, brokenPath);
  assert.match(broken.reason, /exit 1/);
});
