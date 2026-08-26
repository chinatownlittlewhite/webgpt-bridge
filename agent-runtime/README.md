# WebGPT Bridge

Safety-first local coding-agent runtime designed for ChatGPT/MCP and external agent hosts.

## Release status

Current version: **v0.9.0 Final Acceptance Candidate**.

The machine-verifiable release matrix and sign-off rules are recorded in `FINAL_ACCEPTANCE.md`.

v0.9 freezes the intended public tool surface and shifts the project from feature development to release verification. A platform is not considered finally accepted until `npm run acceptance` exits with code `0` on that real target OS.

The final-acceptance targets are:

- Windows native: AppContainer + workspace/runtime ACLs + Job Object + parent-process crash cleanup
- macOS native: Seatbelt policy + verified filesystem/network isolation + parent-process guard
- Linux: Bubblewrap namespace sandbox
- MCP protocol: current v2 server/client path using protocol revision `2026-07-28`
- explicit persistent Goal Mode
- long-running process/PTY lifecycle management
- structured Git/worktree support
- external autonomous orchestrator and host-only multi-agent worktree coordinator
- hash-chained audit log

## Frozen MCP tool surface

The v0.9 MCP server exposes these 23 tools. The final three inspection primitives were added before acceptance freeze so an agent never needs command execution merely to inspect source code:

```text
run_command
run_project_task
git
dependency_sync
github
process_start
process_poll
process_input
process_kill
process_list
read_file
list_dir
search_text
search_files
apply_patch
delete_file
move_file
goal_mode
goal_step
goal_finish
goal_status
goal_cancel
get_capabilities
```

Host-only orchestration APIs such as the external orchestrator and multi-agent coordinator are intentionally **not** model-facing MCP tools.

## Core security model

Security controls are layered and are not substitutes for one another:

```text
model input/schema
  -> workspace/goal scope validation
  -> structured command/tool policy
  -> exact request-bound host approval when required
  -> verified native OS sandbox
  -> child process / process tree
  -> bounded result + audit record
```

### No model-controlled shell

Model-provided commands remain argv-based and use `shell: false`.

The model cannot choose an arbitrary executable path. Commands are resolved through a trusted host PATH. Unknown `.cmd`/`.bat` execution on Windows is rejected rather than routed through `cmd.exe /c`.

Windows package-manager shims use trusted resolution where available, for example:

```text
npm / npx -> node.exe + npm-cli.js / npx-cli.js
pnpm       -> trusted pnpm JS/runtime shim
python3    -> trusted python.exe or py.exe -3
```

Resolved runtime paths are host-derived and may be passed to the Windows sandbox as trusted read-only paths. Model input cannot request arbitrary host read permissions.

### Exact request-bound approval

Approval is never a model schema field. Do not introduce `approvalGranted: true`.

Approval requests are derived from the exact effective operation, including:

- original argv
- platform-resolved argv
- platform
- normalized cwd
- allowed model environment additions
- command policy
- sandbox identity/fingerprint
- trusted host-only extra sandbox read/write grants when an internal structured operation needs them

Changing any of those values changes the approval id.

The MCP server translates an `approval_required` result into MCP multi-round `input_required` and binds the confirmation to the tool name, input hash, and exact approval id with signed `requestState`.

### Workspace and project scope

The configured top-level workspace may be broad, such as:

```text
/Users/name/Desktop
```

A selected project cwd remains the task boundary. Command sandboxes use the resolved command cwd as their normal writable/readable project root instead of automatically exposing the broad parent workspace.

Goal Mode further rewrites and validates tracked tool paths relative to its goal cwd. Sibling projects must not be reachable through normal goal actions.

### Workspace inspection and context-window discipline

The runtime now has direct bounded inspection tools:

```text
read_file
list_dir
search_text
search_files
```

