import fs from "node:fs";
import path from "node:path";
import { createCommandRunner } from "./runner.js";
import { resolveModelWorkspaceCwd } from "./workspace.js";

const TASKS = new Set(["test", "lint", "build", "typecheck", "check"]);
const MAX_FAILURE_DIAGNOSTIC_BYTES = 4_096;
const FAILURE_MARKER = "[project-task failure excerpt]";

function boundedUtf8Prefix(value, maxBytes) {
  if (typeof value !== "string" || value.length === 0 || maxBytes <= 0) return "";
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}

function boundedUtf8Tail(value, maxBytes) {
  if (typeof value !== "string" || value.length === 0 || maxBytes <= 0) return "";
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return value;
  let start = buffer.length - maxBytes;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString("utf8");
}

function extractTapFailureBlock(stdout) {
  if (typeof stdout !== "string" || stdout.length === 0) return "";
  const lines = stdout.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*(?:#\s*)?not ok\b/.test(line));
  if (start < 0) return "";
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (/^\s*\.\.\.\s*$/.test(line)) {
      end += 1;
      break;
    }
    if (/^\s*(?:#\s*)?(?:ok|not ok)\b/.test(line) || /^\s*1\.\./.test(line)) break;
    end += 1;
  }
  return lines.slice(start, end).join("\n").trimEnd();
}

export function appendProjectTaskFailureDiagnostic(result) {
  if (!result || typeof result !== "object" || result.exitCode === 0) return result;
  const failureBlock = extractTapFailureBlock(result.stdout);
  if (!failureBlock) return result;

  const marker = `${FAILURE_MARKER}\n`;
  const excerptBudget = MAX_FAILURE_DIAGNOSTIC_BYTES - Buffer.byteLength(marker);
  const excerpt = boundedUtf8Prefix(failureBlock, excerptBudget);
  const diagnostic = `${marker}${excerpt}`;
  const separator = typeof result.stderr === "string" && result.stderr.length > 0 ? "\n" : "";
  const remaining = Math.max(
    0,
    MAX_FAILURE_DIAGNOSTIC_BYTES - Buffer.byteLength(separator) - Buffer.byteLength(diagnostic),
  );
  const stderrTail = boundedUtf8Tail(result.stderr, remaining);
  const stderr = `${stderrTail}${stderrTail ? separator : ""}${diagnostic}`;
  const stderrWasOmitted = typeof result.stderr === "string"
    && Buffer.byteLength(result.stderr) > Buffer.byteLength(stderrTail);

  return {
    ...result,
    stderr,
    stderrTruncated: result.stderrTruncated === true || stderrWasOmitted,
  };
}

export function discoverProjectTask({ workspace, cwd = ".", task } = {}) {
  if (!TASKS.has(task)) throw new Error(`unsupported project task: ${task}`);
  const { cwd: projectRoot } = resolveModelWorkspaceCwd(workspace, cwd);

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
    if (task === "check" || task === "typecheck") return { argv: ["cargo", "check"], ecosystem: "rust" };
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
  return async function runProjectTask({ task, cwd = ".", env = {}, requestApproval, signal } = {}) {
    const discovered = discoverProjectTask({ workspace, cwd, task });
    const run = createCommandRunner({ workspace, timeoutMs, sandboxAdapter, platform, auditLogger });
    const result = await run({ argv: discovered.argv, cwd, env, requestApproval, signal });
    const diagnosed = appendProjectTaskFailureDiagnostic(result);
    return { ...diagnosed, task, ecosystem: discovered.ecosystem };
  };
}
