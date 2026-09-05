import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCommandRunner } from "./runner.js";
import { resolveModelWorkspaceCwd } from "./workspace.js";

const TASKS = new Set(["test", "lint", "build", "typecheck", "check"]);
const MAX_FAILURE_DIAGNOSTIC_BYTES = 4_096;
const FAILURE_MARKER = "[project-task failure excerpt]";
const UNSAFE_SIMPLE_NODE_TEST_CHARS = /[\r\n\t"'`;&|<>()^%!$]/;

export const PROJECT_TASK_RUNTIME_READ_PATHS = Object.freeze([
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "shared"),
]);

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

function node22IsolationOption(nodeVersion) {
  if (typeof nodeVersion !== "string") return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(nodeVersion);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major !== 22 || minor < 8) return null;
  return "--experimental-test-isolation=none";
}

function simpleWindowsNodeTestArgv(scripts, nodeVersion) {
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) return null;
  if (Object.prototype.hasOwnProperty.call(scripts, "pretest") || Object.prototype.hasOwnProperty.call(scripts, "posttest")) {
    return null;
  }
  const script = scripts.test;
  const isolationOption = node22IsolationOption(nodeVersion);
  if (typeof script !== "string" || !isolationOption || UNSAFE_SIMPLE_NODE_TEST_CHARS.test(script)) return null;

  const tokens = script.trim().split(/ +/).filter(Boolean);
  if (tokens[0] !== "node" || tokens[1] !== "--test") return null;
  const testArgs = tokens.slice(2);
  if (testArgs.some((arg) =>
    arg === "--watch"
    || arg.startsWith("--watch=")
    || arg === "--watch-path"
    || arg.startsWith("--watch-path=")
    || arg === "--experimental-test-isolation"
    || arg.startsWith("--experimental-test-isolation=")
    || arg === "--test-isolation"
    || arg.startsWith("--test-isolation="))) {
    return null;
  }
  return ["node", "--test", isolationOption, ...testArgs];
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

export function discoverProjectTask({
  workspace,
  cwd = ".",
  task,
  platform = process.platform,
  nodeVersion = process.versions.node,
} = {}) {
  if (!TASKS.has(task)) throw new Error(`unsupported project task: ${task}`);
  const { cwd: projectRoot } = resolveModelWorkspaceCwd(workspace, cwd);

  const packageJsonPath = path.join(projectRoot, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    if (packageJson.scripts && typeof packageJson.scripts[task] === "string") {
      if (task === "test" && platform === "win32") {
        const directNodeTest = simpleWindowsNodeTestArgv(packageJson.scripts, nodeVersion);
        if (directNodeTest) return { argv: directNodeTest, ecosystem: "node" };
      }
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
  nodeVersion = process.versions.node,
} = {}) {
  return async function runProjectTask({ task, cwd = ".", env = {}, requestApproval, signal } = {}) {
    const discovered = discoverProjectTask({ workspace, cwd, task, platform, nodeVersion });
    const run = createCommandRunner({ workspace, timeoutMs, sandboxAdapter, platform, auditLogger });
    const result = await run({
      argv: discovered.argv,
      cwd,
      env,
      requestApproval,
      signal,
      sandboxExtraReadPaths: PROJECT_TASK_RUNTIME_READ_PATHS,
    });
    const diagnosed = appendProjectTaskFailureDiagnostic(result);
    return { ...diagnosed, task, ecosystem: discovered.ecosystem };
  };
}
