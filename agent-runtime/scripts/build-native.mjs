import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

if (process.platform !== "win32") {
  console.log(`Native helper build skipped on ${process.platform}; Windows helper is built on Windows hosts.`);
  process.exit(0);
}

const project = path.resolve("native/windows-sandbox/LocalProjectCoding.WindowsSandbox.csproj");
const output = path.resolve("native/windows-sandbox/bin/release");
fs.mkdirSync(output, { recursive: true });

const result = spawnSync(
  "dotnet",
  ["publish", project, "-c", "Release", "-o", output, "--self-contained", "false"],
  {
    stdio: "inherit",
    shell: false,
    windowsHide: true,
  },
);

if (result.error) {
  console.error(`Windows native sandbox build failed: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);

const helper = path.join(output, "lpc-windows-sandbox.exe");
if (!fs.existsSync(helper)) {
  console.error(`Windows native sandbox build did not produce ${helper}`);
  process.exit(1);
}
console.log(`Built ${helper}`);