`read_file` returns line/byte metadata, a raw-file SHA-256, and an executable `nextAction` when another line-range call is the natural continuation. `list_dir`, `search_text`, and `search_files` are bounded and do not follow symlinks. Recursive inspection skips common VCS/dependency/build/cache trees by default unless explicitly requested.

MCP `content` is intentionally concise and agent-readable rather than a JSON copy of the full result. The complete stable object remains in `structuredContent`. Process and pageable read results expose executable continuation metadata where appropriate.

The server also loads bounded root/ancestor `AGENTS.md` and `CLAUDE.md` project instructions. Root workspace instructions are included in MCP server instructions; starting Goal Mode for a selected project cwd returns that project's bounded context and indexes deeper instruction files without eagerly injecting all of them.

### File mutation safety

- `apply_patch` uses structured multi-file changes
- updates/deletes require SHA-256 preconditions and recheck the baseline immediately before commit
- updates are prepared in same-directory temporary files, fsynced, and atomically replaced
- existing UTF-8 BOM, CRLF/LF newline style, and mode bits are preserved
- `delete_file` and `move_file` require current SHA-256 values
- multi-file rollback is attempted in reverse order and rollback failure is reported explicitly
- file discovery does not follow symlinks by default

## Native sandboxing

An adapter being present does **not** mean unattended execution is permitted.

Every native adapter starts with:

```text
autoRunSafe = false
```

The host must run `verifySandboxAdapter(...)` and only promote the exact fingerprinted adapter after the probe verifies the required isolation.

The release acceptance probe checks at least:

```text
workspace write succeeds
outside read is blocked
outside write is blocked
network access is blocked for the normal sandbox
```

If discovery or verification fails, unattended execution fails closed and safe-looking commands remain approval-required.

### Windows native

Windows uses a native .NET 8 helper under:

```text
native/windows-sandbox/
```

The intended boundary is:

```text
trusted argv resolver
  -> AppContainer security capabilities
  -> workspace ACL
  -> trusted runtime read ACLs
  -> host-only extra write ACLs for managed metadata when required
  -> Windows Job Object
  -> parent PID monitor
  -> CreateProcessW without model-controlled shell
```

Network capability is omitted by default. The helper receives the MCP/server parent PID; if the parent exits unexpectedly, it terminates the sandbox Job Object so long-running descendants do not become orphaned.

Build it on Windows with:

```text
npm run build:native
```

The expected output is:

```text
native/windows-sandbox/bin/release/lpc-windows-sandbox.exe
```

Windows support is not considered verified until the helper compiles on Windows and `npm run acceptance` passes the real AppContainer probes.

### macOS native

macOS uses a deny-default Seatbelt profile through the available system launcher. The policy restricts writes to the selected project root plus explicitly trusted host-only metadata grants and denies network for the normal command sandbox.

A trusted `parent-guard.js` wrapper monitors the MCP parent process so an abnormal host exit terminates the child process group.

The `sandbox-exec` launcher is deprecated by Apple, so this implementation is treated as a verified current backend rather than a promise that the launcher is a permanent future API. Final macOS acceptance requires the real Seatbelt probe to pass.

### Linux

Linux uses Bubblewrap with mount allowlisting, workspace binding, user/PID/IPC/UTS isolation, network namespace isolation for normal commands, `--new-session`, and `--die-with-parent`.

## Project tasks

`run_project_task` is cwd-aware and discovers bounded project checks:

```json
{
  "task": "test",
  "cwd": "chatgpt-web-mcp-project"
}
```

Supported task names:

```text
test
lint
build
typecheck
check
```

Discovery covers common Node, Python, Rust, Go, and Make-based projects.

## Structured Git and worktrees

The model-facing `git` tool exposes a bounded action set rather than arbitrary Git command strings. Mutations remain subject to runner policy, exact approval, and sandboxing.

Managed worktree support exists for isolated parallel agent work. Linked worktree Git metadata is detected only for the project-managed `.webgpt-bridge/worktrees/...` layout. The runtime does not trust an arbitrary repository-controlled `.git` pointer as permission to open unrelated host directories.

