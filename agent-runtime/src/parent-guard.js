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
  detached: false,
  windowsHide: true,
  stdio: "inherit",
});

let finished = false;
function parentAlive() {
  try {
    process.kill(parentPid, 0);
    return true;
  } catch {
    return false;
  }
}

function killGuardGroup() {
  if (finished) return;
  finished = true;
  try {
    process.kill(-process.pid, "SIGKILL");
    return;
  } catch {}
  try { child.kill("SIGKILL"); } catch {}
  process.exit(137);
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
  if (typeof code === "number") process.exit(code);
  process.exit(signal ? 128 : 1);
});
