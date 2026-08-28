import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveModelWorkspaceCwd } from "./workspace.js";

export const HANDOFF_DIR = ".webgpt-handoff";
export const HANDOFF_FILES = Object.freeze(["CONTEXT.md", "PLAN.md", "CHANGES.md", "TESTS.md", "TODO.md", "MANIFEST.json"]);

function atomicWrite(file, content) {
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
}

function redact(value) {
  return String(value ?? "")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/ig, "$1[REDACTED]")
    .replace(/\b(token|password|passwd|secret|api[_-]?key|access[_-]?key)\s*[=:]\s*[^\s,;]+/ig, "$1=[REDACTED]")
    .replace(/\bghp_[A-Za-z0-9_]+\b/g, "[REDACTED]")
    .slice(0, 4000);
}

function defaults(version) {
  return {
    "CONTEXT.md": `# WebGPT Bridge handoff context\n\nThis directory is the portable development handoff package for a future conversation.\n\n- Runtime version: ${version || "unknown"}\n- Keep this file focused on architecture, current state, and important constraints.\n`,
    "PLAN.md": "# Plan\n\nRecord the active implementation plan and acceptance criteria here.\n",
    "CHANGES.md": "# Changes\n\nRecord meaningful code/configuration changes and their rationale here.\n",
    "TESTS.md": "# Tests\n\nRecord commands, platforms, outcomes, and relevant artifacts here.\n",
    "TODO.md": "# TODO\n\nRecord unresolved work here. When design issue journaling is enabled, unresolved entries are stored in `DESIGN_ISSUES.jsonl`.\n",
  };
}

export function ensureHandoffBundle({ workspace, cwd = ".", version = "" } = {}) {
  const { cwd: projectRoot } = resolveModelWorkspaceCwd(workspace, cwd);
  const dir = path.join(projectRoot, HANDOFF_DIR);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const initial = defaults(version);
  for (const [name, content] of Object.entries(initial)) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) {
      atomicWrite(file, content);
      continue;
    }
    if (name === "CONTEXT.md" && version) {
      const existing = fs.readFileSync(file, "utf8");
      const refreshed = existing.replace(/^- Runtime version: .*$/m, `- Runtime version: ${version}`);
      if (refreshed !== existing) atomicWrite(file, refreshed);
    }
  }
  const manifest = {
    schemaVersion: 1,
    kind: "webgpt-bridge-handoff",
    runtimeVersion: version || null,
    documents: HANDOFF_FILES.filter((name) => name !== "MANIFEST.json"),
    designIssues: "DESIGN_ISSUES.jsonl",
  };
  atomicWrite(path.join(dir, "MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { status: "ready", directory: dir, files: [...HANDOFF_FILES] };
}

export function recordDesignIssue({ workspace, cwd = ".", enabled = false, module, category, symptom, suggestion, relatedTest = "", version = "" } = {}) {
  if (enabled !== true) return { status: "disabled" };
  ensureHandoffBundle({ workspace, cwd, version });
  const { cwd: projectRoot } = resolveModelWorkspaceCwd(workspace, cwd);
  const dir = path.join(projectRoot, HANDOFF_DIR);
  const entry = {
    at: new Date().toISOString(),
    module: redact(module || "unknown"),
    category: redact(category || "design"),
    symptom: redact(symptom || "unspecified"),
    suggestion: redact(suggestion || "review"),
    relatedTest: redact(relatedTest),
    version: redact(version),
    status: "open",
  };
  fs.appendFileSync(path.join(dir, "DESIGN_ISSUES.jsonl"), `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  return { status: "recorded", entry };
}
