# Local File Broker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add App-owned, globally scoped non-sensitive file access and a Codex-like terminal approval policy without granting the Agent process broad filesystem or secret access.

**Architecture:** Electron main hosts the broker and approval state. Agent MCP tools send structured requests over a local bridge; main validates paths, stages bounded batches, invokes native confirmation, executes approved operations, and returns redacted results.

**Tech Stack:** Electron, Node.js, node:test, MCP SDK, existing Agent policy/approval modules.

**Spec:** `docs/superpowers/specs/2026-08-25-local-file-broker-design.md`

## Global Constraints

- Never expose secrets, Token values, shell strings, sudo, or broad filesystem grants to the Agent process.
- Default-deny sensitive paths; one-time native approval only.
- Maximum 20 destructive operations per batch; any SHA mismatch aborts the entire batch.
- Destructive operations, dependency installation, Git mutation, network, and external publication remain confirmation-gated in every approval mode.

---

### Task 1: Path policy and approval-mode primitives

**Files:** Create `src/local-policy.cjs`, `test/local-policy.test.cjs`; modify `src/main.cjs`.

- [ ] Write failing tests proving `.ssh`, `.env`, browser profiles, App secret stores, system paths, and symlink aliases are denied; prove non-sensitive paths are allowed and modes classify update/delete/network correctly.
- [ ] Run `node --test test/local-policy.test.cjs`; expect failure because the module is absent.
- [ ] Implement `classifyLocalPath`, `classifyLocalAction`, and `normalizeApprovalMode` with `cautious`, `development`, and `auto` values.
- [ ] Re-run the focused test; expect pass.
- [ ] Commit `feat: add local path policy and approval modes`.

### Task 2: Staged atomic filesystem broker

**Files:** Create `src/local-file-broker.cjs`, `test/local-file-broker.test.cjs`; modify `src/main.cjs`.

- [ ] Write failing tests for bounded list/read, SHA-bound stage/update/delete/move batches, a 20-item limit, cancellation, SHA invalidation, and all-or-none application.
- [ ] Run `node --test test/local-file-broker.test.cjs`; expect failure because the broker is absent.
- [ ] Implement `createLocalFileBroker({ policy, confirm, audit })` with `list`, `read`, `requestSensitiveAccess`, `stage`, and `confirmBatch`.
- [ ] Re-run focused tests; expect pass.
- [ ] Commit `feat: add confirmed local file broker`.

### Task 3: Terminal broker and native confirmation UI

**Files:** Create `src/local-terminal-broker.cjs`, `test/local-terminal-broker.test.cjs`; modify `src/main.cjs`, `src/preload.cjs`, `src/renderer/index.html`, `src/renderer/renderer.js`.

- [ ] Write failing tests showing argv-only input, existing command policy reuse, mode classification, and refusal of shell/sudo/network without confirmation.
- [ ] Run `node --test test/local-terminal-broker.test.cjs`; expect failure because the broker is absent.
- [ ] Implement host-native dialogs that display file batch or command metadata, require explicit approval, and persist only non-secret approval mode.
- [ ] Re-run focused tests; expect pass.
- [ ] Commit `feat: add approved local terminal broker`.

### Task 4: Bounded MCP client tools and verification

**Files:** Create `agent-runtime/src/local-broker-client.js`, `agent-runtime/test/local-broker-client.test.js`; modify `agent-runtime/src/tool.js`, `agent-runtime/src/server.js`, `agent-runtime/src/index.js`, `README.md`.

- [ ] Write failing schema tests proving token, arbitrary repository, shell, sudo, and approval-bypass fields are rejected.
- [ ] Run `npm --prefix agent-runtime test -- --test-name-pattern="local broker"`; expect failure.
- [ ] Register `local_list`, `local_read`, `local_request_sensitive_access`, `local_stage_changes`, `local_confirm_batch`, and argv-only terminal tools only when the host bridge is configured.
- [ ] Run `node --test test/*.test.cjs`, `npm --prefix agent-runtime test`, `npm --prefix agent-runtime run lint`, and `npm run pack`; expect all pass.
- [ ] Commit `feat: expose confirmed local management tools`.

## Plan self-review

- Tasks 1–2 cover global non-sensitive file access, sensitive single-use approval, SHA checks, batching, and auditing.
- Task 3 covers approval modes and terminal policy without shell or privilege escalation.
- Task 4 covers the Agent boundary, schemas, documentation, and full regression verification.
