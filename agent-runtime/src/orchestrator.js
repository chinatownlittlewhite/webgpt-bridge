function toolMap(tools) {
  return new Map((tools ?? []).filter((tool) => tool?.name && typeof tool.invoke === "function").map((tool) => [tool.name, tool]));
}

function assertModelStep(modelStep) {
  if (typeof modelStep !== "function") throw new TypeError("orchestrator requires a trusted modelStep callback");
}

function normalizeDecision(decision) {
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    throw new TypeError("modelStep must return an action object");
  }
  if (decision.type === "tool") {
    if (typeof decision.tool !== "string" || !decision.input || typeof decision.input !== "object" || Array.isArray(decision.input)) {
      throw new TypeError("tool decision requires tool and object input");
    }
    return { type: "tool", tool: decision.tool, input: decision.input };
  }
  if (decision.type === "finish") {
    if (typeof decision.summary !== "string" || decision.summary.trim().length === 0) throw new TypeError("finish decision requires summary");
    return {
      type: "finish",
      summary: decision.summary,
      evidence: Array.isArray(decision.evidence) ? decision.evidence : [],
      criteriaEvidence: Array.isArray(decision.criteriaEvidence) ? decision.criteriaEvidence : [],
    };
  }
  if (decision.type === "user_input_required") {
    return { type: "user_input_required", reason: String(decision.reason ?? "user input required") };
  }
  if (decision.type === "cancel") return { type: "cancel" };
  throw new TypeError(`unsupported orchestrator decision type: ${String(decision.type)}`);
}

function audit(logger, event) {
  try { logger?.record?.(event); } catch {}
}

export function createExternalGoalOrchestrator({ tools = [], auditLogger, maxModelTurns = 200 } = {}) {
  if (!Number.isInteger(maxModelTurns) || maxModelTurns < 1 || maxModelTurns > 2_000) {
    throw new RangeError("maxModelTurns must be between 1 and 2000");
  }
  const byName = toolMap(tools);
  const goalMode = byName.get("goal_mode");
  const goalStep = byName.get("goal_step");
  const goalFinish = byName.get("goal_finish");
  const goalStatus = byName.get("goal_status");
  const goalCancel = byName.get("goal_cancel");
  if (![goalMode, goalStep, goalFinish, goalStatus, goalCancel].every(Boolean)) {
    throw new Error("external orchestrator requires the explicit Goal Mode tool family");
  }
  const actionTools = [...byName.keys()].filter((name) => !name.startsWith("goal_") && name !== "get_capabilities");

  return async function runGoal({
    sessionId,
    goal,
    cwd = ".",
    acceptanceCriteria = [],
    budgets = {},
  } = {}, {
    modelStep,
    requestApproval,
    verifyCompletion,
  } = {}) {
    assertModelStep(modelStep);
    let currentSessionId = sessionId;
    let state;
    if (currentSessionId) {
      state = goalStatus.invoke({ sessionId: currentSessionId });
      if (state.status === "not_found") return state;
    } else {
      state = goalMode.invoke({
        goal,
        cwd,
        acceptanceCriteria,
        ...(budgets.maxSteps ? { maxSteps: budgets.maxSteps } : {}),
        ...(budgets.maxToolCalls ? { maxToolCalls: budgets.maxToolCalls } : {}),
        ...(budgets.maxDurationMs ? { maxDurationMs: budgets.maxDurationMs } : {}),
      });
      currentSessionId = state.sessionId;
    }

    audit(auditLogger, { type: "orchestrator_start", sessionId: currentSessionId, goal: state.goal ?? goal, cwd: state.cwd ?? cwd });
    for (let turn = 1; turn <= maxModelTurns; turn += 1) {
      state = goalStatus.invoke({ sessionId: currentSessionId });
      if (state.mustContinue === false && state.status !== "blocked_approval") {
        return { ...state, orchestratorTurns: turn - 1 };
      }

      let decision;
      try {
        decision = normalizeDecision(await modelStep({
          turn,
          session: state,
          availableTools: actionTools,
          rule: "Continue until goal_finish returns completed; use user_input_required only for information unavailable to tools.",
        }));
      } catch (error) {
        return {
          status: "model_error",
          mustContinue: false,
          sessionId: currentSessionId,
          error: error instanceof Error ? error.message : String(error),
          orchestratorTurns: turn,
        };
      }

      audit(auditLogger, { type: "orchestrator_decision", sessionId: currentSessionId, turn, decision });
      if (decision.type === "user_input_required") {
        return { status: "blocked_user_input", mustContinue: false, sessionId: currentSessionId, reason: decision.reason, orchestratorTurns: turn };
      }
      if (decision.type === "cancel") {
        return { ...goalCancel.invoke({ sessionId: currentSessionId }), orchestratorTurns: turn };
      }

      const trustedContext = {
        ...(typeof requestApproval === "function" ? { requestApproval } : {}),
        ...(typeof verifyCompletion === "function" ? { verifyCompletion } : {}),
      };
      const result = decision.type === "tool"
        ? await goalStep.invoke({ sessionId: currentSessionId, tool: decision.tool, input: decision.input }, trustedContext)
        : await goalFinish.invoke({
            sessionId: currentSessionId,
            summary: decision.summary,
            evidence: decision.evidence,
            criteriaEvidence: decision.criteriaEvidence,
          }, trustedContext);

      if (result.status === "completed" || result.mustContinue === false) {
        return { ...result, orchestratorTurns: turn };
      }
    }

    return {
      status: "orchestrator_budget_exhausted",
      mustContinue: false,
      sessionId: currentSessionId,
      reason: `external orchestrator model-turn budget (${maxModelTurns}) exhausted`,
      orchestratorTurns: maxModelTurns,
    };
  };
}
