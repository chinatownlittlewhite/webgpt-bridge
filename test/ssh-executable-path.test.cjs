const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveSshExecutable } = require("../src/ssh-executable-path.cjs");

test("Windows SSH is pinned to the system OpenSSH client and never resolved from PATH", () => {
  const probed = [];
  const resolved = resolveSshExecutable({
    platform: "win32",
    env: { SystemRoot: "C:\\Windows", PATH: "C:\\malicious" },
    exists: (candidate) => { probed.push(candidate); return true; },
  });
  assert.equal(resolved, "C:\\Windows\\System32\\OpenSSH\\ssh.exe");
  assert.deepEqual(probed, ["C:\\Windows\\System32\\OpenSSH\\ssh.exe"]);
});

test("Windows SSH fails closed for missing, relative, or UNC system roots", () => {
  for (const env of [{}, { SystemRoot: "Windows" }, { SystemRoot: "\\\\server\\share" }]) {
    let probes = 0;
    const resolved = resolveSshExecutable({ platform: "win32", env, exists: () => { probes += 1; return true; } });
    assert.equal(resolved, "");
    assert.equal(probes, 0);
  }
});

test("macOS/Linux SSH remains pinned to /usr/bin/ssh", () => {
  assert.equal(resolveSshExecutable({ platform: "darwin", exists: (candidate) => candidate === "/usr/bin/ssh" }), "/usr/bin/ssh");
  assert.equal(resolveSshExecutable({ platform: "linux", exists: (candidate) => candidate === "/usr/bin/ssh" }), "/usr/bin/ssh");
});
