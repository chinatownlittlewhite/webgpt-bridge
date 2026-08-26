# Windows AppContainer host preparation design

Date: 2026-08-25
Status: approved design
Branch: `windows-runtime-remediation`
PR: #4

## Context

The Windows remediation baseline already requires the sandbox launcher to be self-contained, prohibits persistent ACL mutation of shared executables, verifies a dedicated network sandbox, resolves GitHub CLI from trusted locations, and blocks Windows packaging when native acceptance fails.

Real Windows CI then exposed a second compatibility boundary after the shared-executable ACL defect was removed. The AppContainer successfully launched `cmd.exe`, and it successfully started Git for Windows from `C:\Program Files\Git\bin\git.exe`, but `git --version` exited 128 because the MinGW runtime could not open `/dev/null` (`NUL` / the Windows null device) inside the AppContainer. This is distinct from the previous `SetNamedSecurityInfoW` failure: the executable itself is now launchable, but one kernel object needed by the executable is not accessible to the AppContainer token.

The user-approved direction is to preserve the AppContainer execution model and grant only the minimum object-level access required for this compatibility case. The design must not weaken the existing rule that Bridge never persistently rewrites ACLs on `System32`, `Program Files`, Git, .NET, Node, GitHub CLI, or other shared executables.

## Goals

1. Allow WebGPT Bridge AppContainer processes to open the Windows null device with the minimum read/write access needed by Git for Windows.
2. Scope that access to a product-specific AppContainer capability rather than to all AppContainers or all users.
3. Keep normal sandbox network access denied and preserve the dedicated-network sandbox separation.
4. Make host preparation idempotent, auditable, repairable, and safe across reboot, upgrade, repair, and uninstall.
5. Fail closed when host preparation is missing or invalid; never fall back to unsandboxed execution.
6. Validate the resulting model on a real Windows runner and, for the compatibility smoke, under a standard non-administrator user context.

## Non-goals

- Do not modify Git for Windows, fork MinGW, or patch `/dev/null` behavior inside Git.
- Do not add a general privileged command broker.
- Do not let model-facing tools request elevation, change system ACLs, select arbitrary capability names, or supply executable paths.
- Do not grant the normal AppContainer internet access.
- Do not grant `ALL APPLICATION PACKAGES`, `ALL RESTRICTED APPLICATION PACKAGES`, `Users`, or `Everyone` new null-device access when a product-specific capability can be used.
- Do not keep a privileged resident service when a one-shot boot preparation task is sufficient.

## Capability identity

Use one stable product capability name:

`com.localagenthost.desktop.null-device`

The capability SID is derived with the Windows `DeriveCapabilitySidsFromName` API. The name is intentionally version-independent so upgrades use the same security principal and do not accumulate stale ACEs.

Both Windows AppContainer profiles receive this capability in `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`:

- normal sandbox: product null-device capability only;
- dedicated network sandbox: product null-device capability plus the existing `internetClient` capability.

The capability grants no file-system or network rights by itself. It becomes useful only where an object DACL explicitly grants access to that capability SID.

## Privileged host-preparation component

Add a separate Windows native component under `agent-runtime/native/windows-host-prep/` and publish it self-contained for `win-x64`.

The host-prep executable has a deliberately narrow command surface:

- `--apply`: ensure the required product-capability ACE and integrity label exist on the null device;
- `--remove`: remove only the exact product-capability ACE owned by WebGPT Bridge;
- `--check --json`: report non-mutating preparation status and diagnostics.

`--check --json` must remain usable from a standard-user token. `--apply` and `--remove` explicitly reject non-administrator tokens with a bounded `elevation_required` diagnostic instead of relying on a later access-denied failure. Because the same binary owns the read-only `--check --json` path, it must not embed a process-wide `requireAdministrator` manifest; elevation is enforced only for mutation modes by the fixed runtime token check. The desktop/Agent runtime never invokes mutation modes.

It must not launch arbitrary commands, accept arbitrary object names, accept arbitrary SIDs, edit file ACLs, access the network, or expose a model-facing interface.

### Null-device ACL operation

The elevated component opens the Windows `NUL` device by handle and uses handle-based security APIs (`GetSecurityInfo` / `SetSecurityInfo` with a kernel-object security type) rather than `SetNamedSecurityInfoW` against an executable path. Windows documents `SE_KERNEL_OBJECT` for local kernel objects and supports handle-based security descriptor operations on kernel objects.

`--apply` reads the current DACL, derives the fixed product capability SID, and merges one allow ACE that grants only the read/write access needed to open and use the null device. It does not grant `WRITE_DAC`, `WRITE_OWNER`, delete rights, process rights, file-system traversal rights, or network rights to the capability.

