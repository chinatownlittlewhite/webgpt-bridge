# Windows AppContainer Host Preparation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Windows AppContainer execution compatible with Git for Windows' `NUL` dependency using a product-specific capability and a minimal privileged host-preparation boundary, while preserving the rule that shared executable ACLs are never rewritten.

**Architecture:** Add a self-contained `windows-host-prep` native executable with a fixed `--check/--apply/--remove` surface for one kernel object and one fixed product capability SID. Generalize the existing Windows sandbox helper to attach the product capability to every AppContainer token, retain `internetClient` only in the dedicated network sandbox, then integrate host-prep state into diagnostics, per-machine NSIS lifecycle, and real Windows CI standard-user acceptance.

**Tech Stack:** .NET 8 / C# P/Invoke, Node.js 22+ ESM/CJS, Electron 40, electron-builder 26 / NSIS, GitHub Actions `windows-latest`.

**Spec:** `docs/superpowers/specs/2026-08-25-windows-appcontainer-host-preparation-design.md`

## Global Constraints

- Stable product capability name: `com.localagenthost.desktop.null-device`.
- Shared executable ACLs under `System32`, `Program Files`, Git, .NET, Node, and GitHub CLI remain immutable from the Bridge sandbox path.
- The privileged component may mutate only the Windows null-device DACL and only for the fixed product capability SID.
- Normal sandbox must not gain `internetClient`; dedicated network sandbox keeps its existing network isolation contract.
- No public/model-facing tool is added; the frozen Agent surface remains exactly 23 tools.
- No model-facing elevation, SID, capability-name, object-name, task-name, or executable-path controls.
- Missing or invalid host preparation keeps Windows native verification fail-closed and must not introduce an unsandboxed execution fallback.
- Formal Windows release target becomes per-machine NSIS only while this SYSTEM host-preparation task is required; Windows ZIP is not a supported release artifact.
- Host-prep and sandbox native payloads are self-contained `win-x64`; no target-machine .NET 8 runtime prerequisite.
- Real Windows acceptance must exercise `cmd.exe`, Git for Windows, `dotnet.exe`, `node.exe` when supported, and Program Files `gh.exe` when present under the AppContainer model without persistent ACL mutation of those binaries.

---

### Task 1: Fixed Capability Identity and AppContainer Token Composition

**Files:**
- Modify: `agent-runtime/native/windows-sandbox/Program.cs`
- Modify: `agent-runtime/test/sandbox.test.js`

**Interfaces:**
- Produces native constant `ProductNullDeviceCapabilityName = "com.localagenthost.desktop.null-device"`.
- Produces bounded capability composition: normal sandbox = product capability; network sandbox = product capability + `S-1-15-3-1` internet-client capability.
- Capability names/SIDs remain native constants, never command-line arguments.

- [ ] **Step 1: Write the failing source-contract tests**

Add assertions in `agent-runtime/test/sandbox.test.js` that require:

```js
assert.match(source, /com\.localagenthost\.desktop\.null-device/);
assert.match(source, /DeriveCapabilitySidsFromName/);
assert.match(source, /CapabilityCount\s*=\s*\(uint\)capabilities\.Count/);
assert.match(source, /if \(allowNetwork\)[\s\S]*InternetClientCapabilitySid/);
```

Also assert the old one-capability-only allocation pattern is absent.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test test/sandbox.test.js`

Expected: FAIL because the helper currently supports only the optional internet-client SID and does not derive the product capability SID.

- [ ] **Step 3: Implement the minimal capability array**

In `Program.cs`:

```csharp
private const string ProductNullDeviceCapabilityName = "com.localagenthost.desktop.null-device";
private const string InternetClientCapabilitySid = "S-1-15-3-1";
```

P/Invoke `DeriveCapabilitySidsFromName`, derive the fixed product capability SID once per launch, build a bounded `List<IntPtr>` / contiguous `SID_AND_ATTRIBUTES` array, append internet-client only when `allowNetwork`, set `CapabilityCount` to the array count, and free every allocated SID/array in `finally`.

Do not add capability input to the helper CLI.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --test test/sandbox.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent-runtime/native/windows-sandbox/Program.cs agent-runtime/test/sandbox.test.js
git commit -m "feat: add product AppContainer capability"
```

### Task 2: Minimal Windows Host-Preparation Native Component

**Files:**
- Create: `agent-runtime/native/windows-host-prep/LocalProjectCoding.WindowsHostPrep.csproj`
- Create: `agent-runtime/native/windows-host-prep/Program.cs`
- Modify: `agent-runtime/scripts/build-native.mjs`
- Create: `agent-runtime/test/windows-host-prep.test.js`

