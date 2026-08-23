import { randomUUID } from "node:crypto";
import { createGoalRunner } from "./goal-mode.js";

const DEFAULT_MAX_SESSIONS = 100;
const DEFAULT_TTL_MS = 24 * 60 * 60_000;
const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "budget_exhausted",
  "stalled",
  "canceled",
]);

function cloneInput(input) {
  return Object.freeze({ ...input });
}

function summarizeResult(result) {
  return Object.freeze({
    status: result?.status ?? null,
    reason: result?.reason ?? null,
    summary: result?.summary ?? null,
    verified: result?.verified === true,
    steps: result?.steps ?? null,
    toolCalls: result?.toolCalls ?? null,
    elapsedMs: result?.elapsedMs ?? null,
  });
}

function sessionView(session) {
  return Object.freeze({
    sessionId: session.id,
    goal: session.input.goal,
    cwd: session.input.cwd ?? ".",
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    resumable: !TERMINAL_STATUSES.has(session.status),
    lastResult: session.lastResult,
  });
}

export function createGoalSessionManager({
  tools = [],
  goalAgentStep,
  goalVerifyCompletion,
  goalVerificationTasks = ["test", "lint", "typecheck"],
  goalStrictVerification = false,
  goalRepeatLimit = 3,
  maxSessions = DEFAULT_MAX_SESSIONS,
  sessionTtlMs = DEFAULT_TTL_MS,
} = {}) {
  if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 1_000) {
    throw new RangeError("maxSessions must be between 1 and 1000");
  }
  if (!Number.isInteger(sessionTtlMs) || sessionTtlMs < 60_000 || sessionTtlMs > 7 * 24 * 60 * 60_000) {
    throw new RangeError("sessionTtlMs must be between 1 minute and 7 days");
  }

  const sessions = new Map();

  function prune() {
    const cutoff = Date.now() - sessionTtlMs;
    for (const [id, session] of sessions) {
      if (session.updatedAt < cutoff) sessions.delete(id);
    }
    if (sessions.size <= maxSessions) return;
    const ordered = [...sessions.values()].sort((a, b) => a.updatedAt - b.updatedAt);
    for (const session of ordered) {
      if (sessions.size <= maxSessions) break;
      if (TERMINAL_STATUSES.has(session.status)) sessions.delete(session.id);
    }
  }

  function makeRoomForNewSession() {
    prune();
    if (sessions.size < maxSessions) return true;
    const terminal = [...sessions.values()]
      .filter((session) => TERMINAL_STATUSES.has(session.status))
      .sort((a, b) => a.updatedAt - b.updatedAt);
    for (const session of terminal) {
      if (sessions.size < maxSessions) break;
      sessions.delete(session.id);
    }
    return sessions.size < maxSessions;
  }

  function resolveCallbacks(trustedContext = {}) {
    const agentStep =
      typeof trustedContext.agentStep === "function" ? trustedContext.agentStep : goalAgentStep;
    if (typeof agentStep !== "function") {
      return { unavailable: true };
    }
    return {
      agentStep,
      verifyCompletion:
        typeof trustedContext.verifyCompletion === "function"
          ? trustedContext.verifyCompletion
          : goalVerifyCompletion,
      requestApproval:
        typeof trustedContext.requestApproval === "function"
          ? trustedContext.requestApproval
          : undefined,
    };
  }

  function createRunner(trustedContext) {
    const callbacks = resolveCallbacks(trustedContext);
    if (callbacks.unavailable) return null;
    return createGoalRunner({
      tools,
      agentStep: callbacks.agentStep,
      verifyCompletion: callbacks.verifyCompletion,
      requestApproval: callbacks.requestApproval,
      verificationTasks: goalVerificationTasks,
      strictVerification: goalStrictVerification,
      repeatLimit: goalRepeatLimit,
    });
  }

  function recordResult(session, result) {
    session.status = result.status;
    session.lastResult = summarizeResult(result);
    session.checkpoint = result.checkpoint ?? null;
    session.updatedAt = Date.now();
    const { checkpoint: _checkpoint, ...publicResult } = result;
    return Object.freeze({
      sessionId: session.id,
      ...publicResult,
    });
  }

  async function start(input, trustedContext = {}) {
    if (!makeRoomForNewSession()) {
      return {
        status: "capacity_reached",
        reason: `goal session capacity (${maxSessions}) is currently full`,
      };
    }
    const run = createRunner(trustedContext);
    if (!run) {
      return {
        status: "unavailable",
        reason: "host-driven goal sessions require a trusted agentStep callback from the embedding application",
      };
    }
    const now = Date.now();
    const session = {
      id: randomUUID(),
      input: cloneInput(input),
      status: "running",
      createdAt: now,
      updatedAt: now,
      checkpoint: null,
      lastResult: null,
    };
    sessions.set(session.id, session);
    const result = await run(session.input);
    const publicResult = recordResult(session, result);
    prune();
    return publicResult;
  }

  async function resume(sessionId, trustedContext = {}) {
    prune();
    const session = sessions.get(sessionId);
    if (!session) return { status: "not_found", sessionId };
    if (TERMINAL_STATUSES.has(session.status)) {
      return { status: "already_terminal", session: sessionView(session) };
    }
    if (!session.checkpoint) {
      return { status: "not_resumable", session: sessionView(session) };
    }
    const run = createRunner(trustedContext);
    if (!run) {
      return {
        status: "unavailable",
        sessionId,
        reason: "host-driven goal resume requires a trusted agentStep callback from the embedding application",
      };
    }
    session.status = "running";
    session.updatedAt = Date.now();
    const result = await run(session.input, { checkpoint: session.checkpoint });
    return recordResult(session, result);
  }

  function status(sessionId) {
    prune();
    const session = sessions.get(sessionId);
    return session ? sessionView(session) : { status: "not_found", sessionId };
  }

  function cancel(sessionId) {
    prune();
    const session = sessions.get(sessionId);
    if (!session) return { status: "not_found", sessionId };
    if (TERMINAL_STATUSES.has(session.status)) {
      return { status: "already_terminal", session: sessionView(session) };
    }
    session.status = "canceled";
    session.checkpoint = null;
    session.updatedAt = Date.now();
    session.lastResult = Object.freeze({ status: "canceled", reason: "goal session canceled by host/user" });
    return sessionView(session);
  }

  return Object.freeze({
    start,
    resume,
    status,
    cancel,
    sessionCount() {
      prune();
      return sessions.size;
    },
  });
}

export const goalSessionDefaults = Object.freeze({
  maxSessions: DEFAULT_MAX_SESSIONS,
  sessionTtlMs: DEFAULT_TTL_MS,
});
