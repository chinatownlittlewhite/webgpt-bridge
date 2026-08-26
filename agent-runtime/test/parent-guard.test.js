import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const guard = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "parent-guard.js");

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test("parent guard converts SIGTERM into descendant cleanup", async (t) => {
  if (process.platform === "win32") {
    t.skip("parent guard is a POSIX process-group fallback");
    return;
  }
  const configuredHome = process.env.HOME ? path.resolve(process.env.HOME) : "";
  const accountHome = path.resolve(os.userInfo().homedir);
  if (process.platform === "darwin" && configuredHome && configuredHome !== accountHome) {
    t.skip("nested Seatbelt allows signaling only self; desktop acceptance verifies the host-side parent guard");
    return;
  }
  const guarded = spawn(process.execPath, [
    guard,
    String(process.pid),
    "--",
    process.execPath,
    "-e",
    "console.log(process.pid); setInterval(() => {}, 1000)",
  ], { stdio: ["ignore", "pipe", "pipe"], detached: true });
  let childPid = null;
  try {
    childPid = await new Promise((resolve, reject) => {
      let text = "";
      const timer = setTimeout(() => reject(new Error("guarded child did not report pid")), 3000);
      guarded.stdout.on("data", (chunk) => {
        text += chunk.toString("utf8");
        const match = text.match(/(\d+)/);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
      guarded.once("error", reject);
    });
    assert.equal(alive(childPid), true);
    guarded.kill("SIGTERM");
    await new Promise((resolve) => guarded.once("close", resolve));
    for (let i = 0; i < 40 && alive(childPid); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(alive(childPid), false, "SIGTERM to the guard must not orphan the guarded child");
  } finally {
    if (alive(childPid)) { try { process.kill(childPid, "SIGKILL"); } catch {} }
    if (alive(guarded.pid)) { try { process.kill(-guarded.pid, "SIGKILL"); } catch {} }
  }
});