**Interfaces:**
- CLI is exactly `--check --json`, `--apply`, or `--remove`.
- Fixed target is Windows `NUL` / null-device kernel object.
- Fixed security principal is the SID derived from `com.localagenthost.desktop.null-device`.
- `--check --json` emits bounded JSON `{ status, capabilityName, capabilitySid, target, errorCode?, remediation? }` and does not mutate.
- `--apply` is idempotent and merges one exact allow ACE.
- `--remove` removes only the exact product-owned ACE and never restores an entire saved DACL.

- [ ] **Step 1: Write failing static/CLI contract tests**

Create `agent-runtime/test/windows-host-prep.test.js` asserting:

```js
assert.match(source, /--check/);
assert.match(source, /--apply/);
assert.match(source, /--remove/);
assert.match(source, /DeriveCapabilitySidsFromName/);
assert.match(source, /GetSecurityInfo/);
assert.match(source, /SetSecurityInfo/);
assert.match(source, /SeKernelObject/);
assert.match(source, /LabelSecurityInformation/);
assert.match(source, /S:\(ML;;NW;;;LW\)/);
assert.doesNotMatch(source, /SetNamedSecurityInfoW/);
assert.doesNotMatch(source, /SaclSecurityInformation/);
assert.doesNotMatch(source, /Process\.Start|CreateProcess/);
```

Assert `build-native.mjs` publishes both native projects with `-r win-x64 --self-contained true` and without single-file/trimming/AOT flags.

- [ ] **Step 2: Run and verify RED**

Run: `node --test test/windows-host-prep.test.js`

Expected: FAIL because the host-prep project does not exist.

- [ ] **Step 3: Implement the native component**

Create a .NET 8 Windows executable with `TreatWarningsAsErrors=true`. Its parser rejects all arguments except the three fixed modes. Implement:

```csharp
CheckResult CheckPreparation();
void ApplyPreparation();
void RemovePreparation();
```

Open `NUL` with a handle, call `GetSecurityInfo(handle, SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION, ...)`, derive the product capability SID, inspect ACEs, and use Windows ACL APIs to merge/remove the exact product ACE. Preserve unrelated DACL ACEs. Requested capability rights must be only the read/write rights empirically needed for opening and using the null device; do not grant `WRITE_DAC`, `WRITE_OWNER`, delete, process, file-tree, or network rights.

Also query `LABEL_SECURITY_INFORMATION`. AppContainer is Low IL, so `--check` is `ready` only when both the product capability ACE and the Low Integrity mandatory label are present. `--apply` sets exactly `S:(ML;;NW;;;LW)` through `LABEL_SECURITY_INFORMATION` when needed, without setting `SACL_SECURITY_INFORMATION` or replacing audit ACEs. The elevated host-prep handle may request `WRITE_OWNER` solely because Windows requires that standard right to set the mandatory label; that right is never granted to the product capability SID. `--remove` continues to delete only the exact product capability ACE.

Keep `--check --json` standard-user readable. Before any mutation, explicitly require an administrator token; return exit code `65` with `status: "elevation_required"` when `--apply` or `--remove` is invoked without elevation. Do not add UAC/self-elevation logic to the helper because the installer and fixed SYSTEM startup task own elevation.

Return structured Win32 diagnostics; never accept arbitrary target/SID/mask input.

- [ ] **Step 4: Extend native build packaging**

In `build-native.mjs`, publish:

```text
native/windows-sandbox -> native/windows-sandbox/bin/release
native/windows-host-prep -> native/windows-host-prep/bin/release
```

using `dotnet publish ... -r win-x64 --self-contained true`.

- [ ] **Step 5: Run focused tests and build checks**

Run:

```bash
node --test test/windows-host-prep.test.js test/windows-remediation.test.js
```

Expected: PASS on non-Windows static contract tests. Windows native compilation is exercised by Windows acceptance/CI.

- [ ] **Step 6: Commit**

```bash
git add agent-runtime/native/windows-host-prep agent-runtime/scripts/build-native.mjs agent-runtime/test/windows-host-prep.test.js
git commit -m "feat: add Windows host preparation helper"
```

### Task 3: Host-Preparation Discovery, Diagnostics, and Native Promotion Gate

**Files:**
- Modify: `agent-runtime/src/native-sandbox.js`
- Modify: `agent-runtime/src/server.js`
- Modify: `agent-runtime/src/tool.js`
- Modify: `agent-runtime/scripts/doctor.mjs`
- Modify: `agent-runtime/test/windows-remediation.test.js`
- Modify: `agent-runtime/test/tool.test.js`
- Modify: `agent-runtime/test/integrations.test.js`

**Interfaces:**
- Add internal host-preparation state object with stable statuses: `ready`, `not_provisioned`, `capability_ace_missing`, `probe_failed`, `helper_missing`, `unsupported`.
- Bounded public capability representation includes status, capability name, expected helper path, error code/remediation when present; no raw DACL.
- Windows native sandbox promotion requires both existing sandbox verification and host-preparation/null-device verification.

