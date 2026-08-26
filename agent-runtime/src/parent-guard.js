import { spawn } from "node:child_process";

function fail(message) {
  console.error(`lpc-parent-guard: ${message}`);
  process.exit(125);
}

const separator = process.argv.indexOf("--");
if (separator < 0 || separator + 1 >= process.argv.length) fail("missing command after --");
const parentPid = Number(process.argv[2]);
if (!Number.isInteger(parentPid) || parentPid < 1) fail("invalid parent pid");
const argv = process.argv.slice(separator + 1);

const child = spawn(argv[0], argv.slice(1), {
  shell: false,
  detached: true,
  windowsHide: true,
  stdio: "inherit",
});

let finished = false;
let shuttingDown = false;
let forceExitTimer = null;
function parentAlive() {
  try {
    process.kill(parentPid, 0);
    return true;
  } catch {
    return false;
  }
}

function killGuardGroup() {
  if (finished || shuttingDown) return;
  shuttingDown = true;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch {
      finished = true;
      process.exit(137);
    }
  }
  forceExitTimer = setTimeout(() => process.exit(137), 2_000);
  forceExitTimer.unref();
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.once(signal, killGuardGroup);
}

const timer = setInterval(() => {
  if (!parentAlive()) killGuardGroup();
}, 250);
timer.unref();

child.once("error", (error) => {
  clearInterval(timer);
  console.error(`lpc-parent-guard: ${error.message}`);
  process.exit(125);
});

child.once("close", (code, signal) => {
  finished = true;
  clearInterval(timer);
  if (forceExitTimer) clearTimeout(forceExitTimer);
  if (shuttingDown) process.exit(137);
  if (typeof code === "number") process.exit(code);
  process.exit(signal ? 128 : 1);
});