Because AppContainer processes run at Low Integrity Level, DACL authorization alone is insufficient for a writable `NUL` device if the object is unlabeled or has a higher mandatory integrity label. Host preparation therefore also verifies the null device's mandatory label and, when needed, sets exactly the Low Integrity / `NO_WRITE_UP` label `S:(ML;;NW;;;LW)` through `LABEL_SECURITY_INFORMATION`. It does not set `SACL_SECURITY_INFORMATION`, does not replace audit ACEs, and does not require a general security-audit privilege for this label-only update.

The operation preserves all pre-existing DACL ACEs. Repeated `--apply` calls are idempotent and must not duplicate the product ACE or rewrite an already-correct integrity label.

`--remove` removes only an ACE whose SID, access mask, inheritance flags, and object target exactly match the product-owned null-device grant. It must not restore a previously captured whole DACL, because that could overwrite unrelated security changes made after installation. The Low Integrity mandatory label is not treated as a product-owned ACE and is not reverted during uninstall; the Windows null-device security descriptor is reset by the OS at boot, while removing the product capability ACE immediately revokes WebGPT Bridge AppContainer access.

### Diagnostics

The host-prep component records locally protected diagnostics containing:

- operation (`check`, `apply`, or `remove`);
- Windows API that failed;
- target object (`NUL` / null device);
- derived capability SID;
- requested security-information flags and access mask;
- Win32 error code;
- caller elevation/integrity information;
- before/after DACL evidence sufficient for repair analysis;
- mandatory-integrity-label readiness without exposing unrelated SACL/audit contents.

Raw DACL/SACL details remain in local diagnostics and are not returned through model-facing tools. Public capability output exposes only bounded status, error code, integrity-label readiness, and remediation text.

## Installation and boot lifecycle

Windows installation becomes per-machine because the boot preparation executable must live in an administrator-protected location before it can be executed as `SYSTEM`.

The NSIS installer:

1. installs the application and self-contained host-prep payload below the protected Program Files installation directory; the installer disables directory selection and its `customInit` re-pins `$INSTDIR` to the electron-builder Program Files path after multi-user initialization, so a command-line `/D=...` override cannot redirect the eventual SYSTEM task into a user-writable directory;
2. creates a fixed Task Scheduler task named `WebGPT Bridge Host Preparation`;
3. configures the task to run the fixed host-prep executable with fixed `--apply` arguments as `SYSTEM`, highest privileges, at system startup;
4. only after the fixed SYSTEM task has been registered successfully, immediately runs one `--apply` during installation/repair so the first application launch does not depend on a reboot;
5. if task creation fails, aborts before mutating `NUL`; if `--apply` fails after task creation, deletes the newly registered task before aborting;
6. treats failure to provision the task or apply the ACE/label as an installation/repair failure with actionable diagnostics.

The scheduled task is preferred to a resident Windows service because host preparation is a small idempotent boot-time mutation and does not require a privileged process to remain running after the ACL is prepared. The task action path is under Program Files and therefore is not writable by a standard user. The protected path is an installer invariant, not a UI convention: NSIS command-line directory overrides are ignored/reset before installation proceeds.

On upgrade, the installer reuses the same capability name and task name, replaces the trusted payload, recreates/repairs the task if necessary, and runs `--apply` again.

On uninstall, the elevated uninstaller runs `--remove` before deleting the payload and then deletes the scheduled task. Removal failure is logged prominently; it must never trigger a broad DACL reset.

## Windows ZIP distribution

A user-writable extracted ZIP cannot safely be the executable source for a `SYSTEM` startup task. Making a SYSTEM task point at a binary that a standard user can replace would create a privilege-escalation path.

Therefore, while this host-preparation model is required, the formal Windows release target becomes per-machine NSIS only. The current Windows ZIP target is removed from the supported release pipeline rather than silently shipping an artifact that cannot establish the required security boundary.

A future portable distribution would require a separate approved design that elevates once, copies the privileged payload into an administrator-protected location, owns upgrade/uninstall lifecycle, and prevents user replacement of the SYSTEM task target.

## Runtime integration

The Windows sandbox helper derives the same fixed product capability SID and includes it in every AppContainer token. The existing network capability remains conditional on `allowNetwork`.

The current helper implementation supports zero or one capability allocation; implementation must be generalized to a bounded capability array so normal mode carries one capability and dedicated-network mode carries two. Capability names and SIDs are host constants, never tool inputs.

There is no host execution fallback. If host preparation is absent, stale, or ineffective, native verification remains failed and the sandbox does not become `autoRunSafe`.

## Preparation verification and capability reporting

Windows native verification gains an explicit null-device probe before release promotion. The probe runs inside the same AppContainer token used for normal command execution and must demonstrate read/write use of `NUL` without modifying executable ACLs.

`get_capabilities` adds bounded Windows host-preparation state with statuses such as:

