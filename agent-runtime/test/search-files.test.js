import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { searchFiles } from "../src/search-files.js";

function makeWorkspace() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-search-"));
  fs.mkdirSync(path.join(workspace, "src", "nested"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "node_modules", "ignored"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "dist"), { recursive: true });
  fs.mkdirSync(path.join(workspace, ".cache"), { recursive: true });
  fs.mkdirSync(path.join(workspace, ".hidden"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "src", "a.js"), "a", "utf8");
  fs.writeFileSync(path.join(workspace, "src", "nested", "b.js"), "b", "utf8");
  fs.writeFileSync(path.join(workspace, "src", "note.txt"), "n", "utf8");
  fs.writeFileSync(path.join(workspace, "node_modules", "ignored", "x.js"), "x", "utf8");
  fs.writeFileSync(path.join(workspace, "dist", "built.js"), "x", "utf8");
  fs.writeFileSync(path.join(workspace, ".cache", "cached.js"), "x", "utf8");
  fs.writeFileSync(path.join(workspace, ".hidden", "secret.js"), "x", "utf8");
  return workspace;
}

test("glob search is cwd-aware and skips dependency and hidden trees", () => {
  const workspace = makeWorkspace();
  const result = searchFiles({ workspace, cwd: "src", glob: "**/*.js" });
  assert.deepEqual(result.matches.sort(), ["src/a.js", "src/nested/b.js"]);
  assert.equal(result.truncated, false);
});

test("glob search skips build/cache/dependency trees by default and can explicitly include them", () => {
  const workspace = makeWorkspace();
  const safe = searchFiles({ workspace, cwd: ".", glob: "**/*.js", includeHidden: true });
  assert.equal(safe.matches.some((entry) => entry.includes("node_modules")), false);
  assert.equal(safe.matches.some((entry) => entry.startsWith("dist/")), false);
  assert.equal(safe.matches.some((entry) => entry.startsWith(".cache/")), false);

  const explicit = searchFiles({
    workspace,
    cwd: ".",
    glob: "**/*.js",
    includeHidden: true,
    includeIgnored: true,
  });
  assert.equal(explicit.matches.includes("dist/built.js"), true);
  assert.equal(explicit.matches.includes(".cache/cached.js"), true);
  assert.equal(explicit.matches.includes("node_modules/ignored/x.js"), true);
});

test("glob search respects result limits", () => {
  const workspace = makeWorkspace();
  const result = searchFiles({ workspace, cwd: "src", glob: "**/*", limit: 1 });
  assert.equal(result.matches.length, 1);
  assert.equal(result.truncated, true);
});
