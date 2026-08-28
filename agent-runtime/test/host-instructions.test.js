import test from "node:test";
import assert from "node:assert/strict";
import {
  goalModeHostInstructions,
  goalModeWebIntegrationNotes,
} from "../src/host-instructions.js";

test("web host instructions require same-turn continuation for active goals", () => {
  assert.match(goalModeHostInstructions, /same assistant turn/i);
  assert.match(goalModeHostInstructions, /DO NOT ask the user to type "continue"/);
  assert.match(goalModeHostInstructions, /goal_finish/);
  assert.equal(goalModeWebIntegrationNotes.continuationModel, "same-assistant-turn-tool-loop-with-explicit-pause");
  assert.equal(goalModeWebIntegrationNotes.requiresNewUserMessageForNormalProgress, false);
});

test("web integration notes do not overclaim cross-turn autonomy", () => {
  assert.equal(goalModeWebIntegrationNotes.toolServerCanForceAnotherAssistantTurnAfterFinalResponse, false);
  assert.ok(goalModeWebIntegrationNotes.unavoidableUserRoundTrips.length > 0);
});
