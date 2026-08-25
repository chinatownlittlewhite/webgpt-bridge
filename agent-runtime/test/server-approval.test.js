import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startProductionServer } from "../src/server.js";

function shouldSkipLoopbackServerApproval({ platform = process.platform, home = process.env.HOME, cwd = process.cwd() } = {}) {
  return platform === "win32" && home === cwd;
}

test("loopback-only server approval test skips only in a nested Windows sandbox", () => {
  assert.equal(shouldSkipLoopbackServerApproval({ platform: "win32", home: "C:\\project", cwd: "C:\\project" }), true);
  assert.equal(shouldSkipLoopbackServerApproval({ platform: "win32", home: "C:\\host", cwd: "C:\\project" }), false);
  assert.equal(shouldSkipLoopbackServerApproval({ platform: "darwin", home: "/project", cwd: "/project" }), false);
});

test("a command awaiting host approval is returned as a normal MCP tool result", async (t) => {
  if (shouldSkipLoopbackServerApproval()) {
    t.skip("nested Windows AppContainer intentionally may block localhost loopback");
    return;
  }
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "webgpt-server-approval-"));
  const server = await startProductionServer({ workspace, host: "127.0.0.1", port: 0, verifySandbox: false, installSignalHandlers: false });
  const client = new Client({ name: "server-approval-test", version: "0.9.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`));
  t.after(async () => {
    try { await transport.terminateSession(); } catch {}
    await client.close();
    await server.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  });
  await client.connect(transport);
  const result = await client.callTool({ name: "run_command", arguments: { argv: ["node", "-e", "process.exit(0)"] } });
  assert.equal(result.structuredContent.status, "approval_required");
  assert.notEqual(result.isError, true);
  assert.match(result.content[0].text, /approval_required/);
});
