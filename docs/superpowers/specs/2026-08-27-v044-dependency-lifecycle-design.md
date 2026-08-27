# WebGPT Bridge v0.4.4 Dependency Lifecycle Design

## Problem

A Windows v0.4.3 physical-host retest reproduced `dependency_sync` returning a connector-level `ExceptionGroup` while the underlying AppContainer `npm ci` continued for roughly 145 seconds and exited 0. The Goal session stayed mutation-locked until cancellation. This proves the failure is above npm itself: the dependency operation is coupled to one long MCP request and MCP request cancellation is not propagated into the runtime command lifecycle.

The v0.4.3 code allows dependency synchronization to wait up to ten minutes, but `server.js` registers tool callbacks as `async (args) => ...`, discarding the MCP v2 handler context. MCP SDK v2 exposes request cancellation as `ctx.mcpReq.signal`. Therefore a host deadline, transport close, or canceled tool call cannot currently abort a synchronous command.

## Goals

- Make dependency synchronization resilient to host/tool-call deadlines by returning a managed long-running process immediately after validation and approval.
- Preserve the dedicated network sandbox for dependency managers; public `process_start` must not gain network access.
- Preserve Windows trusted npm runtime staging and bundled-Node behavior.
- Propagate MCP v2 cancellation to synchronous command execution so canceled requests terminate their process tree.
- Make dependency processes visible to existing `process_poll`, `process_kill`, `process_list`, and Goal ownership/cancellation logic.
- Keep v0.4.3 immutable; ship the change only as v0.4.4 after cross-platform CI and release gates pass.

## Non-goals

- Do not change package-manager selection semantics.
- Do not relax approval policy or sandbox policy.
- Do not expose a model-controlled shell.
- Do not give arbitrary `process_start` invocations network access.
- Do not alter the Windows tray raster unless a new reproducible tray bug is found.
- Do not redesign updater publication semantics; the stable/latest release workflow remains authoritative.

## Design

### MCP request cancellation

`buildMcpServer` will register each tool with a callback that accepts `(args, ctx)`. It will construct trusted context from host approval plus `ctx?.mcpReq?.signal` when that value is an AbortSignal. Tool implementations may consume `trustedContext.signal`, but the signal is never part of model-controlled JSON input.

`createCommandRunner` will accept a trusted `signal` for each invocation. If already aborted, it returns a terminal canceled result without spawning. If abort fires after spawn, it kills the complete platform process tree and resolves with `status: "canceled"`. Timeout remains distinct as `status: "timed_out"`. The abort listener is removed on process close.

`run_command` and project-task execution will forward the trusted signal. This closes the generic synchronous-command cancellation gap without changing model schemas.

### Managed dependency operation

Dependency discovery remains in `dependency.js` and still produces the same ecosystem and argv values.

`createProcessManager.start` will gain an internal third `executionOptions` argument. It is not represented in any MCP schema. Internal callers can supply:

- a sandbox-adapter override;
- a trusted platform runtime stager;
- a process kind and bounded metadata.

The process manager will normalize the selected sandbox per start, resolve argv exactly as today, apply the trusted runtime stager before sandbox wrapping, build a command environment, and record the process in the same map used by normal managed processes. The record summary will include `kind` and bounded metadata so polling can identify dependency operations.

`dependency_sync` will no longer call `createDependencySyncRunner`. After network-sandbox availability and dependency discovery, it will call the existing shared `processManager.start` with:

- dependency argv;
- `CI=1`;
- the dedicated network sandbox override;
- Windows Node CLI runtime staging;
- `kind: "dependency_sync"`;
- metadata `{ ecosystem, allowScripts }`.

The call returns quickly with `status: "running"`, `processId`, and the existing `nextAction: process_poll`. Approval still occurs inside the process manager before spawn. Windows npm staging still happens before sandbox wrapping and must remain inside the workspace-owned `.webgpt-bridge/runtime/npm/...` tree.

Because dependency records live in the shared process manager, existing Goal-scoped `process_list` and `process_kill` can reclaim them. A Goal cancellation therefore terminates a running dependency operation without adding a second cancellation subsystem.

### Security invariants

- `executionOptions` is trusted in-process state only and never decoded from MCP arguments.
- The public process tool calls `processManager.start(input, trustedContext)` with no sandbox override, so it retains the normal no-network sandbox.
- `dependency_sync` is the only core tool that passes the network-sandbox override.
- Windows npm/npx still pass through `stageWindowsNodeCliRuntime`; no shell fallback is introduced.
- Approval continues to bind the logical and resolved argv, cwd, environment, and sandbox state before execution.

## Tests

The regression suite must prove the bug before implementation and then prove the fix:

1. MCP server tool callback forwards `ctx.mcpReq.signal` as trusted context.
2. `createCommandRunner` returns `canceled` and terminates the child process tree when the trusted signal aborts.
3. `dependency_sync` returns a managed `running` result instead of synchronously awaiting package-manager completion.
4. The dependency process uses a network-sandbox override while public `process_start` remains on the normal sandbox.
5. Windows npm dependency startup still invokes trusted runtime staging.
6. Dependency records remain Goal-owned and `goal_cancel` reclaims them through existing process-list/process-kill behavior.
7. Existing timeout, PTY, process-group, dependency discovery, installer, tray, updater, and release tests remain green.

## Release and acceptance

The fix lands through a PR so GitHub Actions runs Linux agent tests, Windows x64/AppContainer/standard-user/build, and macOS Universal build. After merge, desktop version metadata and the explicit version contract are bumped to 0.4.4. A new immutable `v0.4.4` tag triggers the formal release workflow. The release is acceptable only when verify, Windows, macOS, publish, updater metadata, Universal architecture validation, installer lifecycle smoke, and checksums succeed.

After publication, physical-host retesting must upgrade Windows and macOS from v0.4.3 to v0.4.4 and repeat dependency lifecycle, cancellation, PTY, timeout, restart/reconnect, updater, and platform-specific checks. If local-host connectors are unavailable, those physical-host items remain explicitly environment-blocked rather than inferred from CI.
