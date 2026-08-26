import test from "node:test";
import assert from "node:assert/strict";
import { createGoalController } from "../src/goal-controller.js";

const emptyObjectSchema = {
  type: "object",
  additionalProperties: false,
  properties: {},
};

const processKillSchema = {
  type: "object",
  additionalProperties: false,
  required: ["processId"],
  properties: {
    processId: { type: "string", minLength: 1 },
    force: { type: "boolean" },
  },
};

function makeTool(name, inputSchema, invoke) {
  return { name, inputSchema, invoke };
}

test("goal_cancel reclaims only running processes owned by the canceled goal", async () => {
  const inventories = new Map();
  const kills = [];
  const processList = makeTool("process_list", emptyObjectSchema, async (_input, trustedContext = {}) => ({
    processes: inventories.get(trustedContext.goalSessionId) ?? [],
  }));
  const processKill = makeTool("process_kill", processKillSchema, async (input, trustedContext = {}) => {
    kills.push({ ...input, goalSessionId: trustedContext.goalSessionId });
    return { status: "kill_requested", processId: input.processId };
  });
  const controller = createGoalController({
    tools: [processList, processKill],
    verificationTasks: [],
  });
  const goalA = controller.start({ goal: "Run owner A process" });
  const goalB = controller.start({ goal: "Run owner B process" });
  inventories.set(goalA.sessionId, [
    { processId: "a-running", status: "running" },
    { processId: "a-exited", status: "exited" },
  ]);
  inventories.set(goalB.sessionId, [
    { processId: "b-running", status: "running" },
  ]);

  const canceled = await controller.cancel(goalA.sessionId);

  assert.equal(canceled.status, "canceled");
  assert.equal(canceled.mustContinue, false);
  assert.deepEqual(kills, [
    { processId: "a-running", force: true, goalSessionId: goalA.sessionId },
  ]);
  assert.deepEqual(canceled.processCleanup, {
    status: "completed",
    runningFound: 1,
    attempted: 1,
    killed: 1,
    failed: 0,
    failures: [],
  });
  assert.equal(controller.status(goalB.sessionId).status, "active");
});

test("goal_cancel remains compatible when process tools are unavailable", async () => {
  const controller = createGoalController({ tools: [], verificationTasks: [] });
  const goal = controller.start({ goal: "Cancel without process support" });

  const canceled = await controller.cancel(goal.sessionId);

  assert.equal(canceled.status, "canceled");
  assert.equal(canceled.mustContinue, false);
  assert.deepEqual(canceled.processCleanup, {
    status: "not_available",
    runningFound: 0,
    attempted: 0,
    killed: 0,
    failed: 0,
    failures: [],
  });
});

test("goal_cancel stays canceled and reports partial cleanup when a process kill fails", async () => {
  const processList = makeTool("process_list", emptyObjectSchema, async () => ({
    processes: [
      { processId: "ok", status: "running" },
      { processId: "stuck", status: "running" },
      { processId: "done", status: "exited" },
    ],
  }));
  const processKill = makeTool("process_kill", processKillSchema, async ({ processId }) => (
    processId === "ok"
      ? { status: "kill_requested", processId }
      : { status: "kill_failed", processId }
  ));
  const controller = createGoalController({
    tools: [processList, processKill],
    verificationTasks: [],
  });
  const goal = controller.start({ goal: "Cancel with partial cleanup" });

  const canceled = await controller.cancel(goal.sessionId);

  assert.equal(canceled.status, "canceled");
  assert.equal(canceled.mustContinue, false);
  assert.deepEqual(canceled.processCleanup, {
    status: "partial",
    runningFound: 2,
    attempted: 2,
    killed: 1,
    failed: 1,
    failures: [{ processId: "stuck", status: "kill_failed" }],
  });
  assert.equal(controller.status(goal.sessionId).status, "canceled");
  assert.equal(controller.status(goal.sessionId).mustContinue, false);
});
