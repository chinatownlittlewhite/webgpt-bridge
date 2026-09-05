const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("renderer derives online state from supervisor connected readiness", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "renderer.js"), "utf8");
  assert.match(source, /const connected = status\.connected === true;/);
  assert.match(source, /tunnelState[\s\S]{0,120}connected \? "已连接" : "未连接"/);
  assert.match(source, /connection\.className = `connection \$\{connected \? "online" : "offline"\}`/);
  assert.doesNotMatch(source, /connection\.className = `connection \$\{status\.tunnel \? "online" : "offline"\}`/);
});
