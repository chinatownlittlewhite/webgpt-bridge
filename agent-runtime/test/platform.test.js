import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as platformModule from "../src/platform.js";
import {
  normalizedPlatform,
  platformSecurityNotes,
  resolvePlatformArgv,
} from "../src/platform.js";

test("current-platform node command resolves through trusted PATH without a shell", () => {
  const result = resolvePlatformArgv(["node", "--version"]);
  assert.equal(result.resolved, true);
  assert.equal(path.isAbsolute(result.argv[0]), true);
  assert.equal(result.logicalCommand, "node");
  assert.ok(Array.isArray(result.trustedReadPaths));
  assert.ok(result.trustedReadPaths.length >= 1);
});

test("Unix npm resolution trusts its real package root without trusting the Node prefix", (t) => {
  if (process.platform === "win32") {
    t.skip("Unix npm symlink resolution is covered by Unix native acceptance");
    return;
  }
  const result = resolvePlatformArgv(["npm", "--version"]);
  const resolvedCli = fs.realpathSync(result.argv[0]);
  const packageRoot = path.dirname(path.dirname(resolvedCli));

  assert.equal(result.resolved, true);
  assert.equal(result.logicalCommand, "npm");
  assert.ok(result.trustedReadPaths.includes(packageRoot));
  assert.equal(result.trustedReadPaths.includes(path.dirname(path.dirname(packageRoot))), false);
});

test("macOS Apple Git bypasses the /usr/bin xcrun shim when Command Line Tools Git exists", (t) => {
  if (process.platform !== "darwin") {
    t.skip("macOS developer-tool resolution is validated on macOS");
    return;
  }
  const developerGit = "/Library/Developer/CommandLineTools/usr/bin/git";
  if (!fs.existsSync(developerGit)) {
    t.skip("standalone Command Line Tools Git is not installed on this host");
    return;
  }
  const result = resolvePlatformArgv(["git", "--version"], {
    platform: "darwin",
    env: { ...process.env, PATH: "/usr/bin:/bin" },
  });
  assert.equal(result.resolved, true);
  assert.equal(result.argv[0], developerGit);
  assert.ok(result.trustedReadPaths.includes(path.dirname(developerGit)));
});

test("model command names cannot select executable paths", () => {
  assert.throws(() => resolvePlatformArgv(["/tmp/node", "--version"]), /trusted PATH/);
  assert.throws(() => resolvePlatformArgv(["..\\node.exe", "--version"]), /trusted PATH/);
});

test("platform normalization and security notes freeze shellless Windows strategy", () => {
  assert.equal(normalizedPlatform("win32"), "windows");
  assert.equal(normalizedPlatform("darwin"), "macos");
  assert.equal(normalizedPlatform("linux"), "linux");
  assert.equal(platformSecurityNotes.windowsShellForModelCommands, false);
  assert.equal(platformSecurityNotes.windowsBatchFilesRequireTrustedShim, true);
  assert.equal(platformSecurityNotes.npmUsesNodeCliShimOnWindows, true);
  assert.equal(platformSecurityNotes.pnpmYarnUseTrustedRuntimeShimWhenNeeded, true);
  assert.equal(platformSecurityNotes.trustedRuntimeReadPathsAreHostDerived, true);
});

