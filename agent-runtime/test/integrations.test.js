import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverDependencySync } from "../src/dependency.js";
import { buildGitHubArgv } from "../src/github.js";

test("dependency sync chooses lock-aware structured commands with scripts disabled by default", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-dependency-"));
  fs.writeFileSync(path.join(root, "package.json"), "{}\n");
  fs.writeFileSync(path.join(root, "package-lock.json"), "{}\n");
  const npm = discoverDependencySync({ workspace: root });
  assert.equal(npm.ecosystem, "node-npm");
  assert.deepEqual(npm.argv, ["npm", "ci", "--no-audit", "--no-fund", "--ignore-scripts"]);

  fs.rmSync(path.join(root, "package-lock.json"));
  fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  const pnpm = discoverDependencySync({ workspace: root });
  assert.equal(pnpm.ecosystem, "node-pnpm");
  assert.ok(pnpm.argv.includes("--frozen-lockfile"));
  assert.ok(pnpm.argv.includes("--ignore-scripts"));

  const scripts = discoverDependencySync({ workspace: root, allowScripts: true });
  assert.equal(scripts.argv.includes("--ignore-scripts"), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("GitHub integration builds bounded argv without a shell", () => {
  assert.deepEqual(
    buildGitHubArgv({ action: "ci_status", limit: 5 }),
    ["gh", "run", "list", "--limit", "5", "--json", "databaseId,status,conclusion,name,workflowName,url,headBranch,headSha"],
  );
  const create = buildGitHubArgv({
    action: "pr_create",
    title: "Test PR",
    body: "Body",
    base: "main",
    head: "feature",
  });
  assert.deepEqual(create, ["gh", "pr", "create", "--title", "Test PR", "--body", "Body", "--base", "main", "--head", "feature"]);
  assert.throws(() => buildGitHubArgv({ action: "pr_create", title: "x", body: "", base: "--repo" }), /does not start/);
  assert.throws(() => buildGitHubArgv({ action: "issue_view", number: 0 }), /between 1/);
});
