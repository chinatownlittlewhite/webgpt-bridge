import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolvePlatformArgv, stageWindowsNodeCliRuntime } from "../src/platform.js";

const PRESERVE_NODE_PATH_OPTIONS = "--preserve-symlinks --preserve-symlinks-main";

test("Windows npm staging includes a stable refreshed workspace-local Node for child scripts", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "wgb-win-npm-child-node-"));
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
    fs.writeFileSync(nodePath, "trusted-node-v1", "utf8");
    fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "npm", version: "99.0.0" }), "utf8");
    fs.writeFileSync(cli, "require('../lib/marker.js');\n", "utf8");
    fs.writeFileSync(marker, "module.exports = 'trusted';\n", "utf8");

    const command = Object.freeze({
      platform: "windows",
      logicalCommand: "npm",
      argv: Object.freeze([nodePath, "--preserve-symlinks", "--preserve-symlinks-main", cli, "test"]),
      resolved: true,
      usedTrustedShim: true,
      trustedReadPaths: Object.freeze([path.dirname(nodePath), packageRoot]),
    });

    const first = stageWindowsNodeCliRuntime(command, { workspace, platform: "win32" });
    const stagedNode = first.argv[0];
    const stagedCli = first.argv[3];
    const canonicalWorkspace = fs.realpathSync(workspace);
    for (const stagedPath of [stagedNode, stagedCli]) {
      const relative = path.relative(canonicalWorkspace, stagedPath);
      assert.equal(relative.startsWith("..") || path.isAbsolute(relative), false, `${stagedPath} must remain inside the sandbox workspace`);
      assert.match(relative, /^\.webgpt-bridge[\\/]runtime[\\/]npm[\\/]/);
    }
    assert.notEqual(stagedNode, nodePath, "npm must not rely on the host-private Node executable inside AppContainer");
    assert.equal(fs.readFileSync(stagedNode, "utf8"), "trusted-node-v1");
    assert.ok(Array.isArray(first.trustedPathEntries), "stager must provide host-derived PATH entries for npm child scripts");
    assert.ok(first.trustedPathEntries.includes(path.dirname(stagedNode)), "npm child PATH must include the staged Node directory");
    assert.deepEqual(
      first.trustedEnvironment,
      { NODE_OPTIONS: PRESERVE_NODE_PATH_OPTIONS },
      "npm child Node processes must preserve lexical workspace paths instead of traversing the inaccessible host drive root",
    );
    assert.equal(first.trustedReadPaths.includes(path.dirname(nodePath)), false, "host-private Node directory must not remain an AppContainer read grant");

    fs.writeFileSync(stagedNode, "poisoned-node", "utf8");
    fs.writeFileSync(nodePath, "trusted-node-v2", "utf8");
    const refreshed = stageWindowsNodeCliRuntime(command, { workspace, platform: "win32" });
    assert.equal(refreshed.argv[0], stagedNode, "approval-bound resolved argv must use a stable staged Node path");
    assert.equal(refreshed.argv[3], stagedCli, "approval-bound resolved argv must keep the stable staged npm CLI path");
    assert.equal(fs.readFileSync(stagedNode, "utf8"), "trusted-node-v2", "each invocation must refresh staged Node from the trusted host runtime");
    assert.deepEqual(refreshed.trustedEnvironment, { NODE_OPTIONS: PRESERVE_NODE_PATH_OPTIONS });
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("Windows npm staging waits for a just-finished staged Node executable before refreshing", { skip: process.platform !== "win32" }, async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "wgb-win-npm-refresh-lock-"));
  let child = null;
  try {
    const workspace = path.join(fixture, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const command = resolvePlatformArgv(["npm", "--version"], {
      env: process.env,
      platform: "win32",
      nodePath: process.execPath,
    });
    const first = stageWindowsNodeCliRuntime(command, { workspace, platform: "win32" });
    child = spawn(first.argv[0], ["-e", "setTimeout(() => process.exit(0), 400)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    await once(child, "spawn");

    const refreshed = stageWindowsNodeCliRuntime(command, { workspace, platform: "win32" });
    assert.equal(refreshed.argv[0], first.argv[0], "refresh must preserve the stable staged Node path after the lock clears");
    assert.equal(refreshed.argv[3], first.argv[3], "refresh must preserve the stable staged npm CLI path after the lock clears");
    if (child.exitCode === null) await once(child, "exit");
  } finally {
    if (child?.exitCode === null) child.kill();
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});