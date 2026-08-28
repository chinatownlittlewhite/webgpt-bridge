const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { normalizeSettings } = require("../src/host-config.cjs");

test("explicit HTTPS proxy accepts a bare port and rejects unsafe URLs", () => {
  assert.equal(normalizeSettings({ httpsProxy: "12001" }).httpsProxy, "http://127.0.0.1:12001");
  assert.equal(normalizeSettings({ httpsProxy: " http://127.0.0.1:7890 " }).httpsProxy, "http://127.0.0.1:7890");
  assert.throws(() => normalizeSettings({ httpsProxy: "http://user:pass@127.0.0.1:7890" }), /凭据|credential/i);
  assert.throws(() => normalizeSettings({ httpsProxy: "http://127.0.0.1:7890/path" }), /路径|path/i);
  assert.throws(() => normalizeSettings({ httpsProxy: "socks5://127.0.0.1:7890" }), /协议|protocol/i);
  assert.throws(() => normalizeSettings({ httpsProxy: "70000" }), /端口|port/i);
});

test("proxy setting copy promises automatic use for Tunnel and controlled external network commands", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "index.html"), "utf8");
  assert.match(html, /代理[\s\S]{0,500}(Tunnel|tunnel)[\s\S]{0,200}受控[\s\S]{0,120}(联网|网络)[\s\S]{0,120}自动/);
  assert.match(html, /(127\.0\.0\.1|localhost|loopback|本地).*不.*代理|不.*代理.*(127\.0\.0\.1|localhost|loopback|本地)/i);
});
