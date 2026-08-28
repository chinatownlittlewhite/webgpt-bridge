import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { findExecutableInPath } from "./platform.js";

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function defaultVersionProbe(executable) {
  const result = spawnSync(executable, ["--version"], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 10_000,
  });
  if (result.error) return { ok: false, detail: result.error.message };
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.status !== 0) return { ok: false, detail: output || `exit ${result.status}` };
  const firstLine = output.split("\n")[0] || "";
  const match = firstLine.match(/\bgh version\s+([^\s]+)/i);
  return { ok: true, version: match?.[1] ?? firstLine, detail: firstLine };
}

function defaultAuthProbe(executable) {
  const result = spawnSync(executable, ["auth", "status"], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 10_000,
  });
  return { authenticated: !result.error && result.status === 0 };
}

function windowsCandidates(env) {
  const candidates = [];
  if (env.ProgramFiles) candidates.push(path.win32.join(env.ProgramFiles, "GitHub CLI", "gh.exe"));
  if (env.LOCALAPPDATA) {
    candidates.push(path.win32.join(env.LOCALAPPDATA, "Programs", "GitHub CLI", "gh.exe"));
    candidates.push(path.win32.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", "gh.exe"));
  }
  return candidates;
}

export function resolveGitHubCli({
  platform = process.platform,
  env = process.env,
  explicitPath = env.LPC_GITHUB_CLI_PATH ?? "",
  exists = fs.existsSync,
  findInPath = (name) => findExecutableInPath(name, { env, platform }),
  runVersion = defaultVersionProbe,
  runAuth = defaultAuthProbe,
} = {}) {
  const candidates = unique([
    explicitPath,
    ...(platform === "win32" ? windowsCandidates(env) : []),
    findInPath("gh"),
  ]);

  for (const candidate of candidates) {
    if (!exists(candidate)) continue;
    const probe = runVersion(candidate);
    if (!probe?.ok) {
      return Object.freeze({
        status: "broken",
        resolvedPath: candidate,
        version: null,
        reason: `GitHub CLI exists at ${candidate} but failed version probe: ${probe?.detail ?? "unknown error"}`,
        remediation: "Repair or reinstall GitHub CLI, then restart WebGPT Bridge.",
      });
    }
    const version = probe.version ?? probe.detail ?? "unknown";
    const auth = runAuth(candidate);
    if (auth?.authenticated !== true) {
      return Object.freeze({
        status: "unauthenticated",
        resolvedPath: candidate,
        version,
        authStatus: "unauthenticated",
        usable: false,
        reason: `GitHub CLI ${version} is installed but not authenticated`,
        remediation: "Run gh auth login for this desktop user, then restart WebGPT Bridge.",
      });
    }
    return Object.freeze({
      status: "ready",
      resolvedPath: candidate,
      version,
      authStatus: "authenticated",
      usable: true,
      reason: `GitHub CLI ${version} is available and authenticated`,
      remediation: null,
    });
  }

  return Object.freeze({
    status: "missing",
    resolvedPath: null,
    version: null,
    reason: "GitHub CLI was not found in trusted application, standard Windows, or PATH locations",
    remediation: "Install GitHub CLI, then restart WebGPT Bridge so the executable can be resolved again.",
  });
}
