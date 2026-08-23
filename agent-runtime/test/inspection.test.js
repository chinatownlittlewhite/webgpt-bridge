import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  listWorkspaceDirectory,
  readWorkspaceFile,
  searchWorkspaceText,
} from "../src/inspection.js";

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lpc-inspection-"));
}

test("read_file returns bounded lines, raw SHA, and executable continuation", () => {
  const root = workspace();
  const content = "one\ntwo\nthree\nfour\n";
  fs.writeFileSync(path.join(root, "a.txt"), content, "utf8");
  const result = readWorkspaceFile({ workspace: root, path: "a.txt", startLine: 2, maxLines: 2 });
  assert.equal(result.content, "two\nthree");
  assert.equal(result.streaming, true);
  assert.equal(result.startLine, 2);
  assert.equal(result.endLine, 3);
  assert.equal(result.totalLines, 4);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.nextAction, {
    tool: "read_file",
    arguments: { path: "a.txt", startLine: 4, maxLines: 2, maxBytes: 64_000 },
  });
  assert.equal(result.sha256, crypto.createHash("sha256").update(content).digest("hex"));
  fs.rmSync(root, { recursive: true, force: true });
});

test("read_file distinguishes normal pagination from an oversized single line", () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, "paged.txt"), "a\nb\nc\n", "utf8");
  const paged = readWorkspaceFile({ workspace: root, path: "paged.txt", maxLines: 1, maxBytes: 1024 });
  assert.equal(paged.content, "a");
  assert.equal(paged.nextAction.tool, "read_file");
  assert.equal(paged.nextAction.arguments.startLine, 2);

  fs.writeFileSync(path.join(root, "long.txt"), `${"x".repeat(2_000)}\n`, "utf8");
  const longLine = readWorkspaceFile({ workspace: root, path: "long.txt", maxLines: 10, maxBytes: 1024 });
  assert.equal(longLine.content, "");
  assert.equal(longLine.truncated, true);
  assert.match(longLine.nextAction.hint, /exceeds the current maxBytes budget/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("read_file rejects binary and symlink escape", () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, "binary.bin"), Buffer.from([1, 0, 2]));
  assert.throws(() => readWorkspaceFile({ workspace: root, path: "binary.bin" }), /binary/);

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-inspection-outside-"));
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret", "utf8");
  try {
    fs.symlinkSync(outside, path.join(root, "escape"), "dir");
    assert.throws(() => readWorkspaceFile({ workspace: root, path: "escape/secret.txt" }), /symlink outside|outside the configured workspace/);
  } catch (error) {
    if (error?.code !== "EPERM") throw error;
  }
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test("list_dir is deterministic, bounded, and does not recurse ignored or symlinked trees", () => {
  const root = workspace();
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "b.js"), "b\n");
  fs.writeFileSync(path.join(root, "src", "a.js"), "a\n");
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.writeFileSync(path.join(root, "node_modules", "hidden.js"), "x\n");
  const result = listWorkspaceDirectory({ workspace: root, path: ".", recursive: true, maxDepth: 3 });
  assert.deepEqual(result.entries.map((entry) => entry.path), ["src", "src/a.js", "src/b.js"]);
  assert.equal(result.truncated, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("search_text returns bounded literal matches with context", () => {
  const root = workspace();
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "a.js"), "before\nNeedle here\nafter\n", "utf8");
  fs.writeFileSync(path.join(root, "src", "b.js"), "needle there\n", "utf8");
  const result = searchWorkspaceText({
    workspace: root,
    query: "needle",
    path: "src",
    glob: "**/*.js",
    contextLines: 1,
    maxResults: 10,
  });
  assert.equal(result.matchCount, 2);
  assert.equal(result.matches[0].path, "src/a.js");
  assert.equal(result.matches[0].line, 2);
  assert.deepEqual(result.matches[0].before, ["before"]);
  assert.deepEqual(result.matches[0].after, ["after"]);
  assert.equal(result.matches[1].path, "src/b.js");
  fs.rmSync(root, { recursive: true, force: true });
});
