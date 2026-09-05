import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCommandRunner } from "../src/runner.js";

test("runner prepends host-derived staged runtime directories to child PATH", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wgb-runner-trusted-path-"));
  try {
    const runtimeBin = path.join(root, ".webgpt-bridge", "runtime", "fixture", "bin");
    fs.mkdirSync(runtimeBin, { recursive: true });
    const run = createCommandRunner({
      workspace: root,
      platformRuntimeStager(command, { workspace }) {
        assert.equal(fs.realpathSync(workspace), fs.realpathSync(root));
        return Object.freeze({
          ...command,
          trustedPathEntries: Object.freeze([runtimeBin]),
        });
      },
    });

    const result = await run({
      argv: [
        "node",
        "-e",
        `process.stdout.write((process.env.PATH || "").split(${JSON.stringify(path.delimiter)})[0] || "")`,
      ],
      requestApproval: async () => true,
    });

    assert.equal(result.status, "completed");
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, fs.realpathSync(runtimeBin));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runner injects trusted staged runtime environment without exposing it to model env", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wgb-runner-trusted-env-"));
  try {
    const nodeOptions = "--preserve-symlinks --preserve-symlinks-main";
    const run = createCommandRunner({
      workspace: root,
      platformRuntimeStager(command) {
        return Object.freeze({
          ...command,
          trustedEnvironment: Object.freeze({ NODE_OPTIONS: nodeOptions }),
        });
      },
    });

    const result = await run({
      argv: ["node", "-e", "process.stdout.write(process.env.NODE_OPTIONS || '')"],
      requestApproval: async () => true,
    });

    assert.equal(result.status, "completed");
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, nodeOptions);
    await assert.rejects(
      () => run({ argv: ["node", "--version"], env: { NODE_OPTIONS: "--inspect" }, requestApproval: async () => true }),
      /environment variable NODE_OPTIONS is not allowed/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
