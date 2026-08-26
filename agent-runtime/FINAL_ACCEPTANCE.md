# WebGPT Bridge Agent v0.9.1 — Final Acceptance

## Status

**Release stage:** Final Acceptance Candidate

Do not relabel this release as “Final Accepted” until the full acceptance command exits `0` independently on the required real target operating systems.

## Frozen release contract

- Version: `0.9.1`
- MCP protocol target: `2026-07-28`
- Model-facing MCP tools: exactly 23
- Default raw command network policy: denied by the normal native sandbox
- Unattended execution: only after exact native sandbox verification/promotion
- Approval: trusted-host, exact-request-bound; never model-controlled
- Goal Mode: explicit persistent handle, bounded budgets, acceptance criteria and verification gate
- Host-only orchestration: external Goal orchestrator + isolated worktree multi-agent coordinator

## Exact MCP tool list

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

## Required release command

From the project root:

```text
npm install
npm run acceptance
```

`npm run acceptance:quick` is useful during development but is **not** final native-platform acceptance evidence.

## What the full acceptance gate verifies

The full acceptance harness must exit non-zero if any required item fails:

1. Windows native helper builds when running on Windows.
2. Unit/integration tests pass.
3. Lint passes.
4. `src/*.js` builds into `dist/*.js`.
5. The `src` and `dist` JavaScript module sets are identical.
6. Every built module is byte-identical to its source module after build.
7. Doctor checks pass.
8. The native sandbox backend is available on the current target OS.
9. The native isolation probe passes and the exact adapter is promoted to `autoRunSafe=true`.
10. Node, npm and Git execute successfully inside the verified native sandbox.
11. A managed long-running process can start and be terminated through the process manager.
12. A real temporary Git repository can create/remove a managed worktree through the verified native sandbox.
13. The built `dist/server.js` starts a real HTTP MCP server.
14. The official MCP v2 client negotiates protocol revision `2026-07-28`.
15. Tool discovery returns exactly the frozen 23 tools.
16. `read_file`, `list_dir`, and `search_text` work through the built MCP server with bounded results.
17. Agent-facing MCP `content` is concise rather than a JSON mirror of `structuredContent`, and pageable inspection/process results expose continuation metadata.
18. `get_capabilities` returns version `0.9.1` and release stage `final-acceptance-candidate`.
19. The health endpoint reports the correct version/tool count.
20. A persistent Goal session survives a full MCP server restart and receives bounded project instruction context when applicable.
21. `goal_finish` executes real project verification and returns `completed` with `verified=true`.
22. The audit log tail has a valid contiguous SHA-256 hash chain.

## Native acceptance matrix

Record evidence from the real machines here after running the full gate.

| Target | Command | Required result | Status | Evidence |
|---|---|---:|---|---|
| Windows native | `npm run acceptance` | exit `0` | PENDING | Windows AppContainer helper must compile and pass real native compatibility/isolation probes |
| macOS native | `npm run acceptance` | exit `0` | PENDING | Seatbelt filesystem/network probe plus Node/npm/Git/process/worktree compatibility must pass |
| Linux, if shipped | `npm run acceptance` | exit `0` | PENDING | Bubblewrap native probe and developer-workflow compatibility must pass |

## Windows-specific acceptance

The Windows backend is an AppContainer compatibility backend with:

- trusted shell-free argv resolution
- AppContainer security capabilities
- workspace/runtime ACL grants
- host-only bounded metadata grants
- Job Object kill-on-close
- MCP parent PID monitoring
- network capability omitted for the normal sandbox

This implementation must **not** be described as equivalent to the OpenAI Codex Windows sandbox merely because both are native. Windows support is accepted only after the real Windows gate proves that the required Node/npm/Git/process/worktree workflows operate correctly inside this backend.

Run:

```text
npm install
npm run build:native
npm run acceptance
```

The expected native helper location is:

```text
native/windows-host/bin/release/lpc-windows-host.exe
```

## macOS-specific acceptance

The macOS backend uses a deny-default Seatbelt profile plus a trusted parent guard. The system `sandbox-exec` launcher is deprecated, so acceptance is deliberately tied to a real probe on the macOS release being shipped rather than to the mere existence of `/usr/bin/sandbox-exec`.

Run:

```text
npm install
npm run acceptance
```

Do not mark macOS accepted if the isolation probe or native Node/npm/Git/process/worktree compatibility stage fails.

## MCP/ChatGPT deployment acceptance

After local platform acceptance passes:

1. Build/redeploy the v0.9 MCP server.
2. Configure a stable `LPC_REQUEST_STATE_KEY`.
3. For non-loopback deployment, configure a strong `LPC_MCP_TOKEN` and explicit `LPC_ALLOWED_HOSTS`; optionally configure hostname-only `LPC_ALLOWED_ORIGINS`.
4. Expose the endpoint using the approved deployment/tunnel method.
5. Refresh/rescan the ChatGPT custom app tools.
6. Confirm ChatGPT sees all 23 v0.9 tools, including `read_file`, `list_dir`, and `search_text`, and `run_project_task` includes `cwd`.
7. Run a Goal Mode task from one user message and verify that normal `continue_required` responses remain in the same assistant turn without asking the user to type “continue”.
8. Verify a real approval-required action pauses for the platform/user approval instead of bypassing it.

## Final release decision

Only after the required operating-system rows above are `PASS` may the release stage be changed from:

```text
final-acceptance-candidate
```

to a final accepted/release status in code and documentation.

Until then, the accurate description is:

> v0.9.1 implementation and release harness complete; native final acceptance pending real target-OS execution.
