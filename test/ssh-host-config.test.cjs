const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeSettings } = require("../src/host-config.cjs");

test("SSH settings default closed and normalize a bounded host allowlist", () => {
  const defaults = normalizeSettings({});
  assert.equal(defaults.sshEnabled, false);
  assert.deepEqual(defaults.sshAllowedHosts, []);

  const settings = normalizeSettings({
    sshEnabled: true,
    sshAllowedHosts: [" buildbox.local ", "Example.COM", "", "example.com"],
  });
  assert.equal(settings.sshEnabled, true);
  assert.deepEqual(settings.sshAllowedHosts, ["buildbox.local", "example.com"]);
  assert.equal(normalizeSettings({ sshEnabled: "true" }).sshEnabled, false);
});