- `ready`;
- `not_provisioned`;
- `task_missing`;
- `capability_ace_missing`;
- `integrity_label_missing`;
- `probe_failed`;
- `unsupported`.

Diagnostics include the expected capability name, task name, last observed Win32 error when available, and repair guidance. They do not expose raw security descriptors.

`doctor` reports the same preparation state on Windows. `run_command` and `process_start` do not attempt repair themselves and do not request elevation; they remain fail-closed behind verified native sandbox promotion.

## Release acceptance

Windows acceptance continues to verify self-contained native payloads, unit/integration tests, lint, the 23-tool contract, build, doctor, normal AppContainer verification, dedicated-network verification, and capability reporting.

It additionally verifies:

1. host-prep `--apply` is idempotent;
2. the expected product capability SID is present in the AppContainer token;
3. the null-device probe succeeds in the normal sandbox;
4. normal sandbox external networking remains denied;
5. dedicated-network sandbox still has only its intended network capability in addition to the product null-device capability;
6. `cmd.exe`, Git for Windows, `dotnet.exe`, `node.exe` when supported, and Program Files `gh.exe` when present launch successfully through the verified AppContainer without persistent ACL mutation of those binaries;
7. Git for Windows no longer fails on `/dev/null` / `NUL`;
8. removing host preparation causes the null-device-specific verification to fail closed and prevents `currentNativeSandboxVerified=true`;
9. re-applying preparation repairs the verification state;
10. uninstall cleanup removes only the product-owned null-device ACE.

For the shared-executable compatibility gate, CI provisions host preparation in its elevated setup phase and then executes the AppContainer smoke harness under an ephemeral local account that is a member of `Users` and not `Administrators`. The account is removed in a guaranteed cleanup step. This is the evidence for the remediation checklist's standard non-administrator requirement.

Any Windows native-acceptance failure continues to block Electron packaging and artifact upload.

## Security invariants

- Shared executable ACLs remain immutable from the Bridge sandbox path.
- The privileged component can mutate only the null-device DACL and only for the fixed product capability SID.
- The SYSTEM task action points only to an administrator-protected Program Files payload with fixed arguments.
- Model-facing schemas do not gain elevation, SID, capability, object-name, task, or executable-path controls.
- The normal sandbox does not gain `internetClient`.
- Existing Job Object, workspace confinement, approval binding, process-tree, and trusted executable protections remain unchanged.
- A missing or broken host-preparation component makes native verification fail closed; it never enables an unsandboxed fallback.

## Failure and repair behavior

Installation or repair failure to establish host preparation produces a Windows-specific error that identifies the failed phase and Win32 code. The application may still expose local non-execution tools that do not depend on native sandbox promotion, but `run_command`/`process_start` must not be advertised as verified-safe.

If the task is removed or the null-device DACL is reset by the OS or another administrator, the next boot task or an explicit installer repair re-applies the exact product ACE. The desktop process itself does not elevate to repair it.

## Alternatives rejected

### Patch or bundle a custom Git for Windows

Rejected because it creates a long-lived Git/MinGW fork and security-update burden solely to work around one object-access restriction.

### Route the Git compatibility acceptance through the existing App-owned Git broker

Rejected as an acceptance substitute. The production structured Git broker remains valid for structured repository operations, but the remediation checklist explicitly requires `git.exe` to be launchable in the intended AppContainer model. Broker success would not prove that requirement.

### Grant broad AppContainer principals access to the null device

Rejected because granting `ALL APPLICATION PACKAGES`, all restricted packages, or users would expand the machine-wide attack surface beyond WebGPT Bridge. A fixed product capability provides a narrower security principal.

### Persistent privileged service

Rejected unless the one-shot task proves insufficient. No ongoing privileged RPC or command service is needed for this object-preparation requirement.

## Implementation boundaries

Expected implementation areas are limited to:

- a new self-contained Windows host-prep native project and build checks;
- Windows sandbox capability-array construction;
- Windows native-verification diagnostics/probes;
- desktop/Agent capability reporting;
- NSIS per-machine install/repair/uninstall hooks and startup task provisioning;
- Windows release target changes (NSIS supported artifact; ZIP removed from formal Windows release);
- Windows CI standard-user host-preparation and executable-smoke coverage;
- focused unit/static tests plus full Agent/Desktop regression suites.

No public tool is added and the frozen v0.9 model-facing 23-tool surface remains unchanged.

## References

- Microsoft Learn, `DeriveCapabilitySidsFromName`.
- Microsoft Learn, `Launch an AppContainer` / `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`.
- Microsoft Learn, `SE_OBJECT_TYPE` and `SE_KERNEL_OBJECT`.
- Microsoft Learn, `GetSecurityInfo` and `SetSecurityInfo`.
- Windows remediation checklist dated 2026-08-25, including the installation-after-retest P0 and standard non-administrator release acceptance.
