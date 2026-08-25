const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function api() {
  return require("../src/local-policy.cjs");
}

function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "webgpt-local-policy-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, home, workspace };
}

test("rejects sensitive paths and aliases while allowing ordinary development files", (t) => {
  const { classifyLocalPath } = api();
  const { root, home, workspace } = makeFixture(t);
  const ssh = path.join(home, ".ssh");
  const browser = path.join(home, "Library", "Safari");
  const appData = path.join(home, "Library", "Application Support", "WebGPT Bridge");
  fs.mkdirSync(ssh, { recursive: true });
  fs.mkdirSync(browser, { recursive: true });
  fs.mkdirSync(appData, { recursive: true });
  fs.writeFileSync(path.join(workspace, "index.js"), "export default 1;\n");
  fs.writeFileSync(path.join(workspace, ".env"), "TOKEN=secret\n");
  fs.symlinkSync(ssh, path.join(workspace, "ssh-alias"));

  const options = { homeDir: home, appDataRoots: [appData], platform: "darwin" };
  assert.equal(classifyLocalPath(path.join(workspace, "index.js"), { operation: "read", ...options }).decision, "allow");
  assert.equal(classifyLocalPath(path.join(workspace, ".env"), { operation: "read", ...options }).decision, "deny");
  assert.equal(classifyLocalPath(path.join(ssh, "id_ed25519"), { operation: "read", ...options }).decision, "deny");
  assert.equal(classifyLocalPath(path.join(browser, "History.db"), { operation: "read", ...options }).decision, "deny");
  assert.equal(classifyLocalPath(path.join(appData, "settings.json"), { operation: "read", ...options }).decision, "deny");
  assert.equal(classifyLocalPath(path.join(workspace, "ssh-alias", "id_ed25519"), { operation: "read", ...options }).decision, "deny");
  assert.equal(classifyLocalPath(path.join(root, "System", "config"), { operation: "write", ...options, systemRoots: [path.join(root, "System")] }).decision, "deny");
});

test("allows safe reads but protects changes according to the persisted approval mode", () => {
  const { classifyLocalAction, normalizeApprovalMode } = api();
  assert.equal(normalizeApprovalMode("development"), "development");
  assert.equal(normalizeApprovalMode("auto"), "auto");
  assert.equal(normalizeApprovalMode("full_control"), "full_control");
  assert.equal(normalizeApprovalMode("unknown"), "development");

  assert.equal(classifyLocalAction({ kind: "read", approvalMode: "cautious", sensitive: false }).decision, "allow");
  assert.equal(classifyLocalAction({ kind: "update", approvalMode: "cautious", sensitive: false }).decision, "allow");
  assert.equal(classifyLocalAction({ kind: "delete", approvalMode: "cautious", sensitive: false, withinWorkspace: true }).decision, "confirm");
  assert.equal(classifyLocalAction({ kind: "update", approvalMode: "development", sensitive: false }).decision, "allow");
  assert.equal(classifyLocalAction({ kind: "delete", approvalMode: "development", sensitive: false, withinWorkspace: true }).decision, "allow");
  assert.equal(classifyLocalAction({ kind: "move", approvalMode: "development", sensitive: false, withinWorkspace: true }).decision, "allow");
  assert.equal(classifyLocalAction({ kind: "delete", approvalMode: "development", sensitive: false, withinWorkspace: false }).decision, "confirm");
  assert.equal(classifyLocalAction({ kind: "update", approvalMode: "auto", sensitive: false }).decision, "allow");
  assert.equal(classifyLocalAction({ kind: "delete", approvalMode: "auto", sensitive: false, withinWorkspace: true }).decision, "allow");
  assert.equal(classifyLocalAction({ kind: "move", approvalMode: "auto", sensitive: false, withinWorkspace: false }).decision, "confirm");
  assert.equal(classifyLocalAction({ kind: "network", approvalMode: "auto", sensitive: false }).decision, "confirm");
  assert.equal(classifyLocalAction({ kind: "read", approvalMode: "auto", sensitive: true }).decision, "confirm");
  assert.equal(classifyLocalAction({ kind: "update", approvalMode: "auto", sensitive: true }).decision, "deny");
  assert.equal(classifyLocalAction({ kind: "network", approvalMode: "full_control", sensitive: false }).decision, "allow");
  assert.equal(classifyLocalAction({ kind: "update", approvalMode: "full_control", sensitive: true }).decision, "allow");
  assert.equal(classifyLocalAction({ kind: "delete", approvalMode: "full_control", sensitive: true, withinWorkspace: false }).decision, "allow");
});

