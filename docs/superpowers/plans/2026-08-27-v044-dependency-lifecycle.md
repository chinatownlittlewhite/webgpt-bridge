# WebGPT Bridge v0.4.4 Dependency Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make long dependency synchronization a managed, cancellable operation while preserving sandbox, approval, Windows bundled-Node staging, and Goal cleanup guarantees.

**Architecture:** Propagate MCP v2 request cancellation into trusted tool context for synchronous commands, and route `dependency_sync` through the existing shared process manager using an internal-only network-sandbox override. Keep dependency records in the same process inventory so `process_poll`, `process_kill`, and Goal cancellation work without a parallel lifecycle system.

**Tech Stack:** Node.js 22+, MCP TypeScript SDK v2, Electron 40, node:test, existing native sandbox/process-tree abstractions, GitHub Actions Windows/macOS/Linux release pipeline.

**Spec:** `docs/superpowers/specs/2026-08-27-v044-dependency-lifecycle-design.md`

## Global Constraints

- v0.4.3 tag and Release are immutable.
- Public `process_start` must retain the normal non-network sandbox.
- `dependency_sync` alone may use the dedicated verified network sandbox.
- Windows npm/npx must continue through trusted runtime staging and bundled Node behavior; no shell fallback.
- Approval semantics and exact-request binding must not be relaxed.
- A canceled synchronous request must terminate its full process tree and return a terminal canceled result distinct from timeout.
- Release only as desktop v0.4.4 after PR CI and formal release gates pass.

---

### Task 1: Add RED cancellation and managed-dependency contracts

**Files:**
- Modify: `agent-runtime/test/runner.test.js`
- Modify: `agent-runtime/test/tool.test.js`
- Replace: `agent-runtime/test/dependency-timeout.test.js`
- Create or modify: `agent-runtime/test/server-context.test.js`

**Interfaces:**
- Consumes: existing `createCommandRunner`, `createCoreTools`, `buildMcpServer`/server registration behavior.
- Produces: failing tests that require `trustedContext.signal`, managed dependency results, and network-sandbox isolation.

- [ ] Add a runner test that starts a long Node child, aborts an `AbortController`, and expects `status === "canceled"` with the child no longer live.
- [ ] Add a tool test with a fake shared process manager whose `start` records its third internal execution-options argument; invoke `dependency_sync` and require `kind === "dependency_sync"`, network sandbox override, `CI=1`, and immediate `status: "running"`.
- [ ] Add a sibling process-start assertion proving the public process tool never supplies a sandbox override.
- [ ] Replace the old source-regex timeout test with a behavioral contract that dependency sync delegates to managed execution rather than awaiting `createCommandRunner`.
- [ ] Add an MCP handler-context test that invokes a registered tool callback with `{ mcpReq: { signal } }` and asserts the tool receives that exact signal in trusted context.
- [ ] Commit these tests before production changes and open a PR so CI records the expected RED failures.

### Task 2: Propagate trusted MCP cancellation into synchronous runners

**Files:**
- Modify: `agent-runtime/src/server.js`
- Modify: `agent-runtime/src/runner.js`
- Modify: `agent-runtime/src/tool.js`
- Modify: `agent-runtime/src/project-task.js`

**Interfaces:**
- Consumes: MCP v2 callback `(args, ctx)` and `ctx.mcpReq.signal`.
- Produces: `trustedContext.signal`; `createCommandRunner(...)(..., {signal})` behavior through tool forwarding.

- [ ] Change `buildMcpServer` tool callbacks to accept `ctx`, validate `ctx?.mcpReq?.signal` as an AbortSignal-like object, and include it in trusted context alongside host approval.
- [ ] Extend command-run input to accept a trusted non-schema `signal` argument.
- [ ] Before spawn, return a canceled terminal result if the signal is already aborted.
- [ ] After spawn, attach one abort listener that marks the operation canceled, kills the full process tree with existing `killProcessTree`, and is removed when the child closes.
- [ ] Preserve timeout precedence separately: timeout sets `timedOut`, abort sets `canceled`, and close maps to `spawn_error`, `canceled`, `timed_out`, or `completed` deterministically.
- [ ] Forward `trustedContext.signal` through `run_command` and project-task execution.
- [ ] Run the targeted runner/server/tool tests and the full agent test suite; commit only when green.

### Task 3: Add internal process-manager execution options

**Files:**
- Modify: `agent-runtime/src/process-manager.js`
- Modify: `agent-runtime/test/process-manager.test.js`

**Interfaces:**
- Consumes: `start(input, trustedContext, executionOptions)` where execution options are in-process only.
- Produces: shared records with `kind`, bounded `metadata`, optional sandbox override, and optional trusted platform-runtime stager.

- [ ] Add failing process-manager tests proving an internal sandbox override changes only that spawned process and that default starts remain on the manager's normal sandbox.
- [ ] Add a trusted runtime-stager test that rewrites a resolved argv and prove the staged argv is what reaches sandbox wrapping/spawn metadata.
- [ ] Normalize the per-start sandbox from `executionOptions.sandboxAdapter ?? defaultSandboxAdapter` and compute policy/sandbox summary from that selected sandbox.
- [ ] Call the trusted runtime stager after platform resolution and before sandbox wrapping, mirroring command-runner ordering.
- [ ] Store `kind` (default `"process"`) and bounded plain-object metadata in the record and summary; reject unsafe/non-plain metadata.
- [ ] Keep public `process_start` unchanged so no model input can populate execution options.
- [ ] Run process-manager tests and full agent tests; commit when green.

