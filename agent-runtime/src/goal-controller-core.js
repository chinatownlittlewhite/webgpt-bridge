import { createHash, randomUUID } from "node:crypto";
import { scopeGoalToolInput, validateGoalCwd } from "./goal-scope.js";
import { createMemoryGoalSessionStore } from "./goal-store.js";
import {
  classifyGoalAction,
  normalizeGoalVerificationProfile,
} from "./goal-verification-profile.js";
import { loadProjectContext } from "./project-context.js";
import { validateJsonSchema } from "./schema-validate.js";

const DEFAULT_MAX_STEPS = 50;
const DEFAULT_MAX_TOOL_CALLS = 100;
const DEFAULT_MAX_DURATION_MS = 10 * 60_000;
const DEFAULT_REPEAT_LIMIT = 3;
const DEFAULT_MAX_SESSIONS = 100;
const DEFAULT_TTL_MS = 24 * 60 * 60_000;
const MAX_HISTORY_EVENTS = 80;
const MAX_EVENT_BYTES = 32_000;
const MAX_PUBLIC_HISTORY_EVENTS = 8;
const MAX_PUBLIC_EVENT_BYTES = 1_500;
const MAX_PUBLIC_GOAL_BYTES = 6_000;
const MAX_PUBLIC_CRITERIA_BYTES = 6_000;
const MAX_PUBLIC_FEEDBACK_BYTES = 2_000;
const MAX_PUBLIC_PAUSE_SUMMARY_BYTES = 4_000;
const MAX_PUBLIC_PAUSE_ACTION_BYTES = 3_000;
const MAX_PUBLIC_PAUSE_REASON_BYTES = 2_000;
const MAX_PUBLIC_POSTCONDITION_BYTES = 6_000;
const MAX_PUBLIC_PROJECT_INSTRUCTIONS_BYTES = 6_000;
const MAX_VERIFICATION_DIAGNOSTIC_BYTES = 4_096;
const TERMINAL = new Set(["completed", "canceled", "budget_exhausted", "stalled", "failed"]);
const STORED_STATUSES = new Set([...TERMINAL, "active", "paused", "blocked_approval"]);

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function boundedPublicText(value, maxBytes) {
  if (typeof value !== "string") return value;
  const raw = Buffer.from(value, "utf8");
  if (raw.length <= maxBytes) return value;
  const suffix = "\n...[TRUNCATED]";
  const suffixBytes = Buffer.byteLength(suffix);
  return `${raw.subarray(0, Math.max(0, maxBytes - suffixBytes)).toString("utf8")}${suffix}`;
}

function boundedPublicCriteria(criteria) {
  const result = [];
  let used = 0;
  for (const criterion of criteria ?? []) {
    if (result.length >= 12) break;
    const bounded = boundedPublicText(criterion, 1_000);
    const bytes = Buffer.byteLength(JSON.stringify(bounded));
    if (used + bytes > MAX_PUBLIC_CRITERIA_BYTES) break;
    result.push(bounded);
    used += bytes;
  }
  return Object.freeze(result);
}

function publicPause(pause) {
  if (!pause) return null;
  return Object.freeze({
    summary: boundedPublicText(pause.summary, MAX_PUBLIC_PAUSE_SUMMARY_BYTES),
    nextAction: boundedPublicText(pause.nextAction, MAX_PUBLIC_PAUSE_ACTION_BYTES),
    reason: boundedPublicText(pause.reason, MAX_PUBLIC_PAUSE_REASON_BYTES),
    pausedAt: pause.pausedAt,
  });
}

function publicHistoryEvent(event) {
  const serialized = JSON.stringify(event);
  const bytes = Buffer.byteLength(serialized);
  if (bytes <= MAX_PUBLIC_EVENT_BYTES) return event;
  return Object.freeze({
    type: event?.type ?? "unknown",
    ...(typeof event?.tool === "string" ? { tool: event.tool } : {}),
    ...(typeof event?.result?.status === "string" ? { status: event.result.status } : {}),
    truncated: true,
    sha256: hash(event),
    bytes,
  });
}

function publicProjectContext(context) {
  if (!context) return null;
  return Object.freeze({
    cwd: boundedPublicText(context.cwd, 512),
    files: Object.freeze((context.files ?? []).slice(0, 8).map((file) => Object.freeze({
      path: boundedPublicText(file.path, 512),
      bytes: file.bytes,
      sha256: file.sha256,
    }))),
    nestedInstructionFiles: Object.freeze((context.nestedInstructionFiles ?? []).slice(0, 8).map((entry) => boundedPublicText(entry, 512))),
    instructions: boundedPublicText(context.instructions ?? "", MAX_PUBLIC_PROJECT_INSTRUCTIONS_BYTES),
    totalBytes: context.totalBytes,
    truncated: context.truncated === true,
    scanTruncated: context.scanTruncated === true,
  });
}

function positiveInteger(value, name, max) {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new RangeError(`${name} must be between 1 and ${max}`);
  }
  return value;
}

function normalizePostcondition(value, verificationProfile) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > 8_192) {
    throw new TypeError("postcondition must be a non-empty string up to 8192 characters when supplied");
  }
  if (verificationProfile !== "system-operation") {
    throw new TypeError("postcondition is only valid for the system-operation verification profile");
  }
  return value.trim();
}