Some managed worktree operations need tightly scoped host-only sandbox write grants for Git metadata and the managed target path. These grants do not exist in model schemas and are part of the approval hash.

## Networked operations

Ordinary `run_command` stays on the normal network-denied sandbox.

Networked functionality is separated into structured tools:

```text
dependency_sync
github
```

They can use a separately configured network-enabled sandbox and remain approval-controlled. Dependency syncing defaults to disabling package install scripts unless the caller explicitly requests them and the resulting operation is approved.

GitHub support is intentionally structured around bounded `gh` operations such as PR, CI, and issue workflows.

## Long-running processes and PTY

The managed process layer provides:

```text
process_start
process_poll
process_input
process_kill
process_list
```

It supports bounded buffered output and optional PTY support through `node-pty`/ConPTY when available.

Process launch reuses the same command policy, executable resolution, approval, sandbox, workspace, and audit controls as one-shot command execution.

Processes started inside a Goal session are owned by that goal. Other goal sessions cannot poll, write to, or kill them through the goal-scoped tool path.

`goal_cancel` enumerates only processes visible to the canceled session and force-requests termination for each running owned process. Sibling Goal processes remain invisible and untouched. Cleanup failures do not reactivate the Goal: cancellation stays terminal and returns a bounded `processCleanup` summary with `partial` status when necessary.

Normal MCP server shutdown calls the process manager cleanup path. Native/parent guards provide additional crash cleanup for sandboxed children.

## Goal Mode

The default ChatGPT/MCP architecture uses explicit server-side sessions:

```text
goal_mode
  -> goal_step*
  -> goal_finish
```

with:

```text
goal_status
goal_cancel
```

A started goal returns an opaque `sessionId` plus `mustContinue: true`.

### Completion behavior

`goal_finish` is the normal completion path. It can require:

- matching `acceptanceCriteria` evidence
- project verification tasks such as test/lint/typecheck
- a trusted host verifier

When strict verification is enabled, the goal cannot complete merely because the model says it is done.

Failed verification returns `continue_required`; the agent must continue fixing the project and retry `goal_finish`.

### Budgets and anti-loop controls

Goal sessions are bounded by:

- steps
- tool calls
- active execution duration
- history/event sizes
- repeated identical actions
- total stored sessions
- TTL

Default goal budgets are:

```text
50 steps
100 tool calls
10 minutes active execution
3 repeated identical actions before stalled
```

Approval pause/retry is recognized as the same logical goal action: retrying the exact blocked action after approval does not consume an extra Goal step or trigger repeat-action stalling, although the real second tool execution still consumes the tool-call budget.

### Persistence

Production runtime enables file-backed Goal persistence by default under:

```text
.webgpt-bridge/goals
```

Persisted JSON is treated as untrusted input and is revalidated on load. Path scope, budgets, history bounds, timestamps, and status are normalized again.

The final acceptance harness explicitly starts a Goal, restarts the built MCP server, and verifies that the same session can be recovered and completed.

### ChatGPT web: do not ask for "continue"

The intended interaction is a same-assistant-turn loop:

```text
user asks once
  -> goal_mode
  -> goal_step
  -> goal_step
  -> goal_finish
  -> continue_required => continue goal_step/goal_finish in the same assistant turn
  -> completed => emit one final answer
```

The package exports `goalModeHostInstructions`. The production MCP server also supplies these instructions and the Goal tool descriptions/results repeat the same rule.

Critical behavior:

```text
If mustContinue=true or status=continue_required,
do not finalize and do not ask the user to type "continue".
Continue the goal tool loop in the same assistant turn.
```

Once ChatGPT has already ended an assistant turn, an MCP server cannot independently create a new turn. Persistent Goal sessions preserve state, but guaranteed autonomous continuation across completed assistant turns requires an external host/orchestrator.

## External autonomous orchestration