test("Windows Node CLI shim preserves lexical module paths without host-root ACL traversal", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-win-node-cli-"));
  try {
    const nodePath = path.join(fixture, "node.exe");
    const cli = path.join(fixture, "npm-cli.js");
    fs.writeFileSync(nodePath, "fixture", "utf8");
    fs.writeFileSync(cli, "fixture", "utf8");
    const result = resolvePlatformArgv(["npm", "--version"], {
      platform: "win32",
      env: { PATH: "", PATHEXT: ".EXE;.CMD", npm_execpath: cli },
      nodePath,
    });
    assert.deepEqual(result.argv, [
      path.resolve(nodePath),
      "--preserve-symlinks",
      "--preserve-symlinks-main",
      path.resolve(cli),
      "--version",
    ]);
    assert.ok(result.trustedReadPaths.includes(path.win32.resolve(path.dirname(cli))));
    assert.equal(result.trustedReadPaths.includes(path.win32.resolve(path.dirname(fixture))), false);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("Windows sandbox stages and refreshes npm package runtime inside the host-private workspace namespace", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-win-npm-stage-"));
  try {
    const hostRoot = path.join(fixture, "host");
    const packageRoot = path.join(hostRoot, "node_modules", "npm");
    const cli = path.join(packageRoot, "bin", "npm-cli.js");
    const marker = path.join(packageRoot, "lib", "marker.js");
    const nodePath = path.join(hostRoot, "node.exe");
    const workspace = path.join(fixture, "workspace");
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(nodePath, "fixture", "utf8");
    fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "npm", version: "99.0.0" }), "utf8");
    fs.writeFileSync(cli, "require('../lib/marker.js');\n", "utf8");
    fs.writeFileSync(marker, "module.exports = 'staged';\n", "utf8");

    const materialize = platformModule.stageWindowsNodeCliRuntime;
    assert.equal(typeof materialize, "function", "Windows sandbox must expose a host-only Node CLI runtime staging helper");
    const command = Object.freeze({
      platform: "windows",
      logicalCommand: "npm",
      argv: Object.freeze([nodePath, "--preserve-symlinks", "--preserve-symlinks-main", cli, "--version"]),
      resolved: true,
      usedTrustedShim: true,
      trustedReadPaths: Object.freeze([path.dirname(nodePath), packageRoot]),
    });
    const result = materialize(command, { workspace, platform: "win32" });

    const stagedNode = result.argv[0];
    const stagedCli = result.argv[3];
    const canonicalWorkspace = fs.realpathSync(workspace);
    const relativeNode = path.relative(canonicalWorkspace, stagedNode);
    const relativeCli = path.relative(canonicalWorkspace, stagedCli);
    assert.equal(relativeNode.startsWith("..") || path.isAbsolute(relativeNode), false, "staged Node must remain inside the canonical sandbox workspace");
    assert.equal(relativeCli.startsWith("..") || path.isAbsolute(relativeCli), false, "staged npm CLI must remain inside the canonical sandbox workspace");
    assert.match(relativeNode, /^\.webgpt-bridge[\\/]runtime[\\/]npm[\\/]/);
    assert.match(relativeCli, /^\.webgpt-bridge[\\/]runtime[\\/]npm[\\/]/);
    const stagedPackageRoot = path.dirname(path.dirname(stagedCli));
    const stagedMarker = path.join(stagedPackageRoot, "lib", "marker.js");
    assert.equal(fs.readFileSync(stagedMarker, "utf8"), "module.exports = 'staged';\n");
    assert.notEqual(stagedNode, nodePath, "external Node executable must be staged before entering AppContainer");
    assert.equal(result.trustedReadPaths.includes(packageRoot), false, "external npm package root must no longer be an AppContainer read grant");
    assert.equal(result.trustedReadPaths.includes(path.dirname(nodePath)), false, "external Node directory must no longer be an AppContainer read grant");
    assert.ok(result.trustedReadPaths.includes(stagedPackageRoot), "staged npm package root must be the runtime read grant");
    assert.ok(result.trustedPathEntries.includes(path.dirname(stagedNode)), "staged Node directory must be available for npm child scripts");

    fs.writeFileSync(stagedMarker, "module.exports = 'poisoned';\n", "utf8");
    const refreshed = materialize(command, { workspace, platform: "win32" });
    assert.equal(refreshed.argv[0], stagedNode, "approval-bound resolved argv must use a stable staged Node path");
    assert.equal(refreshed.argv[3], stagedCli, "approval-bound resolved argv must use a stable staged npm CLI path");
    assert.equal(fs.readFileSync(stagedMarker, "utf8"), "module.exports = 'staged';\n", "each invocation must refresh staged npm files from the trusted host runtime");
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("Windows acceptance resolves npm through a trusted non-shell runtime shim", (t) => {
  if (process.platform !== "win32") {
    t.skip("real Windows PATH resolution is validated on Windows final acceptance");
    return;
  }
  const result = resolvePlatformArgv(["npm", "--version"], { platform: "win32", env: process.env });
  assert.equal(result.resolved, true);
  assert.equal(result.usedTrustedShim, true);
  assert.match(path.win32.basename(result.argv[0]), /^node(?:\.exe)?$/i);
  assert.equal(result.argv[1], "--preserve-symlinks");
  assert.equal(result.argv[2], "--preserve-symlinks-main");
  assert.match(path.win32.basename(result.argv[3]), /^npm-cli\.js$/i);
  assert.ok(result.trustedReadPaths.length >= 1);
});