### Task 4: Convert dependency_sync to managed network execution

**Files:**
- Modify: `agent-runtime/src/dependency.js`
- Modify: `agent-runtime/src/tool.js`
- Modify: `agent-runtime/src/core-tools.js` or the existing `createCoreTools` composition site if dependency/process injection is there.
- Modify: `agent-runtime/test/tool.test.js`
- Modify: `agent-runtime/test/dependency-timeout.test.js`

**Interfaces:**
- Consumes: shared `processManager.start(input, trustedContext, executionOptions)`, `discoverDependencySync`, `stageWindowsNodeCliRuntime`.
- Produces: `dependency_sync` result with `status: "running"`, `processId`, `nextAction`, `ecosystem`, and `allowScripts` while process polling uses the existing process tools.

- [ ] Inject the shared process manager into dependency-tool construction.
- [ ] Keep the network-sandbox availability diagnostic unchanged.
- [ ] Discover argv/ecosystem exactly as today, then call shared process manager with `env: {CI: "1"}` and internal options `{ sandboxAdapter: networkSandboxAdapter, platformRuntimeStager: stageWindowsNodeCliRuntime, kind: "dependency_sync", metadata: { ecosystem, allowScripts } }`.
- [ ] Enrich the immediate start result with ecosystem/allowScripts without awaiting process completion.
- [ ] Add Windows-specific tests that the npm managed start invokes trusted staging and never executes a `.cmd` shell shim.
- [ ] Add Goal-oriented coverage showing a dependency record owned by a Goal is returned by process_list and reclaimed by goal_cancel through process_kill.
- [ ] Run targeted and full test/lint/contract/build/acceptance:quick checks; commit when green.

### Task 5: Regression-gate desktop/platform concerns without speculative behavior changes

**Files:**
- Modify only if a failing test demonstrates a gap: `test/tray-icon.test.cjs`, `test/update-service.test.cjs`, `scripts/windows-installer-smoke.ps1`, release validation tests.

**Interfaces:**
- Consumes: existing tray PNG, updater state machine, SYSTEM host-prep task, installer lifecycle.
- Produces: additional assertions only where current acceptance requirements lack automation.

- [ ] Re-run tray raster format/dimensions/visibility/contrast tests and main-process NativeImage contract.
- [ ] Re-run updater up-to-date/install-restart tests and release metadata validators.
- [ ] Re-run Windows helper task principal/action/arguments/boot-trigger and protected-path installer smoke assertions.
- [ ] Do not change production behavior unless one of these tests reproduces a concrete defect.

### Task 6: PR verification and merge

**Files:** none unless CI exposes a real defect.

- [ ] Confirm PR workflow runs Linux Agent runtime, Windows x64/AppContainer, and macOS Universal jobs.
- [ ] Inspect every failed job log; fix root causes with a new failing regression test before production changes.
- [ ] Require all PR jobs green with fresh evidence.
- [ ] Review changed-file diff for accidental sandbox/approval/network broadening.
- [ ] Merge the PR only after all checks pass.

### Task 7: Prepare immutable v0.4.4 release metadata

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `test/version-contract-v041.test.cjs`

- [ ] On a release-prep branch from the merged main, change desktop version from 0.4.3 to 0.4.4 in package metadata and lockfile.
- [ ] Update explicit version-contract test text/assertions to 0.4.4 while retaining Agent 0.9.1 unless the implementation itself required an Agent version bump contract.
- [ ] Run PR CI again for the release-prep change and merge only when green.
- [ ] Create a new immutable `v0.4.4` tag at the exact merged release commit; never move v0.4.3.

### Task 8: Formal v0.4.4 release verification

**Files:** none unless release workflow uncovers a defect.

- [ ] Verify formal tag workflow `verify` passes version/tag, desktop verification, agent tests, lint, and contract.
- [ ] Verify Windows job passes native host build/prep, standard-user acceptance, dist:win, NSIS custom-path install/repair/uninstall smoke, bundled Node checks, and cleanup.
- [ ] Verify macOS job passes Universal build and arm64+x86_64 checks for App/tunnel/cloudflared.
- [ ] Verify publish job validates exact Windows/macOS assets, writes SHA256SUMS, uploads metadata, and atomically marks v0.4.4 stable/latest.
- [ ] Fetch the published Release and confirm `latest.yml` and `latest-mac.yml` are v0.4.4 assets.

### Task 9: Physical-host upgrade/retest

**Files:** none.

- [ ] Re-discover `macmini` and `laptop` local-host connectors after publication.
- [ ] Windows: update installed v0.4.3 to v0.4.4; verify custom install path, bundled Node 22.23.2 path/version, Agent/tunnel recovery, managed dependency `running -> poll -> completed`, Goal cancellation, timeout, PTY/process-group kill, updater up-to-date behavior, helper/task boundaries, install size, old-file cleanup, and tray visual evidence if screen access exists.
- [ ] macOS: update v0.4.3 to v0.4.4; verify installed version, Universal architectures, Agent/tunnel recovery, dependency lifecycle, Goal cancel, timeout, PTY/process-group kill, updater up-to-date behavior, and old-version cleanup.
- [ ] Mark any unavailable host connector or non-observable tray pixel item explicitly as environment-blocked rather than passing by CI inference.