- [ ] **Step 1: Write failing tests for structured preparation state**

Add tests requiring capabilities similar to:

```js
assert.deepEqual(caps.windowsHostPreparation, {
  status: "capability_ace_missing",
  capabilityName: "com.localagenthost.desktop.null-device",
  usable: false,
  remediation: assert.match.string,
});
```

Require `doctor` to show the same bounded status, and require `currentNativeSandboxVerified` / `autoRunSafe` to remain false when host preparation is not ready.

- [ ] **Step 2: Run and verify RED**

Run:

```bash
node --test test/windows-remediation.test.js test/tool.test.js test/integrations.test.js
```

Expected: FAIL because no host-preparation state exists.

- [ ] **Step 3: Implement read-only host-prep probing**

Add a resolver that finds the expected `lpc-windows-host-prep.exe`, invokes only `--check --json` with `shell:false` and a bounded timeout, normalizes output to the stable status object, and never calls `--apply` from Agent runtime.

Integrate the result into server startup, capability reporting, doctor, and native promotion logic.

- [ ] **Step 4: Add null-device native verification probe**

Extend Windows sandbox verification so a probe process under the normal AppContainer opens/writes/reads `NUL` through the exact production token. Host prep `ready` plus a passing probe is required for Windows `autoRunSafe=true`.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the same three focused test files. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add agent-runtime/src/native-sandbox.js agent-runtime/src/server.js agent-runtime/src/tool.js agent-runtime/scripts/doctor.mjs agent-runtime/test/windows-remediation.test.js agent-runtime/test/tool.test.js agent-runtime/test/integrations.test.js
git commit -m "feat: gate Windows sandbox on host preparation"
```

### Task 4: Per-Machine NSIS Provisioning and Safe Uninstall Lifecycle

**Files:**
- Modify: `package.json`
- Create: `build/installer.nsh`
- Modify: `test/package-content.test.cjs`
- Modify: `README.md`

**Interfaces:**
- Windows installer target: NSIS x64 only; no supported ZIP artifact.
- Install mode: per-machine / administrator-required.
- Fixed scheduled task: `WebGPT Bridge Host Preparation`.
- Fixed task action: installed Program Files host-prep executable with `--apply`; run as `SYSTEM`, highest privileges, at startup.
- Install/repair immediately executes `--apply`; uninstall executes `--remove` and removes the fixed task.

- [ ] **Step 1: Write failing package-policy tests**

Extend `test/package-content.test.cjs` to require:

```js
assert.doesNotMatch(pkg.scripts["dist:win"], /\bzip\b/);
assert.deepEqual(pkg.build.win.target, ["nsis"]);
assert.equal(pkg.build.nsis.perMachine, true);
assert.match(installerInclude, /WebGPT Bridge Host Preparation/);
assert.match(installerInclude, /--apply/);
assert.match(installerInclude, /--remove/);
assert.match(installerInclude, /SYSTEM/i);
```

Also assert the scheduled task action resolves under `$INSTDIR` / Program Files rather than a user-writable temp or profile path.

- [ ] **Step 2: Run and verify RED**

Run: `node --test test/package-content.test.cjs`

Expected: FAIL because Windows ZIP is still configured and there is no custom NSIS lifecycle.

- [ ] **Step 3: Implement NSIS lifecycle**

Set electron-builder NSIS to per-machine, request installer elevation, include `build/installer.nsh`, remove ZIP from Windows targets/scripts, and add install/uninstall macros that call the fixed host-prep payload and create/delete the fixed startup task.

All command arguments are installer constants; do not use user-provided paths/SIDs/object names. Abort install/repair if `--apply` or task provisioning fails. During uninstall, log `--remove` failure and continue cleanup without resetting the full DACL.

- [ ] **Step 4: Update README release contract**

Document that formal Windows distribution is per-machine NSIS while privileged host-prep is required, and that portable ZIP is intentionally unsupported until a separately reviewed secure lifecycle exists.

- [ ] **Step 5: Run focused desktop tests**

Run:

```bash
node --test test/package-content.test.cjs
npm run verify:desktop
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json build/installer.nsh test/package-content.test.cjs README.md
git commit -m "feat: provision Windows AppContainer host preparation"
```

### Task 5: Windows Acceptance Under a Standard User and Repair Semantics

**Files:**
- Modify: `agent-runtime/scripts/acceptance.mjs`
- Modify: `agent-runtime/test/acceptance-script.test.js`
- Modify: `.github/workflows/build-desktop.yml`
- Modify: `test/package-content.test.cjs`

**Interfaces:**
- Elevated CI setup runs host-prep `--apply` twice and verifies idempotence.
- Compatibility smoke executes under an ephemeral local account in `Users`, not `Administrators`.
- Guaranteed cleanup removes the ephemeral account and reverses CI-only host preparation.
- Release acceptance confirms Git no longer fails on `/dev/null` / `NUL` and all required shared executables launch through the verified AppContainer.

- [ ] **Step 1: Write failing acceptance/workflow tests**

Require acceptance source/workflow to contain explicit host-prep check/apply, standard-user harness, `cmd/git/dotnet/node/gh` smoke, and cleanup. Require packaging/artifact steps to remain after acceptance.

- [ ] **Step 2: Run and verify RED**

Run:

```bash
node --test agent-runtime/test/acceptance-script.test.js test/package-content.test.cjs
```

Expected: FAIL because CI currently runs acceptance as the hosted runner user without host-prep provisioning or an ephemeral standard-user harness.

- [ ] **Step 3: Implement elevated setup and idempotence checks**

In the Windows job, after native build prerequisites are present, run the fixed host-prep executable `--check --json`, `--apply`, `--apply`, then `--check --json`; fail if state is not `ready` or repeated apply changes the owned ACE count/state unexpectedly.

- [ ] **Step 4: Implement standard-user compatibility harness**

Create an ephemeral local standard user with a generated CI-only password, explicitly ensure it is not in `Administrators`, and execute the AppContainer compatibility acceptance under that account. The harness must cover `cmd.exe`, Git for Windows, `dotnet.exe`, `node.exe`, and Program Files `gh.exe` when present. Preserve the existing assertion that shared executable ACLs are not rewritten.

- [ ] **Step 5: Implement guaranteed cleanup**

Use `if: always()` cleanup steps to remove the test account and run host-prep `--remove` for the CI machine. Do not hide acceptance failures.

- [ ] **Step 6: Run focused tests**

Run the two test files from Step 2. Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add agent-runtime/scripts/acceptance.mjs agent-runtime/test/acceptance-script.test.js .github/workflows/build-desktop.yml test/package-content.test.cjs
git commit -m "test: verify Windows host preparation as standard user"
```