test("full control allows paths normally blocked by local path policy", (t) => {
  const { classifyLocalPath } = api();
  const { root, home } = makeFixture(t);
  const ssh = path.join(home, ".ssh");
  const system = path.join(root, "System");
  fs.mkdirSync(ssh, { recursive: true });
  fs.mkdirSync(system, { recursive: true });
  assert.equal(classifyLocalPath(path.join(ssh, "config"), { homeDir: home, approvalMode: "full_control" }).decision, "allow");
  assert.equal(classifyLocalPath(path.join(system, "config"), { homeDir: home, systemRoots: [system], approvalMode: "full_control" }).decision, "allow");
});

test("auto-approves low-risk verified Agent commands while preserving high-risk confirmation", () => {
  const { classifyHostCommandApproval } = api();
  const verified = { enforced: true, autoRunSafe: true, name: "macos-seatbelt" };
  const emptyAccess = { read: [], write: [] };
  const request = (argv, rule, extra = {}) => ({
    argv,
    policy: { decision: "approval_required", rule },
    sandbox: verified,
    sandboxAccess: emptyAccess,
    ...extra,
  });

  assert.equal(classifyHostCommandApproval(request(["node", "script.mjs"], "runtime-execution"), "cautious").decision, "allow");
  assert.equal(classifyHostCommandApproval(request(["npm", "run", "dev"], "package-manager"), "cautious").decision, "allow");
  assert.equal(classifyHostCommandApproval(request(["npm", "ci", "--ignore-scripts"], "package-manager"), "cautious").decision, "allow");
  assert.equal(classifyHostCommandApproval(request(["gh", "run", "list"], "default-ask"), "cautious").decision, "allow");
  assert.equal(classifyHostCommandApproval(request(["git", "fetch", "origin"], "git-mutation"), "cautious").decision, "allow");
  assert.equal(classifyHostCommandApproval(request(["pwd"], "default-ask"), "cautious").decision, "allow");
  assert.equal(classifyHostCommandApproval(request(["git", "commit", "-m", "x"], "git-mutation"), "cautious").decision, "confirm");
  assert.equal(classifyHostCommandApproval(request(["curl", "https://example.com"], "network"), "cautious").decision, "confirm");
  assert.equal(classifyHostCommandApproval(request(["node", "script.mjs"], "runtime-execution"), "development").decision, "allow");
  assert.equal(classifyHostCommandApproval(request(["git", "commit", "-m", "x"], "git-mutation"), "development").decision, "allow");
  assert.equal(classifyHostCommandApproval(request(["git", "restore", "--", "src/a.js"], "git-mutation"), "development").decision, "allow");
  assert.equal(classifyHostCommandApproval(request(["git", "worktree", "remove", "tmp"], "git-mutation"), "development").decision, "allow");
  assert.equal(classifyHostCommandApproval(request(["git", "fetch", "origin"], "git-mutation"), "development").decision, "allow");
  assert.equal(classifyHostCommandApproval(request(["git", "ls-remote", "origin"], "git-mutation"), "development").decision, "allow");
  assert.equal(classifyHostCommandApproval(request(["git", "pull", "--ff-only"], "git-mutation"), "development").decision, "allow");
  assert.equal(classifyHostCommandApproval(request(["git", "push", "origin", "main"], "git-mutation"), "development").decision, "confirm");
  assert.equal(classifyHostCommandApproval(request(["npm", "ci", "--no-audit", "--no-fund", "--ignore-scripts"], "package-manager"), "development").decision, "allow");
  assert.equal(classifyHostCommandApproval(request(["npm", "run", "dev"], "package-manager"), "development").decision, "allow");
  assert.equal(classifyHostCommandApproval(request(["npm", "ci"], "package-manager"), "development").decision, "confirm");
  assert.equal(classifyHostCommandApproval(request(["rm", "-rf", "dist"], "sensitive-command"), "development").decision, "allow");
  assert.equal(classifyHostCommandApproval(request(["mv", "dist", "dist-old"], "sensitive-command"), "development").decision, "allow");
  assert.equal(classifyHostCommandApproval(request(["cp", "README.md", "README.copy.md"], "sensitive-command"), "development").decision, "allow");
  assert.equal(classifyHostCommandApproval(request(["docker", "ps"], "sensitive-command"), "auto").decision, "confirm");
  assert.equal(classifyHostCommandApproval(request(["chmod", "755", "script.sh"], "sensitive-command"), "auto").decision, "confirm");
  assert.equal(classifyHostCommandApproval(request(["curl", "https://example.com"], "sensitive-command"), "auto").decision, "confirm");
  assert.equal(classifyHostCommandApproval(request(["gh", "pr", "create"], "default-ask"), "auto").decision, "confirm");
  assert.equal(classifyHostCommandApproval(request(["gh", "run", "list"], "default-ask"), "auto").decision, "allow");
  assert.equal(classifyHostCommandApproval(request(["gh", "pr", "view", "1"], "default-ask"), "development").decision, "allow");
  assert.equal(classifyHostCommandApproval(request(["gh", "issue", "view", "1"], "default-ask"), "development").decision, "allow");
  assert.equal(classifyHostCommandApproval(request(["pwd"], "default-ask"), "development").decision, "allow");
  assert.equal(classifyHostCommandApproval(request(["mkdir", "build-cache"], "default-ask"), "development").decision, "allow");
  assert.equal(classifyHostCommandApproval(request(["codesign", "--verify", "App.app"], "default-ask"), "development").decision, "allow");
  assert.equal(classifyHostCommandApproval(request(["codesign", "--force", "--sign", "-", "App.app"], "default-ask"), "development").decision, "allow");
  assert.equal(classifyHostCommandApproval(request(["osascript", "-e", "display dialog \"x\""], "default-ask"), "auto").decision, "confirm");
  assert.equal(classifyHostCommandApproval(request(["node", "script.mjs"], "runtime-execution", { sandbox: { enforced: true, autoRunSafe: false } }), "auto").decision, "confirm");
  assert.equal(classifyHostCommandApproval(request(["node", "script.mjs"], "runtime-execution", { sandboxAccess: { read: ["/outside"], write: [] } }), "auto").decision, "confirm");

  const denied = request(["sudo", "rm", "-rf", "/"], "always-deny", { policy: { decision: "deny", rule: "always-deny" }, sandbox: { enforced: false, autoRunSafe: false }, sandboxAccess: { read: ["/"], write: ["/"] } });
  assert.equal(classifyHostCommandApproval(denied, "full_control").decision, "allow");
  assert.equal(classifyHostCommandApproval(request(["curl", "https://example.com"], "network"), "full_control").decision, "allow");
  assert.equal(classifyHostCommandApproval(request(["gh", "pr", "create"], "default-ask"), "full_control").decision, "allow");
  assert.equal(classifyHostCommandApproval(request(["docker", "run", "x"], "sensitive-command"), "full_control").decision, "allow");
  assert.equal(classifyHostCommandApproval(request(["osascript", "-e", "return 1"], "default-ask"), "full_control").decision, "allow");
});
