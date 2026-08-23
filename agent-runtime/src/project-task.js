import fs from "node:fs";
import path from "node:path";
import { createCommandRunner } from "./runner.js";
import { resolveWorkspaceCwd } from "./workspace.js";

const TASKS = new Set(["test", "lint", "build", "typecheck", "check"]);

export function discoverProjectTask({ workspace, cwd = ".", task } = {}) {
  if (!TASKS.has(task)) throw new Error(`unsupported project task: ${task}`);
  const { cwd: projectRoot } = resolveWorkspaceCwd(workspace, cwd);

  const packageJsonPath = path.join(projectRoot, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    if (packageJson.scripts && typeof packageJson.scripts[task] === "string") {
      return task === "test"
        ? { argv: ["npm", "test"], ecosystem: "node" }
        : { argv: ["npm", "run", task], ecosystem: "node" };
    }
  }

  if (fs.existsSync(path.join(projectRoot, "pyproject.toml"))) {
    if (task === "test") return { argv: ["python3", "-m", "pytest"], ecosystem: "python" };
    if (task === "lint") return { argv: ["python3", "-m", "ruff", "check", "."], ecosystem: "python" };
  }

  if (fs.existsSync(path.join(projectRoot, "Cargo.toml"))) {
    if (task === "test") return { argv: ["cargo", "test"], ecosystem: "rust" };
    if (task === "check" || task === "typecheck") {
      return { argv: ["cargo", "check"], ecosystem: "rust" };
    }
  }

  if (fs.existsSync(path.join(projectRoot, "go.mod")) && task === "test") {
    return { argv: ["go", "test", "./..."], ecosystem: "go" };
  }

  if (fs.existsSync(path.join(projectRoot, "Makefile"))) {
    return { argv: ["make", task], ecosystem: "make" };
  }

  throw new Error(`no safe '${task}' task was found in ${cwd}`);
}

export function createProjectTaskRunner({
  workspace,
  timeoutMs = 120_000,
  sandboxAdapter,
  platform = process.platform,
  auditLogger,
} = {}) {
  return async function runProjectTask({ task, cwd = ".", env = {}, requestApproval } = {}) {
    const discovered = discoverProjectTask({ workspace, cwd, task });
    const run = createCommandRunner({ workspace, timeoutMs, sandboxAdapter, platform, auditLogger });
    const result = await run({
      argv: discovered.argv,
      cwd,
      env,
      requestApproval,
    });
    return { ...result, task, ecosystem: discovered.ecosystem };
  };
}
