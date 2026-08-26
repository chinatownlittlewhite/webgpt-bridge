import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureHandoffBundle, recordDesignIssue } from "../src/handoff.js";
import { loadProjectContext } from "../src/project-context.js";

function fixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "webgpt-handoff-"));
}

test("handoff bundle creates the fixed six-document project package and project context discovers it", () => {
  const root = fixture();
  try {
    const result = ensureHandoffBundle({ workspace: root, cwd: ".", version: "0.9.1" });
    assert.equal(result.status, "ready");
    const expected = ["CONTEXT.md", "PLAN.md", "CHANGES.md", "TESTS.md", "TODO.md", "MANIFEST.json"];
    for (const name of expected) assert.equal(fs.existsSync(path.join(root, ".webgpt-handoff", name)), true, name);
    const context = loadProjectContext({ workspace: root, cwd: "." });
    assert.ok(context.files.some((entry) => entry.path === ".webgpt-handoff/CONTEXT.md"));
    assert.ok(context.files.some((entry) => entry.path === ".webgpt-handoff/MANIFEST.json"));
    assert.match(context.instructions, /WebGPT Bridge handoff/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("design issue journal is disabled by default and redacts secrets when enabled", () => {
  const root = fixture();
  try {
    ensureHandoffBundle({ workspace: root, cwd: ".", version: "0.9.1" });
    const off = recordDesignIssue({ workspace: root, enabled: false, module: "broker", category: "lifecycle", symptom: "TOKEN=secret", suggestion: "fix", version: "0.9.1" });
    assert.equal(off.status, "disabled");
    assert.equal(fs.existsSync(path.join(root, ".webgpt-handoff", "DESIGN_ISSUES.jsonl")), false);

    const on = recordDesignIssue({
      workspace: root,
      enabled: true,
      module: "broker",
      category: "lifecycle",
      symptom: "request failed Authorization: Bearer top-secret token=abc123",
      suggestion: "cancel child and clear in-flight state",
      relatedTest: "broker-lifecycle.test.js",
      version: "0.9.1",
    });
    assert.equal(on.status, "recorded");
    const journal = fs.readFileSync(path.join(root, ".webgpt-handoff", "DESIGN_ISSUES.jsonl"), "utf8");
    assert.doesNotMatch(journal, /top-secret|abc123/);
    assert.match(journal, /\[REDACTED\]/);
    const todo = fs.readFileSync(path.join(root, ".webgpt-handoff", "TODO.md"), "utf8");
    assert.match(todo, /DESIGN_ISSUES\.jsonl/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
