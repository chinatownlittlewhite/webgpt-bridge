import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGoalController } from "../src/goal-controller.js";
import { createFileGoalSessionStore } from "../src/goal-store.js";
import { INTERNAL_STATE_DIR } from "../src/workspace.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const agentRoot = path.resolve(here, "..");

function makeWorkspace() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "wgb-goal-v2-contract-"));
  fs.mkdirSync(path.join(workspace, "project"), { recursive: true });
  return workspace;
}

test("Goal Store v2 publishes the fixed durable layout and preserves migrated v1 source files", () => {
  const workspace = makeWorkspace();
  try {
    const goalsDir = path.join(workspace, INTERNAL_STATE_DIR, "goals");
    fs.mkdirSync(goalsDir, { recursive: true });
    const legacyPath = path.join(goalsDir, "legacy_contract.json");
    fs.writeFileSync(legacyPath, `${JSON.stringify({
      version: 1,
      session: {
        id: "legacy_contract",
        status: "active",
        goal: "migrate without deletion",
        cwd: "project",
        acceptanceCriteria: [],
        maxSteps: 50,
        maxToolCalls: 100,
        maxDurationMs: 600_000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    })}\n`, "utf8");

    const store = createFileGoalSessionStore({ workspace });
    assert.equal(store.version, 2);
    assert.equal(store.kind, "file");
    assert.equal(store.persistent, true);
    assert.equal(path.basename(store.stateDirectory), "state-v2");
    for (const name of ["metadata.json", "snapshot.json", "journal.log"]) {
      assert.equal(fs.existsSync(path.join(store.stateDirectory, name)), true);
    }
    assert.equal(fs.existsSync(legacyPath), true);
    assert.deepEqual(store.loadAll().map((session) => session.id), ["legacy_contract"]);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("Goal Store v2 protected intent survives restart only as a failed-closed session", async () => {
  const workspace = makeWorkspace();
  try {
    const store = createFileGoalSessionStore({ workspace });
    let calls = 0;
    const tool = {
      name: "side_effect",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      async invoke() {
        calls += 1;
        return { status: "completed" };
      },
    };
    const first = createGoalController({ workspace, tools: [tool], sessionStore: store, verificationTasks: [] });
    const started = first.start({ goal: "do not replay", cwd: "project" });
    const raw = store.loadAll().find((session) => session.id === started.sessionId);
    store.save({
      ...raw,
      inFlightMutation: {
        kind: "goal_tool",
        tool: "side_effect",
        inputHash: "c".repeat(64),
        startedAt: Date.now(),
      },
    });

    const restarted = createGoalController({
      workspace,
      tools: [tool],
      sessionStore: createFileGoalSessionStore({ workspace }),
      verificationTasks: [],
    });
    assert.equal(restarted.status(started.sessionId).status, "failed");
    const replay = await restarted.step({ sessionId: started.sessionId, tool: "side_effect", input: {} });
    assert.equal(replay.status, "already_terminal");
    assert.equal(calls, 0);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("Goal Store v2 stays pure Node without SQLite or native persistence dependencies", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(agentRoot, "package.json"), "utf8"));
  const dependencyNames = Object.keys({
    ...(packageJson.dependencies || {}),
    ...(packageJson.optionalDependencies || {}),
    ...(packageJson.devDependencies || {}),
  });
  assert.equal(dependencyNames.some((name) => /sqlite|better-sqlite|leveldb|rocksdb/i.test(name)), false);
  const source = fs.readFileSync(path.join(agentRoot, "src", "goal-store-v2.js"), "utf8");
  assert.doesNotMatch(source, /node-gyp|\.node["']|sqlite|leveldb|rocksdb/i);
});
