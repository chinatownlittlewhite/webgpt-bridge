# Windows Runtime Remediation Design

## Goal

Make the Windows distribution self-bootstrapping and release-gated: the native AppContainer launcher must run without a preinstalled .NET 8 runtime; dedicated network tooling must expose actionable state instead of collapsing to `null`; GitHub CLI discovery must be stable across common Windows install locations and process restarts; and Windows release packaging must fail closed unless native acceptance passes on Windows.

## Scope

This design implements the approved Windows remediation requirements for the desktop client, `agent-runtime`, the native Windows sandbox, structured network tools, GitHub tooling, and the release pipeline.

## Architecture

### Self-contained Windows launcher

Publish `native/windows-sandbox/LocalProjectCoding.WindowsSandbox.csproj` for `win-x64` as a self-contained Release build. Do not enable single-file publishing, trimming, or NativeAOT. The launcher remains a normal .NET application with its runtime co-located in the publish directory, avoiding a target-machine dependency on `Microsoft.NETCore.App 8.x` while keeping current P/Invoke and AppContainer behavior unchanged.

Windows runtime diagnostics must stop treating an installed `dotnet` command as a runtime prerequisite. Build-time SDK availability remains a build-host concern; packaged-runtime health is verified by the launcher artifact and real sandbox smoke tests.

### Dedicated network sandbox diagnostics

Keep the existing design in which the same native sandbox backend is prepared twice: once with no network capability and once with explicit network capability. Introduce a structured diagnostic state for sandbox preparation so `get_capabilities`, `dependency_sync`, and `github` can distinguish disabled network tooling, helper absence, helper startup/verification failure, and a ready verified sandbox.

The normal sandbox must never inherit network capability. Failure to prepare the dedicated network sandbox must fail closed and must never fall back to unrestricted host networking.

### GitHub CLI discovery

Add a trusted GitHub CLI resolver outside model control. Resolution order on Windows is:

1. explicit trusted path supplied by the desktop host,
2. application-managed `tools/bin/gh.exe`,
3. `%ProgramFiles%\\GitHub CLI\\gh.exe`,
4. `%LOCALAPPDATA%\\Programs\\GitHub CLI\\gh.exe`,
5. `%LOCALAPPDATA%\\Microsoft\\WinGet\\Links\\gh.exe`,
6. trusted process PATH resolution.

The resolver returns a structured status (`ready`, `missing`, or `broken`), resolved path, version when available, and remediation text. The desktop host resolves this on each agent start and passes only the trusted resolved path to the runtime. Model-facing tool inputs never gain an executable-path field.

GitHub tool execution uses the trusted resolved executable. If missing or broken, it returns an actionable structured error rather than raw `ENOENT` or a generic bridge exception.

### Release gating

Windows acceptance must verify that the native helper build is self-contained, the native sandbox is discovered and promoted only after verification, local command/process smoke tests work in the verified AppContainer, the dedicated network sandbox reaches a usable verified state, and GitHub capability diagnostics behave correctly both with and without a CLI.

`dist:win` must continue to run Windows acceptance before `electron-builder`; CI must also expose the acceptance step explicitly so a failed Windows acceptance prevents packaging and artifact upload.

## Error states

Sandbox preparation exposes a diagnostic object with a stable status and remediation fields. `dependency_sync` and `github` return this diagnostic when network capability is unavailable. GitHub CLI absence is a separate `github_cli_missing` state and does not disable unrelated local tools.

## Compatibility constraints

- Preserve agent-runtime version `0.9.0` and the existing public 23-tool surface.
- Do not add model-controlled shell execution or executable-path injection.
- Do not weaken AppContainer ACL, Job Object, approval, or workspace confinement behavior.
- Do not add network capability to the normal sandbox.
- Keep macOS/Linux behavior backward compatible.
- Do not require .NET 8 runtime on the Windows target machine after installation.

## Verification

Tests cover build arguments, Windows doctor semantics, sandbox diagnostic states, GitHub CLI resolution and capability reporting, structured network-tool failure output, desktop host path propagation, package content, and Windows workflow/release command ordering. Full `npm test`, lint, build, contract checks, and native acceptance remain the final verification layers.