function normalizeStart(input = {}) {
  if (typeof input.goal !== "string" || input.goal.trim().length === 0) {
    throw new TypeError("goal must be a non-empty string");
  }
  const goal = input.goal.trim();
  if (goal.length > 32_768) throw new RangeError("goal must not exceed 32768 characters");
  const cwd = input.cwd ?? ".";
  if (typeof cwd !== "string" || cwd.length === 0 || cwd.length > 4_096 || cwd.includes("\0")) {
    throw new TypeError("cwd must be a non-empty string up to 4096 characters without NUL bytes");
  }
  if (input.acceptanceCriteria !== undefined && !Array.isArray(input.acceptanceCriteria)) {
    throw new TypeError("acceptanceCriteria must be an array when supplied");
  }
  if (Array.isArray(input.acceptanceCriteria) && input.acceptanceCriteria.length > 50) {
    throw new RangeError("acceptanceCriteria must contain at most 50 entries");
  }
  const verificationProfile = normalizeGoalVerificationProfile(input.verificationProfile);
  const postcondition = normalizePostcondition(input.postcondition, verificationProfile);
  const acceptanceCriteria = Array.isArray(input.acceptanceCriteria)
    ? [...new Set(input.acceptanceCriteria.map((entry) => {
        if (typeof entry !== "string" || entry.trim().length === 0 || entry.trim().length > 8_192) {
          throw new TypeError("acceptanceCriteria entries must be non-empty strings up to 8192 characters");
        }
        return entry.trim();
      }))]
    : [];
  return {
    goal,
    cwd,
    acceptanceCriteria,
    verificationProfile,
    postcondition,
    maxSteps: positiveInteger(input.maxSteps ?? DEFAULT_MAX_STEPS, "maxSteps", 200),
    maxToolCalls: positiveInteger(input.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS, "maxToolCalls", 500),
    maxDurationMs: positiveInteger(input.maxDurationMs ?? DEFAULT_MAX_DURATION_MS, "maxDurationMs", 30 * 60_000),
  };
}

function toolMap(tools) {
  const map = new Map();
  for (const tool of tools ?? []) {
    if (!tool || typeof tool.name !== "string" || typeof tool.invoke !== "function") continue;
    if (tool.name.startsWith("goal_")) continue;
    if (map.has(tool.name)) throw new Error(`duplicate goal-controller tool ${tool.name}`);
    map.set(tool.name, tool);
  }
  return map;
}

function addEvent(session, event) {
  const serialized = JSON.stringify(event);
  const bytes = Buffer.byteLength(serialized);
  const bounded = bytes > MAX_EVENT_BYTES
    ? { type: event.type, truncated: true, sha256: hash(event), bytes }
    : event;
  session.history.push(Object.freeze({ ...bounded }));
  if (session.history.length > MAX_HISTORY_EVENTS) {
    session.history.splice(0, session.history.length - MAX_HISTORY_EVENTS);
  }
}

function budget(session) {
  return Object.freeze({
    stepsUsed: session.steps,
    stepsRemaining: Math.max(0, session.maxSteps - session.steps),
    toolCallsUsed: session.toolCalls,
    toolCallsRemaining: Math.max(0, session.maxToolCalls - session.toolCalls),
    activeElapsedMs: session.activeElapsedMs,
    activeDurationRemainingMs: Math.max(0, session.maxDurationMs - session.activeElapsedMs),
  });
}

function sessionView(session, includeHistory = false) {
  const publicCriteria = boundedPublicCriteria(session.acceptanceCriteria);
  const history = includeHistory
    ? session.history.slice(-MAX_PUBLIC_HISTORY_EVENTS).map(publicHistoryEvent)
    : null;
  return Object.freeze({
    sessionId: session.id,
    goal: boundedPublicText(session.goal, MAX_PUBLIC_GOAL_BYTES),
    cwd: boundedPublicText(session.cwd, 1_024),
    acceptanceCriteria: publicCriteria,
    ...(publicCriteria.length < session.acceptanceCriteria.length ? {
      acceptanceCriteriaOmitted: session.acceptanceCriteria.length - publicCriteria.length,
    } : {}),
    status: session.status,
    mustContinue: session.status === "active",
    verificationProfile: session.verificationProfile,
    postcondition: boundedPublicText(session.postcondition, MAX_PUBLIC_POSTCONDITION_BYTES),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    verified: session.verified,
    budget: budget(session),
    lastFeedback: boundedPublicText(session.lastFeedback, MAX_PUBLIC_FEEDBACK_BYTES),
    pause: publicPause(session.pause),
    ...(includeHistory ? {
        history,
        historyOmitted: Math.max(0, session.history.length - history.length),
        projectContext: publicProjectContext(session.projectContext),
      } : {}),
  });
}

function terminalSessionResult(session) {
  return { status: "already_terminal", mustContinue: false, session: sessionView(session) };
}

function loadGoalProjectContext(workspace, cwd) {
  if (!workspace) return null;
  try {
    return loadProjectContext({ workspace, cwd, maxTotalBytes: 48_000 });
  } catch {
    return null;
  }
}

function stopForBudget(session) {
  let reason = null;
  if (session.steps >= session.maxSteps) reason = "step budget exhausted";
  else if (session.toolCalls >= session.maxToolCalls) reason = "tool-call budget exhausted";
  else if (session.activeElapsedMs >= session.maxDurationMs) reason = "active duration budget exhausted";
  if (!reason) return null;
  session.status = "budget_exhausted";
  session.lastFeedback = reason;
  session.updatedAt = Date.now();
  addEvent(session, { type: "budget_exhausted", reason });
  return {
    status: "budget_exhausted",
    mustContinue: false,
    reason,
    sessionId: session.id,
    budget: budget(session),
  };
}

function approvalBlock(result) {
  return result && typeof result === "object" && ["approval_required", "approval_denied", "approval_error"].includes(result.status);
}

