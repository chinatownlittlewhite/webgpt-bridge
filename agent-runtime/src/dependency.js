import fs from "node:fs";
import path from "node:path";
import { createCommandRunner } from "./runner.js";
import { resolveWorkspaceCwd } from "./workspace.js";

export function discoverDependencySync({ workspace, cwd = ".", allowScripts = false } = {}) {
  const { cwd: root } = resolveWorkspaceCwd(workspace, cwd);

  if (fs.existsSync(path.join(root, "package.json"))) {
    if (fs.existsSync(path.join(root, "pnpm-lock.yaml"))) {
      return { ecosystem: "node-pnpm", argv: ["pnpm", "install", "--frozen-lockfile", ...(allowScripts ? [] : ["--ignore-scripts"]) ] };
    }
    if (fs.existsSync(path.join(root, "yarn.lock"))) {
      return { ecosystem: "node-yarn", argv: ["yarn", "install", "--immutable", ...(allowScripts ? [] : ["--ignore-scripts"]) ] };
    }
    const locked = fs.existsSync(path.join(root, "package-lock.json")) || fs.existsSync(path.join(root, "npm-shrinkwrap.json"));
    return {
      ecosystem: "node-npm",
      argv: ["npm", locked ? "ci" : "install", "--no-audit", "--no-fund", ...(allowScripts ? [] : ["--ignore-scripts"])],
    };
  }

  if (fs.existsSync(path.join(root, "requirements.txt"))) {
    return { ecosystem: "python-pip", argv: ["python3", "-m", "pip", "install", "--disable-pip-version-check", "--no-input", "-r", "requirements.txt"] };
  }
  if (fs.existsSync(path.join(root, "pyproject.toml"))) {
    return { ecosystem: "python-pip", argv: ["python3", "-m", "pip", "install", "--disable-pip-version-check", "--no-input", "."] };
  }
  if (fs.existsSync(path.join(root, "Cargo.toml"))) return { ecosystem: "rust", argv: ["cargo", "fetch"] };
  if (fs.existsSync(path.join(root, "go.mod"))) return { ecosystem: "go", argv: ["go", "mod", "download"] };
  throw new Error(`no supported dependency manifest was found in ${cwd}`);
}

export function createDependencySyncRunner({ workspace, sandboxAdapter, platform = process.platform, auditLogger, timeoutMs = 120_000 } = {}) {
  const run = createCommandRunner({ workspace, sandboxAdapter, platform, auditLogger, timeoutMs });
  return async function syncDependencies(input = {}, trustedContext = {}) {
    const discovered = discoverDependencySync({ workspace, cwd: input.cwd ?? ".", allowScripts: input.allowScripts === true });
    const result = await run({
      argv: discovered.argv,
      cwd: input.cwd ?? ".",
      env: { CI: "1" },
      requestApproval: trustedContext.requestApproval,
    });
    return { ...result, ecosystem: discovered.ecosystem, allowScripts: input.allowScripts === true };
  };
}
