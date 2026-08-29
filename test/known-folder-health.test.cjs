const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function requireHelper(name) {
  const modulePath = path.join(__dirname, "..", "src", name);
  assert.equal(fs.existsSync(modulePath), true, `${name} must exist`);
  return require(modulePath);
}

test("known-folder access is limited to desktop/downloads/documents, relative paths, and explicit authorization", async () => {
  const { createKnownFolderAccess } = requireHelper("known-folder-access.cjs");
  const calls = [];
  const fileBroker = {
    list: (input) => { calls.push(["list", input]); return input; },
    read: (input) => { calls.push(["read", input]); return input; },
  };
  const authorizations = [];
  let accessIndex = 0;
  const access = createKnownFolderAccess({
    roots: { desktop: "/Users/test/Desktop", downloads: "/Users/test/Downloads", documents: "/Users/test/Documents" },
    fileBroker,
    issueCapability: async (request) => { authorizations.push(request); return { accessId: `known-${++accessIndex}` }; },
  });

  await access.list({ folder: "desktop", relativePath: "project", depth: 2 });
  await access.read({ folder: "documents", relativePath: "notes/todo.txt", startLine: 3, maxLines: 20 });
  assert.equal(calls[0][1].path, path.join("/Users/test/Desktop", "project"));
  assert.equal(calls[0][1].depth, 2);
  assert.equal(calls[0][1].accessId, "known-1");
  assert.equal(calls[1][1].path, path.join("/Users/test/Documents", "notes", "todo.txt"));
  assert.equal(calls[1][1].startLine, 3);
  assert.equal(calls[1][1].accessId, "known-2");
  assert.deepEqual(authorizations.map(({ folder, operation }) => ({ folder, operation })), [
    { folder: "desktop", operation: "list" },
    { folder: "documents", operation: "read" },
  ]);
  await assert.rejects(access.list({ folder: "home", relativePath: "" }), /desktop|downloads|documents/i);
  await assert.rejects(access.read({ folder: "desktop", relativePath: "/etc/hosts" }), /relative|相对/i);
  await assert.rejects(access.read({ folder: "desktop", relativePath: "../secret" }), /relative|相对/i);

  const denied = createKnownFolderAccess({
    roots: { desktop: "/Users/test/Desktop", downloads: "/Users/test/Downloads", documents: "/Users/test/Documents" },
    fileBroker,
    issueCapability: async () => { throw new Error("known-folder 访问未获得用户授权。"); },
  });
  await assert.rejects(denied.read({ folder: "desktop", relativePath: "personal.txt" }), /授权|authorize|denied/i);
  assert.equal(calls.length, 2, "denied known-folder access must not reach the file broker");
});

test("desktop host wires actual runtime endpoints and authenticated GitHub health", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "host", "broker-server.cjs"), "utf8");
  assert.match(source, /createLoopbackHealthProbe\(\{[\s\S]*mcpHost[\s\S]*mcpPort[\s\S]*tunnelHealthHost[\s\S]*tunnelHealthPort[\s\S]*githubProbe/);
});

test("health probe accepts only fixed agent, tunnel, and github targets", async () => {
  const { createLoopbackHealthProbe } = requireHelper("loopback-health-probe.cjs");
  const calls = [];
  const probe = createLoopbackHealthProbe({
    httpProbe: async (target) => { calls.push(["http", target]); return { ok: true, statusCode: 200 }; },
    githubProbe: async () => { calls.push(["github-auth"]); return { ok: false, connectivity: true, binaryReady: true, authenticated: false }; },
  });

  const agent = await probe.probe({ target: "agent" });
  const tunnel = await probe.probe({ target: "tunnel" });
  const github = await probe.probe({ target: "github" });
  assert.deepEqual(calls, [
    ["http", { host: "127.0.0.1", port: 8787, path: "/healthz" }],
    ["http", { host: "127.0.0.1", port: 8080, path: "/readyz" }],
    ["github-auth"],
  ]);
  assert.equal(agent.target, "agent");
  assert.equal(tunnel.target, "tunnel");
  assert.equal(github.target, "github");
  assert.equal(github.ok, false);
  assert.equal(github.connectivity, true);
  assert.equal(github.authenticated, false);
  await assert.rejects(probe.probe({ target: "https://example.com/health" }), /agent|tunnel|github/i);

  const customCalls = [];
  const custom = createLoopbackHealthProbe({
    targets: {
      agent: { kind: "http", host: "127.0.0.1", port: 4999, path: "/healthz" },
      tunnel: { kind: "http", host: "127.0.0.1", port: 5999, path: "/readyz" },
    },
    httpProbe: async (target) => { customCalls.push(target); return { ok: true, statusCode: 200 }; },
    githubProbe: async () => ({ ok: true, connectivity: true, binaryReady: true, authenticated: true }),
  });
  await custom.probe({ target: "agent" });
  await custom.probe({ target: "tunnel" });
  assert.deepEqual(customCalls, [
    { host: "127.0.0.1", port: 4999, path: "/healthz" },
    { host: "127.0.0.1", port: 5999, path: "/readyz" },
  ]);
});