function compactToolResult(result) {
  if (!result || typeof result !== "object") return result;
  const serialized = JSON.stringify(result);
  const bytes = Buffer.byteLength(serialized);
  if (bytes <= 16_000) return result;
  return {
    status: result.status ?? null,
    exitCode: result.exitCode ?? null,
    signal: result.signal ?? null,
    error: result.error ?? null,
    policy: result.policy,
    sandbox: result.sandbox,
    approvalRequest: result.approvalRequest,
    truncated: true,
    sha256: hash(result),
    bytes,
  };
}

function boundedUtf8Tail(value, maxBytes = MAX_VERIFICATION_DIAGNOSTIC_BYTES) {
  if (typeof value !== "string" || value.length === 0) return { text: "", omitted: false };
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return { text: value, omitted: false };
  let start = buffer.length - maxBytes;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  return { text: buffer.subarray(start).toString("utf8"), omitted: true };
}

function verificationCheck(task, result, includeDiagnostics = false) {
  const basic = {
    task,
    status: result?.status ?? null,
    exitCode: result?.exitCode ?? null,
  };
  if (!includeDiagnostics) return basic;
  const stdout = boundedUtf8Tail(result?.stdout);
  const stderr = boundedUtf8Tail(result?.stderr);
  return {
    ...basic,
    stdoutTail: stdout.text,
    stderrTail: stderr.text,
    stdoutOmitted: stdout.omitted || result?.stdoutTruncated === true,
    stderrOmitted: stderr.omitted || result?.stderrTruncated === true,
  };
}

function evaluateAcceptanceCriteria(session, criteriaEvidence) {
  if (session.acceptanceCriteria.length === 0) {
    return { passed: true, evidence: [] };
  }
  if (!Array.isArray(criteriaEvidence)) {
    return {
      passed: false,
      feedback: "goal_finish must provide criteriaEvidence for every acceptance criterion",
      evidence: [],
    };
  }

  const byCriterion = new Map();
  for (const entry of criteriaEvidence) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    if (typeof entry.criterion !== "string") continue;
    byCriterion.set(entry.criterion, entry);
  }

  const normalized = [];
  for (const criterion of session.acceptanceCriteria) {
    const entry = byCriterion.get(criterion);
    if (!entry) {
      return { passed: false, feedback: `missing acceptance evidence for: ${criterion}`, evidence: normalized };
    }
    if (entry.satisfied !== true) {
      return { passed: false, feedback: `acceptance criterion is not satisfied: ${criterion}`, evidence: normalized };
    }
    if (typeof entry.evidence !== "string" || entry.evidence.trim().length === 0) {
      return { passed: false, feedback: `acceptance criterion has no evidence: ${criterion}`, evidence: normalized };
    }
    normalized.push(Object.freeze({
      criterion,
      satisfied: true,
      evidence: entry.evidence.trim(),
    }));
  }
  return { passed: true, evidence: normalized };
}

function boundedStoredInteger(value, fallback, max) {
  return Number.isInteger(value) && value >= 0 && value <= max ? value : fallback;
}

function boundedStoredTimestamp(value, now) {
  return Number.isFinite(value) && value > 0 ? Math.min(value, now) : now;
}

function optionalPauseText(value, name, maxLength) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > maxLength) {
    throw new TypeError(`${name} must be a non-empty string up to ${maxLength} characters when supplied`);
  }
  return value.trim();
}

function normalizePauseInput(input = {}) {
  return Object.freeze({
    summary: optionalPauseText(input.summary, "goal_pause summary", 32_768),
    nextAction: optionalPauseText(input.nextAction, "goal_pause nextAction", 8_192),
    reason: optionalPauseText(input.reason, "goal_pause reason", 8_192),
  });
}

function normalizeStoredPause(value, now) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.freeze({
    summary: typeof value.summary === "string" ? value.summary.slice(0, 32_768) : null,
    nextAction: typeof value.nextAction === "string" ? value.nextAction.slice(0, 8_192) : null,
    reason: typeof value.reason === "string" ? value.reason.slice(0, 8_192) : null,
    pausedAt: boundedStoredTimestamp(value.pausedAt, now),
  });
}

function normalizeStoredHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .slice(-MAX_HISTORY_EVENTS)
    .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
    .map((entry) => {
      const serialized = JSON.stringify(entry);
      const bytes = Buffer.byteLength(serialized);
      if (bytes <= MAX_EVENT_BYTES) return Object.freeze({ ...entry });
      return Object.freeze({
        type: typeof entry.type === "string" ? entry.type : "stored_event",
        truncated: true,
        sha256: hash(entry),
        bytes,
      });
    });
}

