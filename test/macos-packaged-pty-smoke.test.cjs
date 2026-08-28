const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

async function importSmoke() {
  return import("../scripts/macos-packaged-pty-smoke.mjs");
}

function fakeManager() {
  const calls = [];
  let pollCount = 0;
  return {
    calls,
    async start(input, trustedContext) {
      calls.push({ method: "start", input, trustedContext });
      return { status: "running", processId: "p1", pty: input.pty };
    },
    poll({ processId, cursor }) {
      calls.push({ method: "poll", processId, cursor });
      pollCount += 1;
      if (pollCount === 1) {
        return { status: "running", processId, chunks: [{ sequence: 1, stream: "pty", text: "READY\r\n" }], nextCursor: 1 };
      }
      if (pollCount === 2) {
        return { status: "running", processId, chunks: [{ sequence: 2, stream: "pty", text: "INPUT:ok\r\n" }], nextCursor: 2 };
      }
      return { status: "exited", processId, chunks: [], nextCursor: cursor, exitCode: 0 };
    },
    input({ processId, data }) {
      calls.push({ method: "input", processId, data });
      return { status: "written" };
    },
    async kill({ processId, force }) {
      calls.push({ method: "kill", processId, force });
      return { status: "kill_requested" };
    },
    async close() {
      calls.push({ method: "close" });
    },
  };
}

test("PTY smoke case starts through process manager with pty:true and writes stdin", async () => {
  const { runPtyCase } = await importSmoke();
  const manager = fakeManager();
  const result = await runPtyCase(manager, {
    label: "contract",
    argv: ["node", "-e", "process.exit(0)"],
    input: "ok\n",
    readyMarker: "READY",
    inputMarker: "INPUT:ok",
    killAfterInput: false,
    pollIntervalMs: 0,
    timeoutMs: 1000,
  });
  const start = manager.calls.find((call) => call.method === "start");
  assert.equal(start.input.pty, true);
  assert.deepEqual(start.input.argv, ["node", "-e", "process.exit(0)"]);
  assert.equal(typeof start.trustedContext.requestApproval, "function");
  assert.equal(await start.trustedContext.requestApproval({}), true);
  assert.ok(manager.calls.some((call) => call.method === "input" && call.data === "ok\n"));
  assert.match(result.transcript, /READY/);
  assert.match(result.transcript, /INPUT:ok/);
});

test("packaged smoke source imports the packaged process manager instead of directly importing node-pty", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "scripts", "macos-packaged-pty-smoke.mjs"), "utf8");
  assert.match(source, /app\.asar\.unpacked[\s\S]*agent-runtime[\s\S]*dist[\s\S]*process-manager\.js/);
  assert.doesNotMatch(source, /(?:from\s+|import\s*\()\s*["']node-pty["']/);
});
