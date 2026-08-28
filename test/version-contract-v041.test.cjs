const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

test("v0.4.7 desktop and v0.9.1 Agent versions are explicit and synchronized with runtime metadata", () => {
  const desktop = require(path.join(root, "package.json"));
  const desktopLock = require(path.join(root, "package-lock.json"));
  const agent = require(path.join(root, "agent-runtime", "package.json"));
  const agentLock = require(path.join(root, "agent-runtime", "package-lock.json"));
  const server = fs.readFileSync(path.join(root, "agent-runtime", "src", "server.js"), "utf8");
  assert.equal(desktop.version, "0.4.7");
  assert.equal(desktopLock.version, "0.4.7");
  assert.equal(desktopLock.packages[""].version, "0.4.7");
  assert.equal(agent.version, "0.9.1");
  assert.equal(agentLock.version, "0.9.1");
  assert.equal(agentLock.packages[""].version, "0.9.1");
  assert.match(server, /const VERSION = "0\.9\.1"/);
});
