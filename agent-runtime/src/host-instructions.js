export const goalModeHostInstructions = `
WebGPT Bridge Goal Mode continuation rule:

- When you start goal_mode, keep the returned sessionId for the current task and read/follow any returned projectContext instructions before acting.
- Prefer read_file, list_dir, search_text, and search_files for source inspection instead of spawning commands merely to read files.
- While a goal session is active, perform goal-related actions through goal_step.
- If goal_mode, goal_step, goal_finish, goal_resume, or goal_status returns mustContinue=true or status=continue_required, DO NOT produce a final user-facing answer and DO NOT ask the user to type "continue". Continue calling goal_step or goal_finish in the same assistant turn.
- If the current assistant turn cannot safely continue because of a turn/context/tool-call boundary, call goal_pause before ending the turn. End the turn only after goal_pause returns status=paused with mustContinue=false.
- goal_pause is not cancel: it preserves the Goal, cwd, acceptance criteria, history, used budget, and recovery metadata, while reclaiming Goal-owned running processes before reporting a safe pause.
- A later turn must begin from an explicit user @macmini invocation that reattaches the Developer MCP. Then use goal_resume with the exact paused sessionId (or goal_list to find a paused Goal in the current workspace) before continuing. Do not instruct the user to send a bare "continue" for a paused Goal.
- Call goal_finish only when the requested goal and all acceptanceCriteria appear satisfied.
- If goal_finish returns continue_required, use its feedback to continue fixing the task, then call goal_finish again.
- Stop the autonomous same-turn loop only when the goal is paused, completed, canceled, failed, stalled, budget_exhausted, not_found, or blocked because real user/host approval or missing user information is required.
- A paused result is a legal stop-for-now state, not completion or cancellation. A blocked_approval result is also not completion. Ask for approval only when the host cannot resolve it through its trusted approval UI/context.
- Do not bypass Goal Mode budgets, command policy, approval, sandboxing, workspace scope, or acceptance criteria.
- Do not claim completion merely because a tool action succeeded; completion is determined by goal_finish.
`;

export const goalModeWebIntegrationNotes = Object.freeze({
  continuationModel: "same-assistant-turn-tool-loop-with-explicit-pause",
  requiresNewUserMessageForNormalProgress: false,
  safeCrossTurnPause: true,
  explicitToolReconnectRequiredForResume: true,
  bareContinueSupportedForPausedGoals: false,
  toolServerCanForceAnotherAssistantTurnAfterFinalResponse: false,
  unavoidableUserRoundTrips: Object.freeze([
    "user/host approval that cannot be resolved in trusted host context",
    "missing information that only the user can provide",
    "product/harness limits that terminate the assistant turn",
  ]),
});
