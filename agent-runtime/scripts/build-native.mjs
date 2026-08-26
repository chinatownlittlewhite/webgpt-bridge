import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

if (process.platform !== "win32") {
  console.log(`Native helper build skipped on ${process.platform}; Windows helper is built on Windows hosts.`);
  process.exit(0);
}

const project = path.resolve("native/windows-host/LocalProjectCoding.WindowsHost.csproj");
const output = path.resolve("native/windows-host/bin/release");
const executable = path.join(output, "lpc-windows-host.exe");

function publish(extraArgs) {
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  return spawnSync(
    "dotnet",
    ["publish", project, "-c", "Release", "-r", "win-x64", "-o", output, "--self-contained", "true", ...extraArgs],
    { stdio: "inherit", shell: false, windowsHide: true },
  );
}

let result = publish(["-p:PublishAot=true", "-p:StripSymbols=true", "-p:IlcOptimizationPreference=Size"]);
if (result.error) {
  console.error(`Windows native host build failed: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.warn("NativeAOT publish was unavailable; falling back to one self-contained single-file Windows host.");
  result = publish(["-p:PublishSingleFile=true", "-p:DebugType=None", "-p:DebugSymbols=false"]);
}
if (result.error) {
  console.error(`Windows native host fallback build failed: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);
if (!fs.existsSync(executable)) {
  console.error(`Windows native host build did not produce ${executable}`);
  process.exit(1);
}
console.log(`Built ${executable}`);
