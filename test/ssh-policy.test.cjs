const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function api() {
  const modulePath = path.join(__dirname, "..", "src", "ssh-policy.cjs");
  assert.equal(fs.existsSync(modulePath), true, "ssh-policy.cjs must exist");
  return require(modulePath);
}

test("SSH allows only private/local or explicitly allowlisted hosts and requires a remote command", () => {
  const { validateSshCommand } = api();
  assert.doesNotThrow(() => validateSshCommand(["ssh", "10.0.0.8", "uptime"], { allowedHosts: [] }));
  assert.doesNotThrow(() => validateSshCommand(["ssh", "dev@buildbox.local", "uname", "-a"], { allowedHosts: [] }));
  assert.doesNotThrow(() => validateSshCommand(["ssh", "deploy@example.com", "uptime"], { allowedHosts: ["example.com"] }));
  assert.throws(() => validateSshCommand(["ssh", "example.com", "uptime"], { allowedHosts: [] }), /allow|private|local|允许/i);
  assert.throws(() => validateSshCommand(["ssh", "10.0.0.8"], { allowedHosts: [] }), /command|命令|noninteractive/i);
});

test("SSH rejects forwarding, jump/config/identity overrides, TTY/background, and proxy/local command options", () => {
  const { validateSshCommand } = api();
  const forbidden = [
    ["-L", "8080:localhost:80"], ["-R", "8080:localhost:80"], ["-D", "1080"],
    ["-J", "jump.example"], ["-i", "/tmp/key"], ["-F", "/tmp/config"],
    ["-t"], ["-tt"], ["-f"], ["-A"], ["-X"], ["-Y"],
    ["-o", "ProxyCommand=nc %h %p"], ["-o", "LocalCommand=echo bad"],
  ];
  for (const option of forbidden) {
    assert.throws(() => validateSshCommand(["ssh", ...option, "10.0.0.8", "uptime"], { allowedHosts: [] }), /SSH|option|选项|不允许/i, option.join(" "));
  }
});

test("SSH pins safe noninteractive options and permits only a numeric port override", () => {
  const { SSH_FORCED_OPTIONS, validateSshCommand } = api();
  const result = validateSshCommand(["ssh", "-p", "2222", "10.0.0.8", "uptime"], { allowedHosts: [] });
  assert.deepEqual(result.argv.slice(0, 1), ["ssh"]);
  for (const option of [
    "BatchMode=yes", "PasswordAuthentication=no", "KbdInteractiveAuthentication=no",
    "StrictHostKeyChecking=yes", "ClearAllForwardings=yes", "ForwardAgent=no", "ForwardX11=no",
  ]) {
    assert.equal(SSH_FORCED_OPTIONS.includes(option), true);
    assert.equal(result.argv.includes(option), true);
  }
  assert.deepEqual(result.argv.slice(-4), ["-p", "2222", "10.0.0.8", "uptime"]);
  assert.throws(() => validateSshCommand(["ssh", "-p", "70000", "10.0.0.8", "uptime"], { allowedHosts: [] }), /port|端口/i);
});