function hydrateStoredSession(raw, workspace) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (typeof raw.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(raw.id)) return null;
  if (!STORED_STATUSES.has(raw.status)) return null;
  try {
    const config = normalizeStart({
      goal: raw.goal,
      cwd: raw.cwd,
      acceptanceCriteria: raw.acceptanceCriteria,
      verificationProfile: ["code-change", "read-only-audit", "system-operation"].includes(raw.verificationProfile)
        ? raw.verificationProfile
        : undefined,
      postcondition: raw.postcondition,
      maxSteps: raw.maxSteps,
      maxToolCalls: raw.maxToolCalls,
      maxDurationMs: raw.maxDurationMs,
    });
    const cwd = workspace ? validateGoalCwd(workspace, config.cwd) : config.cwd;
    const now = Date.now();
    return {
      id: raw.id,
      ...config,
      cwd,
      projectContext: loadGoalProjectContext(workspace, cwd),
      status: raw.status,
      verified: raw.verified === true,
      createdAt: boundedStoredTimestamp(raw.createdAt, now),
      updatedAt: boundedStoredTimestamp(raw.updatedAt, now),
      steps: boundedStoredInteger(raw.steps, 0, config.maxSteps),
      toolCalls: boundedStoredInteger(raw.toolCalls, 0, config.maxToolCalls),
      sideEffectActionCount: boundedStoredInteger(raw.sideEffectActionCount, 0, config.maxToolCalls),
      activeElapsedMs: boundedStoredInteger(raw.activeElapsedMs, 0, config.maxDurationMs),
      history: normalizeStoredHistory(raw.history),
      lastFeedback:
        typeof raw.lastFeedback === "string" ? raw.lastFeedback.slice(0, 8_192) : null,
      pause: normalizeStoredPause(raw.pause, now),
      repeatedActionHash:
        typeof raw.repeatedActionHash === "string" && /^[a-f0-9]{64}$/i.test(raw.repeatedActionHash)
          ? raw.repeatedActionHash
          : null,
      repeatedActionCount: boundedStoredInteger(raw.repeatedActionCount, 0, 10),
      pendingApprovalHash:
        typeof raw.pendingApprovalHash === "string" && /^[a-f0-9]{64}$/i.test(raw.pendingApprovalHash)
          ? raw.pendingApprovalHash
          : null,
    };
  } catch {
    return null;
  }
}

