import test from "node:test";
import assert from "node:assert/strict";
import { goalModeHostInstructions, goalModeWebIntegrationNotes } from "../src/host-instructions.js";

test("host instructions require goal_pause before a cross-turn boundary and explicit @macmini resume later", () => {
  assert.match(goalModeHostInstructions, /mustContinue=true[\s\S]*same assistant turn/i);
  assert.match(goalModeHostInstructions, /goal_pause/i);
  assert.match(goalModeHostInstructions, /mustContinue=false/i);
  assert.match(goalModeHostInstructions, /explicit[^\n]*@macmini/i);
  assert.match(goalModeHostInstructions, /goal_resume/i);
  assert.match(goalModeHostInstructions, /do not[^\n]*bare[^\n]*continue|do not[^\n]*type[^\n]*continue/i);
  assert.equal(goalModeWebIntegrationNotes.safeCrossTurnPause, true);
  assert.equal(goalModeWebIntegrationNotes.explicitToolReconnectRequiredForResume, true);
  assert.equal(goalModeWebIntegrationNotes.bareContinueSupportedForPausedGoals, false);
});
