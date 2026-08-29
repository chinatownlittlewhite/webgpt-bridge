const test = require("node:test");
const assert = require("node:assert/strict");

function api() {
  return require("../shared/security-policy-core.cjs");
}

function compact(result) {
  return {
    decision: result.decision,
    rule: result.rule,
    permissionClass: result.permissionClass,
    rememberScope: result.rememberScope,
  };
}

test("canonical policy returns a frozen normalized result and fails closed for unknown operations", () => {
  const { authorizeSecurityOperation, normalizeApprovalPreset } = api();
  assert.equal(normalizeApprovalPreset("cautious"), "cautious");
  assert.equal(normalizeApprovalPreset("development"), "development");
  assert.equal(normalizeApprovalPreset("auto"), "auto");
  assert.equal(normalizeApprovalPreset("full_control"), "full_control");
  assert.equal(normalizeApprovalPreset("unknown"), "development");

  const result = authorizeSecurityOperation({ type: "unknown" });
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(Object.keys(result), ["decision", "rule", "reason", "permissionClass", "rememberScope"]);
  assert.equal(result.decision, "deny");
  assert.equal(result.rule, "invalid-operation");
  assert.equal(typeof result.reason, "string");
  assert.ok(result.reason.length > 0);
  assert.equal(result.permissionClass, null);
  assert.equal(result.rememberScope, "none");
});

test("filesystem path policy preserves workspace host sensitive and system boundaries", () => {
  const { authorizeSecurityOperation } = api();
  const decide = (scope, kind) => compact(authorizeSecurityOperation({ type: "filesystem-path", scope, kind }));

  assert.deepEqual(decide("workspace", "read"), {
    decision: "allow", rule: "workspace-path", permissionClass: null, rememberScope: "none",
  });
  assert.deepEqual(decide("known-folder", "read"), {
    decision: "confirm", rule: "known-folder-read", permissionClass: null, rememberScope: "connection",
  });
  assert.deepEqual(decide("ordinary-host", "list"), {
    decision: "confirm", rule: "ordinary-host-read", permissionClass: null, rememberScope: "connection",
  });
  assert.equal(decide("ordinary-host", "update").decision, "allow");
  assert.deepEqual(decide("sensitive", "read"), {
    decision: "deny", rule: "sensitive-path", permissionClass: null, rememberScope: "none",
  });
  assert.deepEqual(decide("system", "read"), {
    decision: "deny", rule: "system-path", permissionClass: null, rememberScope: "none",
  });
});

test("filesystem action policy keeps sensitive access single-use and presets bounded", () => {
  const { authorizeSecurityOperation } = api();
  const decide = (input) => compact(authorizeSecurityOperation({ type: "filesystem-action", ...input }));

  assert.deepEqual(decide({ kind: "read", sensitive: true, preset: "full_control" }), {
    decision: "confirm", rule: "sensitive-read", permissionClass: null, rememberScope: "single-use",
  });
  assert.equal(decide({ kind: "update", sensitive: true, preset: "full_control" }).decision, "deny");
  assert.equal(decide({ kind: "execute", sensitive: true, preset: "full_control" }).decision, "deny");
  assert.equal(decide({ kind: "delete", withinWorkspace: true, preset: "cautious" }).decision, "confirm");
  assert.equal(decide({ kind: "delete", withinWorkspace: true, preset: "development" }).decision, "allow");
  assert.equal(decide({ kind: "move", withinWorkspace: false, preset: "auto" }).decision, "confirm");
  assert.equal(decide({ kind: "network", preset: "auto" }).decision, "confirm");
  assert.equal(decide({ kind: "network", preset: "full_control" }).decision, "allow");
});

test("canonical immutable executable rules preserve Agent and Host-terminal compatibility", () => {
  const { isImmutableDeniedExecutable } = api();
  for (const command of ["sudo", "su", "scp", "sftp", "sh", "bash", "zsh", "fish", "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe"]) {
    assert.equal(isImmutableDeniedExecutable(command, "agent"), true, `${command} stays denied to the Agent`);
    assert.equal(isImmutableDeniedExecutable(command, "host-terminal"), true, `${command} stays denied to the Host terminal broker`);
  }
  assert.equal(isImmutableDeniedExecutable("doas", "agent"), false, "Agent compatibility keeps doas approval-gated for now");
  assert.equal(isImmutableDeniedExecutable("doas", "host-terminal"), true, "Host terminal keeps its stricter doas deny");
  assert.equal(isImmutableDeniedExecutable("git", "agent"), false);
});

test("agent command policy preserves immutable denies and existing command rule ids", () => {
  const { authorizeSecurityOperation } = api();
  const decide = (commandClass) => compact(authorizeSecurityOperation({ type: "agent-command", commandClass }));

  assert.deepEqual(decide("immutable-deny"), {
    decision: "deny", rule: "always-deny", permissionClass: null, rememberScope: "none",
  });
  assert.equal(decide("ssh").decision, "confirm");
  assert.equal(decide("ssh").rule, "ssh-network");
  assert.deepEqual(decide("git-read"), {
    decision: "allow", rule: "git-read-only", permissionClass: null, rememberScope: "none",
  });
  assert.equal(decide("git-path-sensitive").rule, "git-path-sensitive");
  assert.equal(decide("git-path-sensitive").decision, "confirm");
  assert.equal(decide("git-mutation").decision, "confirm");
  assert.equal(decide("project-check").decision, "allow");
  assert.equal(decide("package-manager").decision, "confirm");
  assert.equal(decide("runtime-execution").decision, "confirm");
  assert.equal(decide("sensitive-command").decision, "confirm");
  assert.equal(decide("default-ask").decision, "confirm");
});

