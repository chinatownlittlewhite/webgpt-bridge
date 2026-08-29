const test = require("node:test");
const assert = require("node:assert/strict");

function api() {
  return require("../src/approval-prompt.cjs");
}

test("summarizes local Git approval as permission, not command diagnostics", () => {
  const { approvalPrompt } = api();
  const prompt = approvalPrompt({
    kind: "terminal-command",
    argv: ["git", "reset", "--soft", "HEAD~1"],
    cwd: "/project",
    policy: { rule: "git-mutation", reason: "Git mutation requires approval" },
  }, "development");
  assert.equal(prompt.message, "允许修改当前项目的 Git 状态？");
  assert.equal(prompt.detail, "操作：本地 Git 变更\n范围：当前项目");
  assert.doesNotMatch(prompt.detail, /命令：|原因：|Git mutation requires approval|\/project/);
  assert.equal(prompt.detail.split("\n").length, 2);
  assert.equal(prompt.rememberKey, "terminal:git-local");
});

test("npm run approvals describe project scripts instead of dependency installation", () => {
  const { approvalPrompt } = api();
  const prompt = approvalPrompt({
    kind: "terminal-command",
    argv: ["npm", "run", "build:icon"],
    cwd: "/project",
    policy: { rule: "package-manager", reason: "arbitrary script" },
  }, "development");
  assert.equal(prompt.message, "允许执行当前项目脚本？");
  assert.equal(prompt.detail, "操作：build:icon\n范围：当前项目");
  assert.doesNotMatch(prompt.detail, /命令：|原因：|package-manager|\/project/);
  assert.equal(prompt.rememberKey, null);
});

test("safe dependency sync is summarized as a project permission", () => {
  const { approvalPrompt } = api();
  const prompt = approvalPrompt({
    kind: "terminal-command",
    argv: ["npm", "ci", "--no-audit", "--ignore-scripts"],
    cwd: "/project",
    policy: { rule: "package-manager", reason: "package manager" },
  }, "development");
  assert.equal(prompt.message, "允许更新当前项目依赖？");
  assert.equal(prompt.detail, "操作：更新依赖（安装脚本已禁用）\n范围：当前项目");
  assert.equal(prompt.rememberKey, "terminal:dependency-sync");
});

test("network permission is remembered per external host for the current connection", () => {
  const { approvalPrompt } = api();
  const prompt = approvalPrompt({
    kind: "terminal-command",
    argv: ["curl", "https://example.com/upload"],
    cwd: "/project",
    policy: { rule: "network", reason: "network access" },
  }, "auto");
  assert.equal(prompt.message, "允许访问外部网络？");
  assert.equal(prompt.detail, "目标：example.com\n范围：外部网络");
  assert.doesNotMatch(prompt.detail, /命令：|原因：|network access|\/project/);
  assert.equal(prompt.rememberKey, "terminal:network:example.com");
});

test("destructive file prompts outside the workspace share a connection permission class", () => {
  const { approvalPrompt } = api();
  const request = {
    kind: "local-file-batch",
    rememberable: false,
    scope: "outside-workspace",
    changes: [
      { type: "delete", path: "/outside/a.txt" },
      { type: "move", from: "/outside/b.txt", path: "/outside/c.txt" },
    ],
  };
  const prompt = approvalPrompt(request, "development");
  assert.equal(prompt.message, "允许删除或移动项目文件？");
  assert.equal(prompt.detail, "操作：删除 1 · 移动 1\n范围：工作区外");
  assert.equal(prompt.detail.split("\n").length, 2);
  assert.equal(prompt.rememberKey, "files:destructive:outside-workspace");
});

test("host-provided permission classes override command-derived memory keys", () => {
  const { approvalPrompt } = api();
  const prompt = approvalPrompt({
    kind: "terminal-command",
    argv: ["node", "script.mjs"],
    policy: { rule: "runtime-execution" },
    rememberKey: "host:sandbox-expansion:read:/outside",
  }, "development");
  assert.equal(prompt.rememberKey, "host:sandbox-expansion:read:/outside");
});

test("ordinary Host path access has a distinct connection-scoped permission prompt", () => {
  const { approvalPrompt } = api();
  const prompt = approvalPrompt({
    kind: "host-path-access",
    path: "/Users/test/Projects/other",
    operation: "read",
    permissionClass: "host-path:read:/Users/test/Projects/other",
  }, "development");
  assert.match(prompt.message, /本机文件|Host|工作区外/i);
  assert.match(prompt.detail, /读取|read/i);
  assert.equal(prompt.rememberKey, "host-path:read:/Users/test/Projects/other");
});

test("sensitive access is concise and remembered by sensitive root", () => {
  const { approvalPrompt } = api();
  const prompt = approvalPrompt({ kind: "sensitive-access", operation: "read", path: "/Users/me/.ssh/config" }, "auto");
  assert.equal(prompt.message, "允许读取敏感位置？");
  assert.equal(prompt.detail, "位置：.ssh/config\n范围：仅本次访问");
  assert.doesNotMatch(prompt.detail, /原因：|私人数据|\/Users\/me/);
  assert.equal(prompt.detail.split("\n").length, 2);
  assert.equal(prompt.rememberKey, "sensitive:read:.ssh");
});
