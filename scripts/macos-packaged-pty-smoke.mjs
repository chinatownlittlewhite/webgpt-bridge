import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 50;

function delay(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function transcriptFrom(chunks = []) {
  return chunks.map((chunk) => String(chunk.text ?? "")).join("");
}

function assertNoPtyFailure(label, transcript) {
  if (/posix_spawnp failed|spawn_error/i.test(transcript)) {
    throw new Error(`${label} PTY reported a spawn failure: ${transcript}`);
  }
}

async function waitFor(manager, processId, predicate, {
  cursor = 0,
  transcript = "",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let nextCursor = cursor;
  let output = transcript;
  let snapshot = null;
  while (Date.now() <= deadline) {
    snapshot = manager.poll({ processId, cursor: nextCursor, maxChunks: 100 });
    output += transcriptFrom(snapshot.chunks);
    nextCursor = snapshot.nextCursor ?? nextCursor;
    if (predicate(snapshot, output)) return { snapshot, transcript: output, cursor: nextCursor };
    await delay(pollIntervalMs);
  }
  throw new Error(`timed out waiting for packaged PTY process ${processId}; transcript=${JSON.stringify(output)}`);
}

export async function runPtyCase(manager, {
  label,
  argv,
  input,
  readyMarker,
  inputMarker,
  killAfterInput,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}) {
  const trustedContext = { requestApproval: async () => true };
  const started = await manager.start({ argv, cwd: ".", pty: true, cols: 120, rows: 30 }, trustedContext);
  if (started.status !== "running" || started.pty !== true || !started.processId) {
    throw new Error(`${label} PTY failed to start: ${JSON.stringify(started)}`);
  }

  let state = await waitFor(
    manager,
    started.processId,
    (_snapshot, transcript) => transcript.includes(readyMarker),
    { timeoutMs, pollIntervalMs },
  );
  assertNoPtyFailure(label, state.transcript);

  const written = manager.input({ processId: started.processId, data: input });
  if (written.status !== "written") throw new Error(`${label} PTY stdin failed: ${JSON.stringify(written)}`);

  state = await waitFor(
    manager,
    started.processId,
    (_snapshot, transcript) => transcript.includes(inputMarker),
    { cursor: state.cursor, transcript: state.transcript, timeoutMs, pollIntervalMs },
  );
  assertNoPtyFailure(label, state.transcript);

  if (killAfterInput) {
    const killed = await manager.kill({ processId: started.processId, force: true });
    if (killed.status !== "kill_requested" && killed.status !== "already_terminal") {
      throw new Error(`${label} PTY kill failed: ${JSON.stringify(killed)}`);
    }
  }

  state = await waitFor(
    manager,
    started.processId,
    (snapshot) => snapshot.status !== "running",
    { cursor: state.cursor, transcript: state.transcript, timeoutMs, pollIntervalMs },
  );
  assertNoPtyFailure(label, state.transcript);
  if (!killAfterInput && state.snapshot.exitCode !== 0) {
    throw new Error(`${label} PTY exited non-zero: ${JSON.stringify(state.snapshot)}`);
  }
  return state;
}

export async function runPackagedPtySmoke(appRoot, options = {}) {
  if (!appRoot || !path.isAbsolute(appRoot)) throw new TypeError("packaged macOS app root must be absolute");
  const runtimeRoot = path.join(
    appRoot,
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "agent-runtime",
  );
  const processManagerPath = path.join(runtimeRoot, "dist", "process-manager.js");
  if (!fs.statSync(processManagerPath).isFile()) throw new Error(`packaged process manager missing: ${processManagerPath}`);

  const { createProcessManager } = await import(pathToFileURL(processManagerPath).href);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "webgpt-packaged-pty-"));
  const manager = createProcessManager({ workspace, platform: process.platform });
  try {
    const common = {
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    };
    const nodeResult = await runPtyCase(manager, {
      label: "node",
      argv: [
        "node",
        "-e",
        "process.stdout.write('NODE_PTY_READY\\n'); process.stdin.once('data', (data) => { process.stdout.write('NODE_PTY_INPUT:' + data.toString().trim() + '\\n'); process.exit(0); }); setInterval(() => {}, 1000);",
      ],
      input: "node-ok\n",
      readyMarker: "NODE_PTY_READY",
      inputMarker: "NODE_PTY_INPUT:node-ok",
      killAfterInput: false,
      ...common,
    });
    const shellResult = await runPtyCase(manager, {
      label: "shell",
      argv: [
        "zsh",
        "-lc",
        "printf 'SHELL_PTY_READY\\n'; IFS= read -r line; printf 'SHELL_PTY_INPUT:%s\\n' \"$line\"; sleep 30",
      ],
      input: "shell-ok\n",
      readyMarker: "SHELL_PTY_READY",
      inputMarker: "SHELL_PTY_INPUT:shell-ok",
      killAfterInput: true,
      ...common,
    });
    return { node: nodeResult, shell: shellResult };
  } finally {
    await manager.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  if (process.platform !== "darwin") {
    console.error("macOS packaged PTY smoke must run on macOS");
    process.exit(2);
  }
  const appRoot = process.argv[2];
  if (!appRoot) {
    console.error("Usage: node scripts/macos-packaged-pty-smoke.mjs <path-to-app>");
    process.exit(2);
  }
  try {
    const result = await runPackagedPtySmoke(path.resolve(appRoot));
    console.log(`packaged macOS PTY smoke OK (node=${result.node.snapshot.status}, shell=${result.shell.snapshot.status})`);
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  }
}
