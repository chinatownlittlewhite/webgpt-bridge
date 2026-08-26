# Windows Sandbox ACL Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove Windows sandbox ACL mutations against system/shared executables while preserving fail-closed AppContainer execution, structured diagnostics, and release gating for supported external tools.

**Architecture:** Keep the existing native AppContainer launcher and `CreateProcessW` security-capability model. Restrict DACL mutation to workspace-owned paths only; external executables and external read dependencies are never passed to `SetNamedSecurityInfoW`. Extend diagnostics and Windows acceptance so ACL initialization failures are explicit and `cmd.exe`, `git.exe`, `dotnet.exe`, `node.exe`, and Program Files `gh.exe` are exercised under a standard non-admin AppContainer path without persistent ACL changes.

**Tech Stack:** C#/.NET 8 native helper, Node.js ESM runtime/tests, GitHub Actions Windows runner.

**Spec:** `docs/superpowers/specs/2026-08-25-windows-runtime-remediation-design.md`

## Global Constraints

- Preserve agent-runtime version `0.9.0` and the existing public 23-tool surface.
- External executables and shared runtime files must never be persistent ACL mutation targets.
- ACL mutation is allowed only for workspace-owned paths and workspace-local sandbox state created by Bridge; reparse-point/junction paths must fail closed before DACL mutation.
- Do not weaken AppContainer, Job Object, approval, workspace confinement, or normal-sandbox network denial.
- Do not add host-execution fallback for commands that fail in AppContainer.
- Windows acceptance remains the authoritative release gate.

---

### Task 1: Lock the ACL boundary with failing tests

**Files:**
- Modify: `agent-runtime/test/sandbox.test.js`
- Test: `agent-runtime/test/sandbox.test.js`

**Interfaces:**
- Consumes: native helper source contract in `agent-runtime/native/windows-sandbox/Program.cs`.
- Produces: regression assertions that external executable/read paths cannot trigger `GrantAcl`, while workspace/write paths remain explicit ACL mutation targets.

- [ ] **Step 1: Replace the old source-contract assertion that requires `GrantAcl(executable, ...)` with assertions that forbid it and require workspace-scoped ACL guarding.**
- [ ] **Step 2: Run `node --test test/sandbox.test.js` and confirm the new ACL-boundary test fails against the current helper.**
- [ ] **Step 3: Keep the failing output as root-cause evidence before implementation.**

### Task 2: Restrict native ACL mutation to workspace-owned paths

**Files:**
- Modify: `agent-runtime/native/windows-sandbox/Program.cs`
- Test: `agent-runtime/test/sandbox.test.js`

**Interfaces:**
- Consumes: `workspace`, `executable`, `ReadPaths`, `WritePaths`, existing `IsInside`, `GrantAcl`, and AppContainer SID.
- Produces: a helper flow where `SetNamedSecurityInfoW` is reachable only for workspace-owned targets; external executable and external read paths bypass ACL mutation and proceed directly to `CreateProcessW` under AppContainer.

- [ ] **Step 1: Remove the unconditional executable ACL mutation.**
- [ ] **Step 2: Gate read/write ACL mutations with the canonical workspace containment check; external read paths receive no DACL writes, external write paths fail closed, and any reparse-point/junction in an ACL target path fails closed before mutation.**
- [ ] **Step 3: Preserve workspace ACL initialization for newly created profiles and workspace-local write grants.**
- [ ] **Step 4: Run `node --test test/sandbox.test.js` and confirm the ACL-boundary tests pass.**

### Task 3: Promote ACL initialization failures into structured diagnostics

**Files:**
- Modify: `agent-runtime/native/windows-sandbox/Program.cs`
- Modify: `agent-runtime/src/native-sandbox.js`
- Modify: `agent-runtime/test/windows-remediation.test.js`
- Test: `agent-runtime/test/windows-remediation.test.js`

**Interfaces:**
- Consumes: native helper stderr/exit code and sandbox preparation diagnostic mapping.
- Produces: stable `sandbox_initialization_error` diagnostics carrying Win32 API name, target path, Win32 code, and reason when helper initialization fails before target launch.

- [ ] **Step 1: Add a failing test for Win32 error 5 / `SetNamedSecurityInfoW` diagnostic classification.**
- [ ] **Step 2: Run the focused remediation test and confirm RED.**
- [ ] **Step 3: Add minimal helper/runtime diagnostic formatting/mapping without changing successful command behavior.**
- [ ] **Step 4: Run the focused remediation test and confirm GREEN.**

### Task 4: Expand Windows release acceptance for external executables

**Files:**
- Modify: `agent-runtime/scripts/acceptance.mjs`
- Modify: `agent-runtime/test/acceptance-script.test.js`
- Test: `agent-runtime/test/acceptance-script.test.js`

**Interfaces:**
- Consumes: built Windows helper, trusted command resolution, normal AppContainer verification.
- Produces: Windows-only release checks for `cmd.exe`, `git.exe`, `dotnet.exe`, `node.exe`, and resolved `gh.exe` when present, with no persistent ACL mutation requirement.

- [ ] **Step 1: Add failing source-contract tests requiring the five non-admin external-tool smoke checks and ACL-boundary assertion.**
- [ ] **Step 2: Run `node --test test/acceptance-script.test.js` and confirm RED.**
- [ ] **Step 3: Implement bounded Windows smoke checks; optional tools are skipped only when capability policy explicitly allows absence, while required local execution paths fail the release gate.**
- [ ] **Step 4: Run `node --test test/acceptance-script.test.js` and confirm GREEN.**

### Task 5: Full regression, commit, and PR update

**Files:**
- Verify all modified files.

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: a clean feature branch and updated PR #4.

- [ ] **Step 1: Run `npm test` in `agent-runtime`.**
- [ ] **Step 2: Run `npm run acceptance:quick` in `agent-runtime`.**
- [ ] **Step 3: Run `npm run verify:desktop` at repository root.**
- [ ] **Step 4: Run `git diff --check` and remove generated `.local/state/gh/device-id` if present.**
- [ ] **Step 5: Commit the implementation with a focused message.**
- [ ] **Step 6: Push `windows-runtime-remediation` through the structured Git broker and confirm PR #4 head/CI state.**
