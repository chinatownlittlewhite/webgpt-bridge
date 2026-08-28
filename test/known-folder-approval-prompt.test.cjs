const test = require("node:test");
const assert = require("node:assert/strict");
const { approvalPrompt } = require("../src/approval-prompt.cjs");

test("known-folder access has a dedicated per-folder permission prompt", () => {
  const prompt = approvalPrompt({ kind: "known-folder-access", folder: "documents", operation: "read" }, "full_control");
  assert.match(prompt.message, /文档|Documents|本机文件/i);
  assert.match(prompt.rememberKey, /known-folder:read:documents/);
});
