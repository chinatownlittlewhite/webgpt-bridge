# Windows Runtime Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Windows packaging self-contained, restore actionable dedicated-network capability diagnostics, add trusted GitHub CLI discovery, and make Windows native acceptance a hard release gate.

**Architecture:** Keep the existing AppContainer architecture and 23-tool MCP contract, but make the Windows helper self-contained and carry richer runtime diagnostics alongside the adapters. Add a trusted GitHub CLI resolver whose output is injected by the desktop host, never by model input. Extend acceptance/CI so these properties are verified before Windows packaging.

**Tech Stack:** Node.js ESM/CommonJS, Electron, .NET 8 Windows AppContainer helper, node:test, GitHub Actions, electron-builder.

**Spec:** `docs/superpowers/specs/2026-08-25-windows-runtime-remediation-design.md`

## Global Constraints

- Preserve agent-runtime version `0.9.0` and the existing public 23-tool surface.
- Do not add model-controlled shell execution or executable-path injection.
- Normal sandbox remains network-denied; only the dedicated network sandbox may receive network capability.
- Windows target machines must not require preinstalled .NET 8 Runtime for `lpc-windows-sandbox.exe`.
- Do not enable single-file publishing, trimming, or NativeAOT.
- Windows packaging must not run if Windows native acceptance fails.

---

### Task 1: Self-contained Windows native launcher

**Files:**
- Modify: `agent-runtime/scripts/build-native.mjs`
- Modify: `agent-runtime/scripts/doctor.mjs`
- Test: `agent-runtime/test/windows-native-build.test.js`
- Test: `agent-runtime/test/doctor.test.js`

**Interfaces:**
- Produces: `dotnet publish ... -r win-x64 --self-contained true` output at `native/windows-sandbox/bin/release`.
- Produces: Windows doctor diagnostics that require the helper artifact, not an installed target-machine .NET runtime.

- [ ] Add tests asserting the Windows native build script uses `win-x64` self-contained publish and explicitly avoids single-file/trimming/AOT flags.
- [ ] Run the focused test and confirm it fails against `--self-contained false`.
- [ ] Update `build-native.mjs` minimally to publish `-r win-x64 --self-contained true`.
- [ ] Add/adjust doctor tests so Windows runtime health no longer requires `dotnet` as a target runtime prerequisite.
- [ ] Run focused tests and full agent-runtime tests.

### Task 2: Structured sandbox preparation diagnostics

**Files:**
- Modify: `agent-runtime/src/native-sandbox.js`
- Modify: `agent-runtime/src/server.js`
- Modify: `agent-runtime/src/tool.js`
- Test: `agent-runtime/test/native-sandbox.test.js`
- Test: `agent-runtime/test/tool.test.js`

**Interfaces:**
- Produces: `sandboxDiagnostic(prepared, { enabled, expectedPath })`-style structured state with `status`, `reason`, `recoverable`, and verification/discovery metadata.
- Consumes: `networkSandboxState` in capability and structured network-tool creation.

- [ ] Add failing tests for `ready`, `disabled`, `helper_missing`, and `verification_failed` states.
- [ ] Implement a pure diagnostic mapper in `native-sandbox.js`.
- [ ] Thread the prepared network sandbox diagnostic through `createCoreTools` and `get_capabilities` without changing the public tool list.
- [ ] Make `dependency_sync` and `github` return actionable `network_unavailable` diagnostics rather than one generic string.
- [ ] Run focused and full tests.

### Task 3: Trusted GitHub CLI resolver and capability reporting

**Files:**
- Create: `agent-runtime/src/github-cli.js`
- Modify: `agent-runtime/src/github.js`
- Modify: `agent-runtime/src/tool.js`
- Modify: `agent-runtime/src/server.js`
- Modify: `agent-runtime/src/index.js`
- Create: `agent-runtime/test/github-cli.test.js`
- Modify: `agent-runtime/test/tool.test.js`

**Interfaces:**
- Produces: `resolveGitHubCli({ platform, env, explicitPath, exists, runVersion }) -> { status, resolvedPath, version, reason, remediation }`.
- Produces: `githubCli` capability state.
- Consumes: trusted `githubCliPath` from the desktop host/runtime options.

- [ ] Write failing resolver tests for explicit path, Windows common install locations, WinGet Links, PATH fallback, missing, and broken/version-failure states.
- [ ] Implement the resolver as a pure/testable module with injected filesystem/version probes.
- [ ] Update GitHub runner to execute the trusted resolved executable while preserving bounded argv and no shell.
- [ ] Return `github_cli_missing`/`github_cli_broken` structured results before attempting remote operations.
- [ ] Expose GitHub CLI status in capabilities and run focused/full tests.

### Task 4: Desktop host re-resolves gh on every agent start

**Files:**
- Create: `src/github-cli-path.cjs`
- Modify: `src/main.cjs`
- Test: `test/github-cli-path.test.cjs`
- Modify: `test/package-content.test.cjs`

**Interfaces:**
- Produces: `resolveDesktopGitHubCli({ env, appToolsBin, exists })` returning a trusted executable path or empty string.
- Produces env: `LPC_GITHUB_CLI_PATH` passed to the agent for each `startAll()` invocation.

- [ ] Write failing desktop resolver tests for app-managed tools, Program Files, LocalAppData, WinGet Links, and refreshed PATH.
- [ ] Implement resolver without caching so every `startAll()` re-evaluates the environment/filesystem.
- [ ] Inject `LPC_GITHUB_CLI_PATH` into agent startup env only when resolved.
- [ ] Verify package content includes the resolver and desktop tests pass.

### Task 5: Windows acceptance and release gate

**Files:**
- Modify: `agent-runtime/scripts/acceptance.mjs`
- Modify: `agent-runtime/test/acceptance.test.js`
- Modify: `.github/workflows/build-desktop.yml`
- Modify: `package.json` only if needed to keep acceptance before packaging.
- Test: `test/package-content.test.cjs`

**Interfaces:**
- Windows acceptance requires both `normalSandbox.summary.autoRunSafe === true` and a verified/usable dedicated network sandbox.
- CI runs Windows acceptance explicitly before `npm run dist:win`; failure prevents package generation/upload.

- [ ] Add failing tests that acceptance source requires dedicated-network verification on Windows and that CI places acceptance before packaging.
- [ ] Update acceptance to start production runtime with network tools enabled and assert network sandbox discovery/verification/usable state on Windows.
- [ ] Add GitHub CLI capability diagnostic assertions that do not require authenticated GitHub access.
- [ ] Add explicit `npm --prefix agent-runtime run acceptance` Windows CI step before `npm run dist:win`.
- [ ] Run desktop tests, agent-runtime tests, lint, contract, build, and macOS quick/native-appropriate acceptance.

### Task 6: Final verification and branch review

**Files:**
- Review all modified files via `git diff`.

**Interfaces:**
- Produces a clean, reviewable branch with no unrelated changes.

- [ ] Run `npm test` at repository root.
- [ ] Run `npm --prefix agent-runtime test`.
- [ ] Run `npm --prefix agent-runtime run lint`.
- [ ] Run `npm --prefix agent-runtime run contract`.
- [ ] Run `npm --prefix agent-runtime run build`.
- [ ] Run `npm --prefix agent-runtime run acceptance:quick` on macOS; document that real Windows native acceptance remains CI/Windows-host verification.
- [ ] Inspect `git status --short` and `git diff --check`.