export function createGoalController({
  workspace,
  tools = [],
  sessionStore,
  verificationTasks = ["test", "lint", "typecheck"],
  strictVerification = false,
  verifyCompletion,
  repeatLimit = DEFAULT_REPEAT_LIMIT,
  maxSessions = DEFAULT_MAX_SESSIONS,
  sessionTtlMs = DEFAULT_TTL_MS,
} = {}) {
  if (!Array.isArray(verificationTasks) || verificationTasks.some((task) => !["test", "lint", "build", "typecheck", "check"].includes(task))) {
    throw new TypeError("verificationTasks contains an unsupported project task");
  }
  positiveInteger(repeatLimit, "repeatLimit", 10);
  positiveInteger(maxSessions, "maxSessions", 1_000);
  if (!Number.isInteger(sessionTtlMs) || sessionTtlMs < 60_000 || sessionTtlMs > 7 * 24 * 60 * 60_000) {
    throw new RangeError("sessionTtlMs must be between 1 minute and 7 days");
  }

  const availableTools = toolMap(tools);
  const store = sessionStore ?? createMemoryGoalSessionStore();
  if (
    !store ||
    typeof store.loadAll !== "function" ||
    typeof store.save !== "function" ||
    typeof store.remove !== "function"
  ) {
    throw new TypeError("goal sessionStore must expose loadAll, save, and remove functions");
  }
  const sessions = new Map();
  const mutatingSessions = new Set();
  let storedSessions;
  try {
    storedSessions = store.loadAll();
  } catch (error) {
    if (store.persistent === true) throw error;
    storedSessions = [];
  }
  for (const raw of storedSessions) {
    const hydrated = hydrateStoredSession(raw, workspace);
    if (hydrated) sessions.set(hydrated.id, hydrated);
  }

  function persistSession(session) {
    try {
      const storedSession = { ...session };
      delete storedSession.projectContext;
      store.save(storedSession);
      return true;
    } catch {
      return false;
    }
  }

  function removeStoredSession(sessionId) {
    try {
      store.remove(sessionId);
    } catch {
      // Session eviction still proceeds in memory if persistent cleanup fails.
    }
  }

  function pruneExpired() {
    const cutoff = Date.now() - sessionTtlMs;
    for (const [id, session] of sessions) {
      if (session.updatedAt < cutoff) {
        sessions.delete(id);
        removeStoredSession(id);
      }
    }
  }

  function makeRoom() {
    pruneExpired();
    if (sessions.size < maxSessions) return true;
    const terminal = [...sessions.values()]
      .filter((session) => TERMINAL.has(session.status))
      .sort((a, b) => a.updatedAt - b.updatedAt);
    for (const session of terminal) {
      if (sessions.size < maxSessions) break;
      sessions.delete(session.id);
      removeStoredSession(session.id);
    }
    return sessions.size < maxSessions;
  }

  function find(sessionId) {
    pruneExpired();
    return sessions.get(sessionId) ?? null;
  }

  function beginMutation(session) {
    if (mutatingSessions.has(session.id)) {
      return {
        status: "operation_in_progress",
        mustContinue: false,
        sessionId: session.id,
        reason: "another goal_step or goal_finish operation is already in flight",
        session: sessionView(session),
      };
    }
    mutatingSessions.add(session.id);
    return null;
  }

  function start(input) {
    if (!makeRoom()) {
      return { status: "capacity_reached", mustContinue: false, reason: `goal session capacity (${maxSessions}) is full` };
    }
    const config = normalizeStart(input);
    const scopedConfig = workspace
      ? { ...config, cwd: validateGoalCwd(workspace, config.cwd) }
      : config;
    const projectContext = loadGoalProjectContext(workspace, scopedConfig.cwd);
    const now = Date.now();
    const session = {
      id: randomUUID(),
      ...scopedConfig,
      projectContext,
      status: "active",
      verified: false,
      createdAt: now,
      updatedAt: now,
      steps: 0,
      toolCalls: 0,
      sideEffectActionCount: 0,
      activeElapsedMs: 0,
      history: [],
      lastFeedback: null,
      pause: null,
      repeatedActionHash: null,
      repeatedActionCount: 0,
      pendingApprovalHash: null,
    };
    sessions.set(session.id, session);
    addEvent(session, {
      type: "goal_started",
      goal: session.goal,
      cwd: session.cwd,
      verificationProfile: session.verificationProfile,
      projectInstructionFiles: projectContext?.files?.map((entry) => entry.path) ?? [],
    });
    const persisted = persistSession(session);
    return {
      persistence: { kind: store.kind ?? "custom", persistent: store.persistent === true, saved: persisted },
      status: "active",
      mustContinue: true,
      sessionId: session.id,
      goal: session.goal,
      cwd: session.cwd,
      acceptanceCriteria: session.acceptanceCriteria,
      verificationProfile: session.verificationProfile,
      postcondition: session.postcondition,
      projectContext,
      next: "Read and follow projectContext instructions when present. Use goal_step for all goal-related tool actions, then call goal_finish only when the goal and every acceptance criterion appear complete.",
      budget: budget(session),
    };
  }

  async function step({ sessionId, tool, input }, trustedContext = {}) {
    const session = find(sessionId);
    if (!session) return { status: "not_found", mustContinue: false, sessionId };
    if (TERMINAL.has(session.status)) return { status: "already_terminal", mustContinue: false, session: sessionView(session) };
    if (session.status === "paused") return { status: "paused", mustContinue: false, session: sessionView(session) };
    const mutationBlock = beginMutation(session);
    if (mutationBlock) return mutationBlock;
    try {
      const stopped = stopForBudget(session);
      if (stopped) return stopped;
      if (typeof tool !== "string" || tool.length === 0) throw new TypeError("goal_step tool must be a non-empty string");
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("goal_step input must be an object");

      const selected = availableTools.get(tool);
      session.steps += 1;
      session.updatedAt = Date.now();
      if (!selected) {
        session.status = "active";
        session.lastFeedback = `tool '${tool}' is not available in goal mode`;
        addEvent(session, { type: "tool_input_error", tool, error: session.lastFeedback });
        return {
          status: "continue_required",
          mustContinue: true,
          sessionId,
          feedback: session.lastFeedback,
          budget: budget(session),
        };
      }

      let scopedInput = input;
      try {
        scopedInput = workspace
          ? scopeGoalToolInput({ workspace, goalCwd: session.cwd, toolName: tool, input })
          : input;
        validateJsonSchema(scopedInput, selected.inputSchema);
      } catch (error) {
        session.status = "active";
        session.lastFeedback = error instanceof Error ? error.message : String(error);
        addEvent(session, { type: "tool_input_error", tool, error: session.lastFeedback });
        return {
          status: "continue_required",
          mustContinue: true,
          sessionId,
          feedback: `Invalid or out-of-scope ${tool} input: ${session.lastFeedback}`,
          budget: budget(session),
        };
      }

      const actionProfile = classifyGoalAction({ tool, input: scopedInput });
      if (session.verificationProfile === "read-only-audit" && actionProfile.sideEffecting) {
        session.status = "active";
        session.lastFeedback = `read-only-audit verification profile forbids side-effecting Goal action '${tool}'`;
        addEvent(session, { type: "profile_action_blocked", tool, rule: actionProfile.rule });
        return {
          status: "continue_required",
          mustContinue: true,
          sessionId,
          feedback: session.lastFeedback,
          budget: budget(session),
        };
      }

      const actionHash = hash({ tool, input: scopedInput });
      const approvalRetry = session.status === "blocked_approval" && session.pendingApprovalHash === actionHash;
      if (approvalRetry) {
        session.steps = Math.max(0, session.steps - 1);
      } else {
        session.pendingApprovalHash = null;
        if (actionHash === session.repeatedActionHash) session.repeatedActionCount += 1;
        else {
          session.repeatedActionHash = actionHash;
          session.repeatedActionCount = 1;
        }
      }
      if (!approvalRetry && session.repeatedActionCount > repeatLimit) {
        session.status = "stalled";
        session.lastFeedback = `the same goal_step action repeated more than ${repeatLimit} times`;
        addEvent(session, { type: "stalled", tool, inputHash: actionHash });
        return {
          status: "stalled",
          mustContinue: false,
          sessionId,
          reason: session.lastFeedback,
          budget: budget(session),
        };
      }

      if (actionProfile.sideEffecting && !approvalRetry) session.sideEffectActionCount += 1;
      session.toolCalls += 1;
      const started = Date.now();
      let result;
      try {
        const goalTrustedContext = Object.freeze({
          ...trustedContext,
          goalSessionId: session.id,
          goalCwd: session.cwd,
        });
        result = await selected.invoke(scopedInput, goalTrustedContext);
      } catch (error) {
        result = { status: "tool_error", error: error instanceof Error ? error.message : String(error) };
      } finally {
        session.activeElapsedMs += Date.now() - started;
        session.updatedAt = Date.now();
      }
      addEvent(session, { type: "tool_result", tool, result: compactToolResult(result) });

      if (TERMINAL.has(session.status)) return terminalSessionResult(session);

      if (approvalBlock(result)) {
        session.status = "blocked_approval";
        session.pendingApprovalHash = actionHash;
        session.lastFeedback = "goal action requires host/user approval before it can proceed";
        return {
          status: "blocked_approval",
          mustContinue: false,
          needsApproval: true,
          sessionId,
          actionResult: result,
          budget: budget(session),
        };
      }

      session.status = "active";
      session.pendingApprovalHash = null;
      session.lastFeedback = null;
      return {
        status: "continue_required",
        mustContinue: true,
        sessionId,
        actionResult: result,
        next: "Continue with goal_step, or call goal_finish if the goal now appears complete.",
        budget: budget(session),
      };
    } finally {
      mutatingSessions.delete(session.id);
      persistSession(session);
    }
  }

  async function runVerificationChecks(session, trustedContext, postconditionEvidence) {
    const profileName = session.verificationProfile;
    if (profileName === "read-only-audit") {
      const clean = session.sideEffectActionCount === 0;
      return {
        passed: clean,
        verified: clean,
        checks: [],
        profile: { name: profileName, verified: clean, method: "read-only-invariant" },
        ...(clean ? {} : { feedback: "read-only-audit cannot complete after a tracked side-effecting Goal action" }),
      };
    }
    if (profileName === "system-operation") {
      const evidenced = typeof session.postcondition === "string" && typeof postconditionEvidence === "string";
      return {
        passed: true,
        verified: evidenced,
        checks: [],
        profile: { name: profileName, verified: evidenced, method: evidenced ? "postcondition-evidence" : null },
      };
    }

    const projectTask = availableTools.get("run_project_task");
    if (!projectTask || verificationTasks.length === 0) {
      return {
        passed: true,
        verified: false,
        checks: [],
        profile: { name: profileName, verified: false, method: null },
      };
    }
    const checks = [];
    for (const task of verificationTasks) {
      const stopped = stopForBudget(session);
      if (stopped) return { passed: false, terminal: stopped, checks, profile: { name: profileName, verified: false, method: "project-check" } };
      session.toolCalls += 1;
      const started = Date.now();
      let result;
      try {
        result = await projectTask.invoke({ task, cwd: session.cwd }, trustedContext);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        session.activeElapsedMs += Date.now() - started;
        if (TERMINAL.has(session.status)) {
          return { passed: false, terminal: terminalSessionResult(session), checks, profile: { name: profileName, verified: false, method: "project-check" } };
        }
        if (/no safe '.+' task was found/.test(message)) {
          checks.push({ task, status: "not_available", exitCode: null });
          continue;
        }
        return {
          passed: false,
          verified: true,
          checks,
          profile: { name: profileName, verified: false, method: "project-check" },
          feedback: `${task} verification failed to run: ${message}`,
        };
      }
      session.activeElapsedMs += Date.now() - started;
      if (TERMINAL.has(session.status)) {
        return { passed: false, terminal: terminalSessionResult(session), checks, profile: { name: profileName, verified: false, method: "project-check" } };
      }
      if (approvalBlock(result)) {
        return { passed: false, blocked: true, checks, result, profile: { name: profileName, verified: false, method: "project-check" } };
      }
      const passed = result.status === "completed" && result.exitCode === 0;
      checks.push(verificationCheck(task, result, !passed));
      if (!passed) {
        return {
          passed: false,
          verified: true,
          checks,
          profile: { name: profileName, verified: false, method: "project-check" },
          feedback: `${task} verification did not pass`,
        };
      }
    }
    const executed = checks.filter((check) => check.status !== "not_available");
    const verified = executed.length > 0;
    return {
      passed: true,
      verified,
      checks,
      profile: { name: profileName, verified, method: verified ? "project-check" : null },
    };
  }

  async function finish({ sessionId, summary, evidence = [], criteriaEvidence = [], postconditionEvidence }, trustedContext = {}) {
    const session = find(sessionId);
    if (!session) return { status: "not_found", mustContinue: false, sessionId };
    if (TERMINAL.has(session.status)) return { status: "already_terminal", mustContinue: false, session: sessionView(session) };
    if (session.status === "paused") return { status: "paused", mustContinue: false, session: sessionView(session) };
    const mutationBlock = beginMutation(session);
    if (mutationBlock) return mutationBlock;
    try {
      const stopped = stopForBudget(session);
      if (stopped) return stopped;
      if (typeof summary !== "string" || summary.trim().length === 0 || summary.trim().length > 32_768) {
        throw new TypeError("goal_finish summary must be a non-empty string up to 32768 characters");
      }
      if (
        !Array.isArray(evidence) ||
        evidence.length > 50 ||
        evidence.some((entry) => typeof entry !== "string" || entry.length === 0 || entry.length > 8_192)
      ) {
        throw new TypeError("goal_finish evidence must contain at most 50 non-empty strings up to 8192 characters");
      }
      let normalizedPostconditionEvidence = null;
      if (postconditionEvidence !== undefined && postconditionEvidence !== null) {
        if (typeof postconditionEvidence !== "string" || postconditionEvidence.trim().length === 0 || postconditionEvidence.trim().length > 8_192) {
          throw new TypeError("goal_finish postconditionEvidence must be a non-empty string up to 8192 characters when supplied");
        }
        if (session.verificationProfile !== "system-operation") {
          throw new TypeError("goal_finish postconditionEvidence is only valid for system-operation verification");
        }
        normalizedPostconditionEvidence = postconditionEvidence.trim();
      }
      if (
        !Array.isArray(criteriaEvidence) ||
        criteriaEvidence.length > 50 ||
        criteriaEvidence.some((entry) =>
          !entry ||
          typeof entry !== "object" ||
          Array.isArray(entry) ||
          typeof entry.criterion !== "string" ||
          entry.criterion.length === 0 ||
          entry.criterion.length > 8_192 ||
          typeof entry.satisfied !== "boolean" ||
          typeof entry.evidence !== "string" ||
          entry.evidence.length === 0 ||
          entry.evidence.length > 8_192
        )
      ) {
        throw new TypeError("goal_finish criteriaEvidence must contain at most 50 bounded criterion records");
      }
      session.steps += 1;
      session.updatedAt = Date.now();

      const acceptance = evaluateAcceptanceCriteria(session, criteriaEvidence);
      addEvent(session, { type: "acceptance_check", acceptance });
      if (!acceptance.passed) {
        session.status = "active";
        session.lastFeedback = acceptance.feedback;
        return {
          status: "continue_required",
          mustContinue: true,
          sessionId,
          feedback: acceptance.feedback,
          acceptance,
          next: "Satisfy every acceptance criterion with goal_step, then call goal_finish again with criteriaEvidence.",
          budget: budget(session),
        };
      }

      const checks = await runVerificationChecks(session, trustedContext, normalizedPostconditionEvidence);
      addEvent(session, { type: "verification", checks });
      if (checks.terminal) return checks.terminal;
      if (checks.blocked) {
        session.status = "blocked_approval";
        session.lastFeedback = "completion verification requires host/user approval";
        return {
          status: "blocked_approval",
          mustContinue: false,
          needsApproval: true,
          sessionId,
          verification: checks,
          budget: budget(session),
        };
      }
      if (!checks.passed) {
        session.status = "active";
        session.lastFeedback = checks.feedback;
        return {
          status: "continue_required",
          mustContinue: true,
          sessionId,
          feedback: checks.feedback,
          verification: checks,
          next: "Fix the verification failure with goal_step, then call goal_finish again.",
          budget: budget(session),
        };
      }

      const verifier = typeof trustedContext.verifyCompletion === "function"
        ? trustedContext.verifyCompletion
        : verifyCompletion;
      let custom = null;
      if (typeof verifier === "function") {
        const started = Date.now();
        let raw;
        try {
          raw = await verifier({
            goal: session.goal,
            cwd: session.cwd,
            acceptanceCriteria: session.acceptanceCriteria,
            criteriaEvidence: acceptance.evidence,
            summary: summary.trim(),
            evidence: evidence.slice(0, 50),
            verificationProfile: session.verificationProfile,
            postcondition: session.postcondition,
            postconditionEvidence: normalizedPostconditionEvidence,
            checks: checks.checks,
            history: session.history.slice(-40),
          });
        } catch (error) {
          if (TERMINAL.has(session.status)) return terminalSessionResult(session);
          const message = error instanceof Error ? error.message : String(error);
          session.status = "active";
          session.lastFeedback = `completion verifier failed to run: ${message}`;
          addEvent(session, { type: "verification_feedback", feedback: session.lastFeedback });
          return {
            status: "continue_required",
            mustContinue: true,
            sessionId,
            feedback: session.lastFeedback,
            verification: { ...checks, custom: null },
            budget: budget(session),
          };
        } finally {
          session.activeElapsedMs += Date.now() - started;
          session.updatedAt = Date.now();
        }
        if (TERMINAL.has(session.status)) return terminalSessionResult(session);
        custom = typeof raw === "boolean" ? { completed: raw } : raw;
        if (!custom || custom.completed !== true) {
          session.status = "active";
          session.lastFeedback = custom?.feedback ?? "trusted completion verifier rejected the goal finish";
          addEvent(session, { type: "verification_feedback", feedback: session.lastFeedback });
          return {
            status: "continue_required",
            mustContinue: true,
            sessionId,
            feedback: session.lastFeedback,
            verification: { ...checks, custom },
            budget: budget(session),
          };
        }
      }

      const verified = checks.verified || custom?.completed === true;
      const profileVerification = {
        ...checks.profile,
        verified,
        method: custom?.completed === true ? "trusted-verifier" : checks.profile?.method ?? null,
      };
      const verification = { ...checks, profile: profileVerification, custom };

      if (session.verificationProfile === "code-change" && session.sideEffectActionCount > 0 && !verified) {
        session.status = "active";
        session.lastFeedback = "code-change completion after side-effecting Goal actions requires a successful project check or trusted verifier";
        return {
          status: "continue_required",
          mustContinue: true,
          sessionId,
          feedback: session.lastFeedback,
          verification,
          budget: budget(session),
        };
      }
      if (session.verificationProfile === "system-operation" && !verified) {
        session.status = "active";
        session.lastFeedback = "system-operation completion requires postcondition evidence or a trusted verifier";
        return {
          status: "continue_required",
          mustContinue: true,
          sessionId,
          feedback: session.lastFeedback,
          verification,
          budget: budget(session),
        };
      }
      if (strictVerification && !verified) {
        session.status = "active";
        session.lastFeedback = "strict verification is enabled but no check or trusted verifier confirmed completion";
        return {
          status: "continue_required",
          mustContinue: true,
          sessionId,
          feedback: session.lastFeedback,
          verification,
          budget: budget(session),
        };
      }

      session.status = "completed";
      session.verified = verified;
      session.lastFeedback = null;
      session.updatedAt = Date.now();
      addEvent(session, {
        type: "goal_completed",
        summary: summary.trim(),
        verified,
        acceptance: acceptance.evidence,
      });
      return {
        status: "completed",
        mustContinue: false,
        sessionId,
        goal: session.goal,
        summary: summary.trim(),
        evidence: evidence.slice(0, 50),
        acceptance,
        verified,
        verification,
        budget: budget(session),
      };
    } finally {
      mutatingSessions.delete(session.id);
      persistSession(session);
    }
  }

  async function reclaimOwnedProcesses(session) {
    const processList = availableTools.get("process_list");
    const processKill = availableTools.get("process_kill");
    if (!processList || !processKill) {
      return {
        status: "not_available",
        runningFound: 0,
        attempted: 0,
        killed: 0,
        failed: 0,
        failures: [],
      };
    }

    const goalTrustedContext = Object.freeze({
      goalSessionId: session.id,
      goalCwd: session.cwd,
      goalMutationProtected: true,
    });
    try {
      const listed = await processList.invoke({}, goalTrustedContext);
      const running = (Array.isArray(listed?.processes) ? listed.processes : [])
        .filter((record) => record && record.status === "running" && typeof record.processId === "string")
        .slice(0, 256);
      const failures = [];
      let killed = 0;
      for (const record of running) {
        let result;
        try {
          result = await processKill.invoke({ processId: record.processId, force: true }, goalTrustedContext);
        } catch {
          result = { status: "tool_error" };
        }
        if (result?.status === "kill_requested" || result?.status === "already_terminal") {
          killed += 1;
        } else {
          failures.push({ processId: record.processId, status: result?.status ?? "tool_error" });
        }
      }
      return {
        status: failures.length > 0 ? "partial" : "completed",
        runningFound: running.length,
        attempted: running.length,
        killed,
        failed: failures.length,
        failures,
      };
    } catch {
      return {
        status: "partial",
        runningFound: 0,
        attempted: 0,
        killed: 0,
        failed: 1,
        failures: [{ processId: "process_list", status: "list_failed" }],
      };
    }
  }

  async function pause(input = {}) {
    const sessionId = input?.sessionId;
    const session = find(sessionId);
    if (!session) return { status: "not_found", mustContinue: false, sessionId };
    if (TERMINAL.has(session.status)) return terminalSessionResult(session);
    if (session.status === "paused") {
      return { status: "already_paused", mustContinue: false, session: sessionView(session, true) };
    }
    if (session.status !== "active") {
      return { status: "not_active", mustContinue: false, session: sessionView(session, true) };
    }
    const mutationBlock = beginMutation(session);
    if (mutationBlock) return mutationBlock;
    try {
      const recovery = normalizePauseInput(input);
      const processCleanup = await reclaimOwnedProcesses(session);
      if (processCleanup.status === "partial") {
        session.status = "active";
        session.updatedAt = Date.now();
        session.lastFeedback = "goal_pause could not safely reclaim every owned running process";
        addEvent(session, { type: "goal_pause_cleanup_failed", processCleanup });
        return {
          status: "continue_required",
          mustContinue: true,
          sessionId: session.id,
          feedback: session.lastFeedback,
          processCleanup,
          budget: budget(session),
        };
      }

      const pausedAt = Date.now();
      session.status = "paused";
      session.updatedAt = pausedAt;
      session.lastFeedback = null;
      session.pause = Object.freeze({ ...recovery, pausedAt });
      addEvent(session, { type: "goal_paused", pause: session.pause, processCleanup });
      return Object.freeze({ ...sessionView(session, true), processCleanup });
    } finally {
      mutatingSessions.delete(session.id);
      persistSession(session);
    }
  }

  async function resume(sessionId) {
    const session = find(sessionId);
    if (!session) return { status: "not_found", mustContinue: false, sessionId };
    if (TERMINAL.has(session.status)) return terminalSessionResult(session);
    if (session.status !== "paused") {
      return {
        status: "not_paused",
        mustContinue: session.status === "active",
        session: sessionView(session, true),
      };
    }
    const mutationBlock = beginMutation(session);
    if (mutationBlock) return mutationBlock;
    try {
      session.status = "active";
      session.updatedAt = Date.now();
      session.lastFeedback = null;
      addEvent(session, { type: "goal_resumed", pause: session.pause });
      return sessionView(session, true);
    } finally {
      mutatingSessions.delete(session.id);
      persistSession(session);
    }
  }

  function list({ cwd, limit = 20 } = {}) {
    pruneExpired();
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new RangeError("goal_list limit must be between 1 and 50");
    }
    let scopedCwd = null;
    if (cwd !== undefined) {
      if (typeof cwd !== "string" || cwd.length === 0 || cwd.length > 4_096 || cwd.includes("\0")) {
        throw new TypeError("goal_list cwd must be a non-empty string up to 4096 characters without NUL bytes");
      }
      scopedCwd = workspace ? validateGoalCwd(workspace, cwd) : cwd;
    }
    const ordered = [...sessions.values()]
      .filter((session) => session.status === "paused" && (scopedCwd === null || session.cwd === scopedCwd))
      .sort((a, b) => (b.updatedAt - a.updatedAt) || a.id.localeCompare(b.id));
    const bounded = ordered.slice(0, limit).map((session) => Object.freeze({
      sessionId: session.id,
      status: "paused",
      cwd: session.cwd,
      updatedAt: session.updatedAt,
      goal: session.goal.length <= 512 ? session.goal : `${session.goal.slice(0, 509)}...`,
    }));
    return Object.freeze({
      status: "completed",
      mustContinue: false,
      sessions: bounded,
      hasMore: ordered.length > bounded.length,
    });
  }

  function status(sessionId) {
    const session = find(sessionId);
    return session ? sessionView(session, true) : { status: "not_found", mustContinue: false, sessionId };
  }

  async function cancel(sessionId) {
    const session = find(sessionId);
    if (!session) return { status: "not_found", mustContinue: false, sessionId };
    if (TERMINAL.has(session.status)) return { status: "already_terminal", mustContinue: false, session: sessionView(session) };

    session.status = "canceled";
    session.updatedAt = Date.now();
    session.lastFeedback = "goal session canceled";

    const processCleanup = await reclaimOwnedProcesses(session);

    addEvent(session, { type: "goal_canceled", processCleanup });
    persistSession(session);
    return Object.freeze({ ...sessionView(session), processCleanup });
  }

  return Object.freeze({ start, step, finish, pause, resume, list, status, cancel });
}

export const goalControllerDefaults = Object.freeze({
  maxSteps: DEFAULT_MAX_STEPS,
  maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
  maxDurationMs: DEFAULT_MAX_DURATION_MS,
  repeatLimit: DEFAULT_REPEAT_LIMIT,
  maxSessions: DEFAULT_MAX_SESSIONS,
  sessionTtlMs: DEFAULT_TTL_MS,
});
