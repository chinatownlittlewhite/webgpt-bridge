import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startProductionServer } from "../src/server.js";
import { INTERNAL_STATE_DIR } from "../src/workspace.js";

function shouldSkipLoopbackServerApproval({
  platform = process.platform,
  localAppData = process.env.LOCALAPPDATA,
  cwd = process.cwd(),
} = {}) {
  if (platform !== "win32" || typeof localAppData !== "string" || localAppData.length === 0) return false;
  const expectedLocalAppData = path.win32.join(
    path.win32.resolve(cwd),
    INTERNAL_STATE_DIR,
    "windows-profile",
    "AppData",
    "Local",
  );
  return path.win32.resolve(localAppData).toLowerCase() === expectedLocalAppData.toLowerCase();
}

test("loopback-only server approval test skips only in a nested Windows runner environment", () => {
  assert.equal(shouldSkipLoopbackServerApproval({
    platform: "win32",
    localAppData: "C:\\project\\.webgpt-bridge\\windows-profile\\AppData\\Local",
    cwd: "C:\\project",
  }), true);
  assert.equal(shouldSkipLoopbackServerApproval({
    platform: "win32",
    localAppData: "C:\\Users\\runner\\AppData\\Local",
    cwd: "C:\\project",
  }), false);
  assert.equal(shouldSkipLoopbackServerApproval({
    platform: "darwin",
    localAppData: "/project/.webgpt-bridge/windows-profile/AppData/Local",
    cwd: "/project",
  }), false);
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
