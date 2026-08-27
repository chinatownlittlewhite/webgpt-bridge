import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveWorkspace, resolveWorkspaceCwd } from "../src/workspace.js";

test("cwd inside the workspace is accepted", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-workspace-"));
  const sub = path.join(root, "src");
  fs.mkdirSync(sub);
  const resolved = resolveWorkspaceCwd(root, "src");
  assert.equal(resolved.cwd, fs.realpathSync(sub));
  fs.rmSync(root, { recursive: true, force: true });
});

test("relative cwd escape is rejected", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-workspace-"));
  assert.throws(() => resolveWorkspaceCwd(root, ".."), /escapes/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("symlink cwd escape is rejected", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-workspace-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-outside-"));
  try {
    fs.symlinkSync(outside, path.join(root, "escape"), "dir");
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
    t.skip(`directory symlinks are unavailable: ${error.message}`);
    return;
  }
  assert.throws(() => resolveWorkspaceCwd(root, "escape"), /symlink outside/);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test("legacy internal state directory migrates without replacing an existing new directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-workspace-"));
  const legacy = path.join(root, ".local-project-coding");
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, "state.txt"), "preserve");
  resolveWorkspace(root);
  assert.equal(fs.existsSync(legacy), false);
  assert.equal(fs.readFileSync(path.join(root, ".webgpt-bridge", "state.txt"), "utf8"), "preserve");
  fs.rmSync(root, { recursive: true, force: true });
});
