import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { resolveGitHubCli } from "../src/github-cli.js";
import { probeWindowsHostPreparation } from "../src/native-sandbox.js";

const require = createRequire(import.meta.url);
const problems = [];
const warnings = [];
const checks = [];

function check(label, ok, detail, required = true) {
  checks.push({ label, ok, detail, required });
  if (!ok) (required ? problems : warnings).push(`${label}: ${detail}`);
}

function commandVersion(command, args = ["--version"]) {
  const result = spawnSync(command, args, { encoding: "utf8", shell: false, windowsHide: true, timeout: 10_000 });
  if (result.error) return { ok: false, detail: result.error.message };
  return {
    ok: result.status === 0,
    detail: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split("\n")[0] || `exit ${result.status}`,
  };
}

function packageAvailable(name, required = true) {
  try {
    const resolved = require.resolve(name);
    check(`package ${name}`, true, resolved, required);
  } catch (error) {
    check(`package ${name}`, false, error.message, required);
  }
}

const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
check("project version", packageJson.version === "0.9.3", packageJson.version, true);
check("Node >=20", Number(process.versions.node.split(".")[0]) >= 20, process.version, true);
packageAvailable("@modelcontextprotocol/server", true);
packageAvailable("@modelcontextprotocol/node", true);
packageAvailable("@modelcontextprotocol/client", true);
packageAvailable("node-pty", false);

const git = commandVersion("git");
check("git", git.ok, git.detail, true);
const gh = resolveGitHubCli({ explicitPath: process.env.LPC_GITHUB_CLI_PATH ?? "" });
check(
  "GitHub CLI (optional)",
  gh.status === "ready",
  gh.status === "ready" ? `${gh.version} @ ${gh.resolvedPath}` : `${gh.status}: ${gh.reason}`,
  false,
);

const workspace = path.resolve(process.env.LPC_WORKSPACE ?? process.cwd());
check("workspace exists", fs.existsSync(workspace) && fs.statSync(workspace).isDirectory(), workspace, true);

if (process.platform === "win32") {
  const helper = path.resolve(process.env.LPC_WINDOWS_SANDBOX_HELPER ?? "native/windows-host/bin/release/lpc-windows-host.exe");
  check("Windows AppContainer sandbox helper", fs.existsSync(helper), helper, true);
  const hostPreparation = probeWindowsHostPreparation({
    platform: "win32",
    helperPath: process.env.LPC_WINDOWS_HOST_PREP
      ? path.resolve(process.env.LPC_WINDOWS_HOST_PREP)
      : path.resolve("native/windows-host/bin/release/lpc-windows-host.exe"),
  });
  check(
    "Windows host preparation",
    hostPreparation.status === "ready",
    `${hostPreparation.status}: ${hostPreparation.reason}`,
    true,
  );
  const taskkill = path.join(process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows", "System32", "taskkill.exe");
  check("Windows taskkill", fs.existsSync(taskkill), taskkill, true);
} else if (process.platform === "darwin") {
  check("macOS Seatbelt launcher", fs.existsSync("/usr/bin/sandbox-exec"), "/usr/bin/sandbox-exec", true);
  warnings.push("macOS sandbox-exec is a deprecated launcher; v0.9 acceptance requires the resulting Seatbelt policy to pass the real sandbox probe before unattended execution.");
} else if (process.platform === "linux") {
  const bwrap = commandVersion("bwrap");
  check("Bubblewrap", bwrap.ok, bwrap.detail, true);
} else {
  check("native sandbox backend", false, `unsupported platform ${process.platform}`, true);
}

console.log(JSON.stringify({
  ok: problems.length === 0,
  version: packageJson.version,
  platform: process.platform,
  workspace,
  checks,
  warnings,
  problems,
}, null, 2));

process.exitCode = problems.length === 0 ? 0 : 1;
