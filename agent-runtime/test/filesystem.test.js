import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyStructuredPatch,
  deleteWorkspaceFile,
  moveWorkspaceFile,
} from "../src/filesystem.js";

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lpc-fs-"));
}

test("structured patch can add, update, and delete files", () => {
  const workspace = makeWorkspace();
  fs.writeFileSync(path.join(workspace, "a.txt"), "alpha\n", "utf8");
  fs.writeFileSync(path.join(workspace, "remove.txt"), "bye\n", "utf8");

  const result = applyStructuredPatch({
    workspace,
    changes: [
      {
        type: "update",
        path: "a.txt",
        expectedSha256: sha256("alpha\n"),
        replacements: [{ oldText: "alpha", newText: "beta" }],
      },
      { type: "add", path: "nested/new.txt", content: "new\n" },
      { type: "delete", path: "remove.txt", expectedSha256: sha256("bye\n") },
    ],
  });

  assert.equal(result.applied.length, 3);
  assert.equal(fs.readFileSync(path.join(workspace, "a.txt"), "utf8"), "beta\n");
  assert.equal(fs.readFileSync(path.join(workspace, "nested/new.txt"), "utf8"), "new\n");
  assert.equal(fs.existsSync(path.join(workspace, "remove.txt")), false);
});

test("patch rejects stale SHA before mutating anything", () => {
  const workspace = makeWorkspace();
  fs.writeFileSync(path.join(workspace, "a.txt"), "alpha\n", "utf8");

  assert.throws(
    () =>
      applyStructuredPatch({
        workspace,
        changes: [
          { type: "add", path: "new.txt", content: "new\n" },
          {
            type: "update",
            path: "a.txt",
            expectedSha256: "0".repeat(64),
            replacements: [{ oldText: "alpha", newText: "beta" }],
          },
        ],
      }),
    /SHA-256 precondition failed/,
  );
  assert.equal(fs.existsSync(path.join(workspace, "new.txt")), false);
  assert.equal(fs.readFileSync(path.join(workspace, "a.txt"), "utf8"), "alpha\n");
});

test("delete and move require the current SHA", () => {
  const workspace = makeWorkspace();
  fs.writeFileSync(path.join(workspace, "move.txt"), "move me\n", "utf8");
  const hash = sha256("move me\n");

  const moved = moveWorkspaceFile({ workspace, from: "move.txt", to: "moved.txt", expectedSha256: hash });
  assert.equal(moved.from, "move.txt");
  assert.equal(moved.to, "moved.txt");
  assert.equal(moved.sha256, hash);
  assert.equal(moved.atomicDestinationCreate, true);
  assert.equal(fs.existsSync(path.join(workspace, "move.txt")), false);

  deleteWorkspaceFile({ workspace, path: "moved.txt", expectedSha256: hash });
  assert.equal(fs.existsSync(path.join(workspace, "moved.txt")), false);
});

test("patch preserves UTF-8 BOM, CRLF newline style, and executable mode", () => {
  const workspace = makeWorkspace();
  const target = path.join(workspace, "script.txt");
  const raw = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("alpha\r\nbeta\r\n", "utf8")]);
  fs.writeFileSync(target, raw);
  try { fs.chmodSync(target, 0o755); } catch {}
  const beforeMode = fs.statSync(target).mode & 0o777;

  const result = applyStructuredPatch({
    workspace,
    changes: [{
      type: "update",
      path: "script.txt",
      expectedSha256: sha256(raw),
      replacements: [{ oldText: "alpha\nbeta", newText: "first\nsecond" }],
    }],
  });

  const after = fs.readFileSync(target);
  assert.equal(after.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), true);
  assert.equal(after.subarray(3).toString("utf8"), "first\r\nsecond\r\n");
  assert.equal(fs.statSync(target).mode & 0o777, beforeMode);
  assert.equal(result.durability.sameDirectoryTempFiles, true);
  assert.equal(result.durability.baselineRecheckedBeforeCommit, true);
});