### Task 6: Full Regression, Real Windows Gate, and PR Update

**Files:**
- No new implementation files unless a real Windows failure identifies a specific defect.

**Interfaces:**
- Local evidence: Agent test/lint/contract/build/acceptance:quick + Desktop verification.
- Remote evidence: PR #4 Windows x64 workflow must pass native acceptance before `dist:win` and artifact upload.

- [ ] **Step 1: Run full Agent verification**

Run:

```bash
npm test
npm run lint
npm run contract
npm run build
npm run acceptance:quick
```

from `agent-runtime`.

Expected: zero failures; 23-tool contract unchanged.

- [ ] **Step 2: Run full Desktop verification**

Run from repo root:

```bash
npm run verify:desktop
```

Expected: zero failures.

- [ ] **Step 3: Clean generated runtime state and check the diff**

Delete only known runtime artifacts such as `agent-runtime/.local/state/gh/device-id` if generated, verify `git diff --check`, and review staged/untracked files for intended scope.

- [ ] **Step 4: Push the feature branch**

Push `windows-runtime-remediation` to `origin` through the App-owned Git/GitHub broker. Never force-push.

- [ ] **Step 5: Inspect PR #4 Windows CI**

Confirm the new run's Windows x64 job reaches and passes:

```text
host-prep apply/check -> standard-user AppContainer acceptance -> dist:win -> upload artifact
```

If Windows fails, use the failing job log as the new RED test evidence, implement only the minimal root-cause fix, rerun affected local tests, push another commit, and repeat until the Windows gate is green or a new architectural blocker is proven.

- [ ] **Step 6: Final verification before completion claim**

Use `superpowers:verification-before-completion`. Report exact local test counts, remote Windows/macOS job conclusions, PR head SHA, and any remaining limitation. Do not claim Windows remediation complete unless the real Windows AppContainer acceptance passes.

## Plan Self-Review

- Spec coverage: Tasks 1–3 cover fixed capability identity, privileged null-device object ACL preparation, runtime diagnostics, and fail-closed promotion; Task 4 covers protected per-machine installation, startup repair, uninstall, and removal of unsafe ZIP distribution; Task 5 covers idempotence, standard-user acceptance, executable smoke, repair/cleanup, and release gating; Task 6 covers local/remote final verification.
- Placeholder scan: no `TODO`, `TBD`, "implement later", or unspecified public interfaces remain.
- Type/name consistency: capability name is consistently `com.localagenthost.desktop.null-device`; task name is consistently `WebGPT Bridge Host Preparation`; public preparation state is consistently `windowsHostPreparation`; model-facing tool count remains 23.
