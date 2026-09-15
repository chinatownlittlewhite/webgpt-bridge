const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("desktop UI exposes default-off SSH settings with explicit safety copy", () => {
  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "src", "renderer", "index.html"), "utf8");
  const renderer = fs.readFileSync(path.join(root, "src", "renderer", "renderer.js"), "utf8");
  assert.match(html, /id="sshEnabled"/);
  assert.match(html, /id="sshAllowedHosts"/);
  assert.match(html, /SSH[^<]{0,100}(默认|关闭)|默认[^<]{0,100}SSH[^<]{0,100}关闭/i);
  assert.match(html, /private|local|私有|本地/i);
  assert.match(html, /allowlist|白名单|允许列表/i);
  assert.match(html, /非交互|noninteractive/i);
  assert.match(html, /scp/);
  assert.match(html, /sftp/);
  assert.match(html, /转发|forward/i);
  assert.match(renderer, /sshEnabled/);
  assert.match(renderer, /sshAllowedHosts/);
  assert.match(renderer, /split\(\/\[\\n,\]\+\//);
  assert.match(renderer, /join\("\\n"\)/);
});

test("desktop host binds SSH only through fixed platform system executables and passes allowlist into validation", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.cjs"), "utf8");
  const settingsStore = fs.readFileSync(path.join(__dirname, "..", "src", "host", "settings-store.cjs"), "utf8");
  const broker = fs.readFileSync(path.join(__dirname, "..", "src", "host", "broker-server.cjs"), "utf8");
  assert.match(settingsStore, /sshEnabled:\s*false/);
  assert.match(settingsStore, /sshAllowedHosts:\s*\[\]/);
  assert.match(main, /createHostBrokerServer/);
  assert.match(broker, /function\s+resolveSshExecutable/);
  assert.match(broker, /\/usr\/bin\/ssh/);
  assert.match(broker, /System32[\s\S]{0,120}OpenSSH[\s\S]{0,120}ssh\.exe/);
  assert.match(broker, /resolveSshExecutable\(\{\s*enabled:\s*settings\.sshEnabled/);
  assert.match(broker, /validateSshCommand/);
  assert.match(broker, /allowedHosts:\s*settings\.sshAllowedHosts/);
});
