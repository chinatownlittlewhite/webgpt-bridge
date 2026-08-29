import { createHash } from "node:crypto";
import { createGoalController as createCoreGoalController, goalControllerDefaults } from "./goal-controller-core.js";
import { createMemoryGoalSessionStore } from "./goal-store.js";

const RECOVERABLE_STATUSES = new Set(["active", "blocked_approval"]);
const MARKER_KIND = "goal_tool";
const INTERRUPTED_FEEDBACK = "a previous Goal mutation was interrupted before durable completion; the session failed closed to prevent replaying an uncertain effect";

function hashInput(value) {
  try {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
  } catch {
    return createHash("sha256").update("unserializable-goal-input").digest("hex");
  }
}

function normalizeMutationMarker(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.kind !== MARKER_KIND) return null;
  if (typeof value.tool !== "string" || value.tool.length < 1 || value.tool.length > 128) return null;
  if (typeof value.inputHash !== "string" || !/^[a-f0-9]{64}$/i.test(value.inputHash)) return null;
  if (!Number.isFinite(value.startedAt) || value.startedAt <= 0) return null;
  return Object.freeze({
    kind: MARKER_KIND,
    tool: value.tool,
    inputHash: value.inputHash.toLowerCase(),
    startedAt: value.startedAt,
  });
}

function hasInterruptedMutation(raw) {
  return Boolean(
    raw &&
    typeof raw === "object" &&
    RECOVERABLE_STATUSES.has(raw.status) &&
    normalizeMutationMarker(raw.inFlightMutation),
  );
}

function failClosedStoredSession(raw) {
  if (!hasInterruptedMutation(raw)) return raw;
  return {
    ...structuredClone(raw),
    status: "failed",
    verified: false,
    lastFeedback: INTERRUPTED_FEEDBACK,
    updatedAt: Date.now(),
  };
}

function findStoredSession(store, sessionId) {
  const stored = store.loadAll();
  if (!Array.isArray(stored)) return null;
  return stored.find((entry) => entry && entry.id === sessionId) ?? null;
}

function createObservedStore(store, state) {
  return {
    get kind() {
      return store.kind;
    },
    get persistent() {
      return store.persistent;
    },
    loadAll() {
      const stored = store.loadAll();
      return Array.isArray(stored) ? stored.map(failClosedStoredSession) : stored;
    },
    save(session) {
      try {
        return store.save(session);
      } catch (error) {
        if (session?.id) state.saveFailures.add(session.id);
        throw error;
      }
    },
    remove(sessionId) {
      return store.remove(sessionId);
    },
  };
}

function persistMutationIntent(store, state, sessionId, tool, input) {
  let current;
  try {
    current = findStoredSession(store, sessionId);
  } catch {
    state.preflightFailures.add(sessionId);
    return false;
  }
  if (!current || !RECOVERABLE_STATUSES.has(current.status)) {
    state.preflightFailures.add(sessionId);
    return false;
  }
  const marker = Object.freeze({
    kind: MARKER_KIND,
    tool: String(tool).slice(0, 128),
    inputHash: hashInput(input),
    startedAt: Date.now(),
  });
  try {
    store.save({ ...structuredClone(current), inFlightMutation: marker });
    state.intentSessions.add(sessionId);
    return true;
  } catch {
    state.preflightFailures.add(sessionId);
    return false;
  }
}

function wrapTool(tool, store, state) {
  if (!tool || typeof tool !== "object" || typeof tool.invoke !== "function") return tool;
  return Object.freeze({
    ...tool,
    async invoke(input, trustedContext) {
      const sessionId = trustedContext?.goalSessionId;
      if (
        typeof sessionId !== "string" ||
        sessionId.length === 0 ||
        trustedContext?.goalMutationProtected === true
      ) {
        return tool.invoke(input, trustedContext);
      }
      if (!persistMutationIntent(store, state, sessionId, tool.name, input)) {
        throw new Error("Goal mutation intent could not be durably persisted before tool invocation");
      }
      return tool.invoke(input, trustedContext);
    },
  });
}