test("agent execution never upgrades deny and requires verified sandbox for unattended allow", () => {
  const { authorizeSecurityOperation } = api();
  const denied = authorizeSecurityOperation({
    type: "agent-execution",
    baseDecision: "deny",
    baseRule: "always-deny",
    baseReason: "blocked",
    sandboxVerified: true,
  });
  assert.equal(denied.decision, "deny");
  assert.equal(denied.rule, "always-deny");

  const unsafe = authorizeSecurityOperation({
    type: "agent-execution",
    baseDecision: "allow",
    baseRule: "project-check",
    baseReason: "safe project check",
    sandboxVerified: false,
    sandboxEnforced: true,
    sandboxName: "macos-seatbelt",
  });
  assert.equal(unsafe.decision, "confirm");
  assert.equal(unsafe.rule, "unverified-sandbox");

  const verified = authorizeSecurityOperation({
    type: "agent-execution",
    baseDecision: "allow",
    baseRule: "project-check",
    baseReason: "safe project check",
    sandboxVerified: true,
    sandboxEnforced: true,
    sandboxName: "macos-seatbelt",
  });
  assert.equal(verified.decision, "allow");
  assert.equal(verified.rule, "project-check");
});

test("host command policy preserves deny sandbox and preset ordering", () => {
  const { authorizeSecurityOperation } = api();
  const base = {
    type: "host-command",
    preset: "development",
    baseDecision: "confirm",
    baseRule: "git-mutation",
    commandName: "git",
    sandboxVerified: true,
    sandboxExpanded: false,
  };

  assert.equal(authorizeSecurityOperation({ ...base, baseDecision: "deny", baseRule: "always-deny", preset: "full_control" }).decision, "deny");

  const expanded = authorizeSecurityOperation({
    ...base,
    preset: "full_control",
    sandboxExpanded: true,
    sandboxScopeKey: "read:/outside|write:",
  });
  assert.deepEqual(compact(expanded), {
    decision: "confirm",
    rule: "sandbox-expansion",
    permissionClass: "host:sandbox-expansion:read:/outside|write:",
    rememberScope: "connection",
  });

  const unverified = authorizeSecurityOperation({
    ...base,
    preset: "full_control",
    sandboxVerified: false,
  });
  assert.equal(unverified.decision, "confirm");
  assert.equal(unverified.rule, "unverified-sandbox");
  assert.equal(unverified.rememberScope, "connection");

  assert.equal(authorizeSecurityOperation({ ...base, preset: "full_control" }).decision, "allow");
  assert.equal(authorizeSecurityOperation({ ...base, developmentGitMutation: true }).decision, "allow");
  assert.equal(authorizeSecurityOperation({ ...base, gitPush: true }).decision, "confirm");
  assert.equal(authorizeSecurityOperation({ ...base, safeDependencySync: true, baseRule: "package-manager" }).decision, "allow");
  assert.equal(authorizeSecurityOperation({ ...base, safeWorkspaceUtility: true, baseRule: "default-ask" }).decision, "allow");
  assert.equal(authorizeSecurityOperation({ ...base, preset: "cautious", safeWorkspaceUtility: false }).decision, "confirm");
});

test("terminal command policy preserves existing local approval semantics", () => {
  const { authorizeSecurityOperation } = api();
  const base = { type: "terminal-command", preset: "development", baseDecision: "confirm", baseRule: "default-ask" };
  assert.equal(authorizeSecurityOperation({ ...base, baseDecision: "deny", baseRule: "always-deny" }).decision, "deny");
  assert.equal(authorizeSecurityOperation({ ...base, preset: "full_control" }).decision, "allow");
  assert.equal(authorizeSecurityOperation({ ...base, baseRule: "runtime-execution" }).decision, "allow");
  assert.equal(authorizeSecurityOperation({ ...base, projectScript: true }).decision, "allow");
  assert.equal(authorizeSecurityOperation({ ...base, networkCommand: true }).decision, "confirm");
  assert.equal(authorizeSecurityOperation({ ...base, baseDecision: "allow" }).decision, "allow");
  assert.equal(authorizeSecurityOperation({ ...base, githubRead: true }).decision, "allow");
  assert.equal(authorizeSecurityOperation({ ...base, gitReadOnlyRemote: true }).decision, "allow");
  assert.equal(authorizeSecurityOperation({ ...base, safeDependencySync: true }).decision, "allow");
  assert.equal(authorizeSecurityOperation({ ...base, safeWorkspaceUtility: true }).decision, "allow");
});

test("ssh policy denies unsafe normalized requests and keeps validated ssh approval-gated", () => {
  const { authorizeSecurityOperation } = api();
  for (const input of [
    { safeOptions: false, targetAllowed: true, hasRemoteCommand: true },
    { safeOptions: true, targetAllowed: false, hasRemoteCommand: true },
    { safeOptions: true, targetAllowed: true, hasRemoteCommand: false },
  ]) {
    const result = authorizeSecurityOperation({ type: "ssh", ...input });
    assert.equal(result.decision, "deny");
    assert.equal(result.rule, "ssh-policy-deny");
  }

  const allowed = authorizeSecurityOperation({ type: "ssh", safeOptions: true, targetAllowed: true, hasRemoteCommand: true });
  assert.equal(allowed.decision, "confirm");
  assert.equal(allowed.rule, "ssh-network");
  assert.equal(allowed.rememberScope, "connection");
});
