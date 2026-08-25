import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

if (process.platform !== "win32") {
  console.log(`Native helper build skipped on ${process.platform}; Windows helper is built on Windows hosts.`);
  process.exit(0);
}

const nativeProjects = [
  {
    name: "Windows native sandbox",
    project: path.resolve("native/windows-sandbox/LocalProjectCoding.WindowsSandbox.csproj"),
    output: path.resolve("native/windows-sandbox/bin/release"),
    executable: "lpc-windows-sandbox.exe",
  },
  {
    name: "Windows host preparation",
    project: path.resolve("native/windows-host-prep/LocalProjectCoding.WindowsHostPrep.csproj"),
    output: path.resolve("native/windows-host-prep/bin/release"),
    executable: "lpc-windows-host-prep.exe",
  },
];

for (const nativeProject of nativeProjects) {
  fs.mkdirSync(nativeProject.output, { recursive: true });
  const result = spawnSync(
    "dotnet",
    ["publish", nativeProject.project, "-c", "Release", "-r", "win-x64", "-o", nativeProject.output, "--self-contained", "true"],
    {
      stdio: "inherit",
      shell: false,
      windowsHide: true,
    },
  );
  if (result.error) {
    console.error(`${nativeProject.name} build failed: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);

  const helper = path.join(nativeProject.output, nativeProject.executable);
  if (!fs.existsSync(helper)) {
    console.error(`${nativeProject.name} build did not produce ${helper}`);
    process.exit(1);
  }
  console.log(`Built ${helper}`);
}
