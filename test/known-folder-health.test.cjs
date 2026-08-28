const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function requireHelper(name) {
  const modulePath = path.join(__dirname, "..", "src", name);
  assert.equal(fs.existsSync(modulePath), true, `${name} must exist`);
  return require(modulePath);
}

test("known-folder access is limited to desktop/downloads/documents and relative paths", () => {
  const { createKnownFolderAccess } = requireHelper("known-folder-access.cjs");
  const calls = [];
  const fileBroker = {
    list: (input) => { calls.push(["list", input]); return input; },
    read: (input) => { calls.push(["read", input]); return input; },
  };
  const access = createKnownFolderAccess({
    roots: { desktop: "/Users/test/Desktop", downloads: "/Users/test/Downloads", documents: "/Users/test/Documents" },
    fileBroker,
  });

  access.list({ folder: "desktop", relativePath: "project", depth: 2 });
  access.read({ folder: "documents", relativePath: "notes/todo.txt", startLine: 3, maxLines: 20 });
  assert.equal(calls[0][1].path, path.join("/Users/test/Desktop", "project"));
  assert.equal(calls[0][1].depth, 2);
  assert.equal(calls[1][1].path, path.join("/Users/test/Documents", "notes", "todo.txt"));
  assert.equal(calls[1][1].startLine, 3);
  assert.throws(() => access.list({ folder: "home", relativePath: "" }), /desktop|downloads|documents/i);
  assert.throws(() => access.read({ folder: "desktop", relativePath: "/etc/hosts" }), /relative|相对/i);
  assert.throws(() => access.read({ folder: "desktop", relativePath: "../secret" }), /relative|相对/i);
});

test("health probe accepts only fixed agent, tunnel, and github targets", async () => {
  const { createLoopbackHealthProbe } = requireHelper("loopback-health-probe.cjs");
  const calls = [];
  const probe = createLoopbackHealthProbe({
    httpProbe: async (target) => { calls.push(["http", target]); return { ok: true, statusCode: 200 }; },
    tcpProbe: async (target) => { calls.push(["tcp", target]); return { ok: true }; },
  });

  const agent = await probe.probe({ target: "agent" });
  const tunnel = await probe.probe({ target: "tunnel" });
  const github = await probe.probe({ target: "github" });
  assert.deepEqual(calls, [
    ["http", { host: "127.0.0.1", port: 8765, path: "/health" }],
    ["http", { host: "127.0.0.1", port: 8766, path: "/health" }],
    ["tcp", { host: "github.com", port: 443 }],
  ]);
  assert.equal(agent.target, "agent");
  assert.equal(tunnel.target, "tunnel");
  assert.equal(github.target, "github");
  await assert.rejects(probe.probe({ target: "https://example.com/health" }), /agent|tunnel|github/i);
});