function durableStateStillUncertain(store, sessionId) {
  try {
    return hasInterruptedMutation(findStoredSession(store, sessionId));
  } catch {
    return true;
  }
}

function persistenceErrorResult(controller, sessionId, reason) {
  const session = controller.status(sessionId);
  return Object.freeze({
    status: "persistence_error",
    mustContinue: false,
    sessionId,
    reason,
    ...(session?.status !== "not_found" ? { session } : {}),
  });
}

function beginTrackedOperation(state, sessionId) {
  state.preflightFailures.delete(sessionId);
  state.saveFailures.delete(sessionId);
}

function finishTrackedOperation(state, store, sessionId) {
  const preflightFailed = state.preflightFailures.delete(sessionId);
  const saveFailed = state.saveFailures.delete(sessionId);
  const durableUncertain = saveFailed && durableStateStillUncertain(store, sessionId);
  state.intentSessions.delete(sessionId);
  return { preflightFailed, saveFailed, durableUncertain };
}

function failClosedPersistence(controller, state, sessionId, reason, failClosed = true) {
  if (failClosed) state.failedClosedSessions.set(sessionId, reason);
  return persistenceErrorResult(controller, sessionId, reason);
}

export function createGoalController(options = {}) {
  const store = options.sessionStore ?? createMemoryGoalSessionStore();
  const state = {
    intentSessions: new Set(),
    preflightFailures: new Set(),
    saveFailures: new Set(),
    failedClosedSessions: new Map(),
  };
  const observedStore = createObservedStore(store, state);
  const tools = Array.isArray(options.tools)
    ? options.tools.map((tool) => wrapTool(tool, store, state))
    : options.tools;
  const core = createCoreGoalController({ ...options, sessionStore: observedStore, tools });

  function status(sessionId) {
    const result = core.status(sessionId);
    const reason = state.failedClosedSessions.get(sessionId);
    if (!reason || result.status === "not_found") return result;
    return Object.freeze({
      ...result,
      status: "failed",
      mustContinue: false,
      verified: false,
      lastFeedback: reason,
    });
  }

  function alreadyFailed(sessionId) {
    return Object.freeze({
      status: "already_terminal",
      mustContinue: false,
      session: status(sessionId),
    });
  }

  function persistenceFailure(sessionId, tracking, operation) {
    if (tracking.preflightFailed) {
      const reason = `${operation} could not durably persist its mutation intent before the protected effect started`;
      return failClosedPersistence({ status }, state, sessionId, reason);
    }
    if (tracking.saveFailed) {
      const reason = tracking.durableUncertain
        ? `${operation} completed an effect but its resulting state could not be durably persisted; the session failed closed to prevent automatic replay`
        : `${operation} state could not be durably persisted; the session failed closed instead of reporting an uncommitted result`;
      return failClosedPersistence({ status }, state, sessionId, reason);
    }
    return null;
  }

  async function step(input, trustedContext = {}) {
    const sessionId = input?.sessionId;
    if (typeof sessionId === "string" && state.failedClosedSessions.has(sessionId)) {
      return alreadyFailed(sessionId);
    }
    if (typeof sessionId === "string") beginTrackedOperation(state, sessionId);

    const result = await core.step(input, trustedContext);
    if (typeof sessionId !== "string") return result;

    const failure = persistenceFailure(
      sessionId,
      finishTrackedOperation(state, store, sessionId),
      "Goal step",
    );
    return failure ?? result;
  }

  async function finish(input, trustedContext = {}) {
    const sessionId = input?.sessionId;
    if (typeof sessionId === "string" && state.failedClosedSessions.has(sessionId)) {
      return alreadyFailed(sessionId);
    }
    if (typeof sessionId !== "string") return core.finish(input, trustedContext);
    const current = core.status(sessionId);
    if (!RECOVERABLE_STATUSES.has(current.status)) return core.finish(input, trustedContext);

    beginTrackedOperation(state, sessionId);
    if (!persistMutationIntent(store, state, sessionId, "goal_finish", input)) {
      const failure = persistenceFailure(
        sessionId,
        finishTrackedOperation(state, store, sessionId),
        "Goal finish",
      );
      return failure ?? persistenceErrorResult({ status }, sessionId, "Goal finish mutation intent could not be durably persisted");
    }

    const result = await core.finish(input, trustedContext);
    const failure = persistenceFailure(
      sessionId,
      finishTrackedOperation(state, store, sessionId),
      "Goal finish",
    );
    return failure ?? result;
  }

  async function pause(input = {}) {
    const sessionId = input?.sessionId;
    if (typeof sessionId !== "string") return core.pause(input);
    if (state.failedClosedSessions.has(sessionId)) return alreadyFailed(sessionId);
    const current = core.status(sessionId);
    if (current.status !== "active") return core.pause(input);

    beginTrackedOperation(state, sessionId);
    if (!persistMutationIntent(store, state, sessionId, "goal_pause", input)) {
      const failure = persistenceFailure(
        sessionId,
        finishTrackedOperation(state, store, sessionId),
        "Goal pause",
      );
      return failure ?? persistenceErrorResult({ status }, sessionId, "Goal pause mutation intent could not be durably persisted");
    }

    const result = await core.pause(input);
    const tracking = finishTrackedOperation(state, store, sessionId);
    if (tracking.saveFailed) {
      const reason = tracking.durableUncertain
        ? "Goal pause performed process cleanup but its paused state could not be durably persisted; the session failed closed to prevent replaying uncertain cleanup"
        : "Goal pause state could not be durably persisted; pause was not reported as committed";
      return failClosedPersistence({ status }, state, sessionId, reason);
    }
    state.failedClosedSessions.delete(sessionId);
    return result;
  }

  async function resume(sessionId) {
    if (typeof sessionId !== "string") return core.resume(sessionId);
    if (state.failedClosedSessions.has(sessionId)) return alreadyFailed(sessionId);
    const current = core.status(sessionId);
    if (current.status !== "paused") return core.resume(sessionId);

    beginTrackedOperation(state, sessionId);
    const result = await core.resume(sessionId);
    const failure = persistenceFailure(
      sessionId,
      finishTrackedOperation(state, store, sessionId),
      "Goal resume",
    );
    if (failure) return failure;
    state.failedClosedSessions.delete(sessionId);
    return result;
  }

  function list(input = {}) {
    return core.list(input);
  }

  async function cancel(sessionId) {
    if (typeof sessionId !== "string") return core.cancel(sessionId);
    const current = core.status(sessionId);
    if (!RECOVERABLE_STATUSES.has(current.status)) return core.cancel(sessionId);

    beginTrackedOperation(state, sessionId);
    if (!persistMutationIntent(store, state, sessionId, "goal_cancel", {})) {
      finishTrackedOperation(state, store, sessionId);
      const reason = "Goal cancel could not durably persist its cancellation intent before process cleanup started";
      return failClosedPersistence({ status }, state, sessionId, reason, false);
    }

    const result = await core.cancel(sessionId);
    const tracking = finishTrackedOperation(state, store, sessionId);
    if (tracking.saveFailed) {
      const reason = tracking.durableUncertain
        ? "Goal cancel performed cleanup but its terminal state could not be durably persisted; the session failed closed to prevent replaying uncertain cleanup"
        : "Goal cancel terminal state could not be durably persisted; cancellation was not reported as committed";
      return failClosedPersistence({ status }, state, sessionId, reason);
    }
    state.failedClosedSessions.delete(sessionId);
    return result;
  }

  return Object.freeze({
    start: core.start,
    step,
    finish,
    pause,
    resume,
    list,
    status,
    cancel,
  });
}

export { goalControllerDefaults };