The host-only API exports `createExternalGoalOrchestrator(...)`. It drives the same explicit Goal sessions across model turns and therefore keeps all existing Goal cwd, approval, verification, persistence, and budget controls.

It is intended for your own worker/desktop host/Responses API loop rather than recursive MCP model sampling.

## Multi-agent host mode

The host-only `createMultiAgentCoordinator(...)` runs several agent specifications in isolated managed Git worktrees. Each agent gets an independent Goal session and branch.

The coordinator does **not** automatically merge agent branches. It returns the worktree/branch/results to the primary host so integration remains explicit and auditable.

## Audit log

Production runtime enables a workspace-local hash-chained JSONL audit log by default:

```text
.webgpt-bridge/audit.jsonl
```

Each entry includes:

```text
sequence
previousHash
hash
sanitized event
```

Common secret-bearing keys are redacted and oversized event payloads are replaced with bounded hash summaries.

`npm run acceptance` validates the hash chain.

## Production MCP server

The built entrypoint is:

```text
dist/server.js
```

Default local endpoint:

```text
http://127.0.0.1:8787/mcp
```

Health endpoint:

```text
/healthz
```

Loopback mode uses localhost Host/Origin validation. A non-loopback bind requires at least:

```text
LPC_MCP_TOKEN=<strong bearer token>
LPC_ALLOWED_HOSTS=host.example.com[,other.example.com]
```

Optionally restrict origins too. MCP node middleware expects allowed-origin **hostnames** (port-agnostic), not full URL strings:

```text
LPC_ALLOWED_ORIGINS=chatgpt.com,...
```

Remote `/healthz` is authenticated as well.

Important runtime environment options include:

```text
LPC_WORKSPACE
LPC_HOST
LPC_PORT
LPC_MCP_TOKEN
LPC_ALLOWED_HOSTS
LPC_ALLOWED_ORIGINS
LPC_REQUEST_STATE_KEY
LPC_VERIFY_SANDBOX
LPC_ENABLE_NETWORK_TOOLS
LPC_WINDOWS_SANDBOX_HELPER
LPC_DISABLE_AUDIT
```

Set a stable `LPC_REQUEST_STATE_KEY` in production so signed MCP approval continuation state survives server restarts.

## Development and release commands

Run from the project root:

```text
npm test
npm run lint
npm run build
npm run doctor
```

Windows additionally builds the native helper with:

```text
npm run build:native
```

### Final acceptance gate

The release gate is:

```text
npm run acceptance
```

A fast development variant is:

```text
npm run acceptance:quick
```

The full acceptance harness is designed to verify the **built** runtime and includes:

- native helper build where applicable
- unit/integration tests
- lint
- build
- doctor
- real native sandbox discovery/verification
- built MCP server startup
- modern MCP client connection using protocol revision `2026-07-28`
- exact 23-tool discovery
- bounded inspection primitives and concise-vs-structured MCP result shaping
- automatic bounded project-instruction context
- `get_capabilities` v0.9 contract
- Goal persistence across real server restart
- Goal completion verification
- audit hash-chain validation

A target OS is not finally accepted until this command exits `0` on that real OS.

## Final acceptance matrix

A release should record these results independently:

```text
Windows native  : npm run acceptance -> 0
macOS native    : npm run acceptance -> 0
Linux           : npm run acceptance -> 0   (if Linux is a supported deployment target)
```

Static unit tests on one OS must never be presented as proof that another OS's native isolation has passed.

## Deployment boundary

Editing this repository does not upgrade an already-running ChatGPT Connector. After a successful release build, redeploy/restart the MCP service and refresh/rescan the app tools so the v0.9 schemas become visible.

If the currently connected legacy WebGPT Bridge service still has no `cwd` parameter on `run_project_task`, it cannot run this subproject's quality gates from a Desktop-level workspace. That legacy deployment must be replaced before its results can be treated as v0.9 acceptance evidence.
