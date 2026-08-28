# WebGPT Bridge Development Handoff

Date: 2026-08-28

## 1. Canonical development branch

Continue all new development from `main`.

The code baseline reviewed for this handoff is the v0.4.5 merge commit:

- code baseline commit: `75c08aac2f9f85eb83c66ce97e7f767f0a6bb64f`
- code baseline tree: `0cefd1fdae8a6e69fe03b6d20f4aac0e9b85e3bb`
- desktop package version: `0.4.5`
- Agent runtime package version: `0.9.1`

This `HANDOFF.md` commit is documentation-only and is newer than the code baseline above.

Important: the GitHub `main` tree is the complete v0.4.5 repository. Do **not** replace it with the older partial local repair snapshot.

## 2. Local repair work that is NOT yet on GitHub main

A separate local workspace was used for repair work:

`~/Desktop/webgpt-bridge-v045-fix`

That workspace intentionally had no commits and contained untracked/partial files. The work below was implemented and tested there but was **not committed or pushed to GitHub**. It therefore still needs to be ported carefully onto the complete `main` tree.

### 2.1 Desktop host wiring

Local `src/main.cjs` was changed to wire the already-implemented local security helpers into the host:

- import and create `createKnownFolderAccess` and `createLoopbackHealthProbe`
- add broker dispatch for:
  - `local_list_known_folder`
  - `local_read_known_folder`
  - `local_probe_health`
- import `resolveSystemProxyEnvironment`
- explicit `settings.httpsProxy` has highest priority
- otherwise resolve macOS system proxy through the existing system-proxy helper
- pass proxy environment only to network terminal commands, never to the file broker
- default settings:
  - `sshEnabled: false`
  - `sshAllowedHosts: []`
- pass normalized SSH settings into the local terminal broker
- trust `/usr/bin/ssh` only when SSH is enabled on macOS/Linux
- clear known-folder and health-probe host state when the local broker stops

### 2.2 SSH settings UI

Local renderer changes were made in:

- `src/renderer/index.html`
- `src/renderer/renderer.js`

Required behavior:

- checkbox: `sshEnabled`
- textarea/list: `sshAllowedHosts`
- load/save `sshEnabled` as a boolean
- normalize allowlist from newline/comma-separated input with trim + empty removal
- load allowlist one host per line
- show safety copy explaining:
  - SSH is off by default
  - only private/local targets or an explicit allowlist are allowed
  - a noninteractive remote command is required
  - `scp` / `sftp` are not supported
  - forwarding is not supported

The baseline renderer CSS was restored exactly in the local repair workspace; no special textarea styling is required for correctness.

## 3. Required security behavior for the next implementation

These requirements must be preserved when porting the repair onto `main`.

### 3.1 Known-folder access

Allowed folder names are fixed:

- `desktop`
- `downloads`
- `documents`

Requests use a `relativePath` and remain subject to the existing local file broker's path and approval policy. Do not introduce an arbitrary absolute-path bypass.

### 3.2 Health probes

Health probes are fixed to known targets only:

- `agent` -> `127.0.0.1:8765/health`
- `tunnel` -> `127.0.0.1:8766/health`
- `github` -> `github.com:443`

Do not accept an arbitrary user/model-provided health URL.

### 3.3 Proxy handling

Required order:

1. explicit `settings.httpsProxy`
2. otherwise macOS system proxy via `/usr/sbin/scutil --proxy`

Security constraints:

- reject credential-bearing proxy URLs
- inject proxy variables only into network commands
- approval metadata must not expose injected proxy environment values
- for an explicit proxy, set `NO_PROXY` for loopback (`127.0.0.1,localhost,::1`)
- do not modify the machine's system proxy settings

### 3.4 SSH policy

SSH must remain default-off.

When enabled:

- target must be private/local or match an explicit host allowlist
- a noninteractive remote command is mandatory
- forbid shell-only interactive SSH usage
- forbid `scp` and `sftp`
- forbid port forwards, jump hosts, identity/config overrides, TTY/background modes, agent/X11 forwarding, `ProxyCommand`, `LocalCommand`, and likely secret-bearing arguments
- `full_control` may skip ordinary confirmation but must **not** skip SSH host/argv validation
- pin the executable to `/usr/bin/ssh` on macOS/Linux

Required forced options include:

- `BatchMode=yes`
- `PasswordAuthentication=no`
- `KbdInteractiveAuthentication=no`
- `StrictHostKeyChecking=yes`
- `ClearAllForwardings=yes`
- `ForwardAgent=no`
- `ForwardX11=no`

## 4. TDD / regression tests to port or recreate on main

The local repair followed RED -> GREEN for behavior changes.

Canonical test filenames expected after porting:

### Desktop

- `test/host-wiring-red.test.cjs`
- `test/ssh-host-config.test.cjs`
- `test/ssh-path.test.cjs`
- `test/ssh-policy.test.cjs`
- `test/ssh-settings-wiring.test.cjs`
- `test/ssh-terminal-broker.test.cjs`

Existing local repair coverage also included:

- known-folder behavior/schema
- fixed health probe schema/behavior
- proxy environment isolation
- system proxy parsing
- approval metadata not leaking proxy environment
- default-closed SSH
- host allowlist/private-local target policy
- noninteractive-command enforcement
- forbidden SSH flags and secret arguments
- pinned SSH path and forced options

### Agent runtime

- `agent-runtime/test/ssh-command-policy.test.js`
- `agent-runtime/test/ssh-local-schema.test.js`

Required Agent behavior:

- `ssh` is classified as network / approval-required as appropriate
- valid SSH local schema is accepted
- `scp`, `sftp`, `sudo`, `sh`, `bash`, and `zsh` are rejected by the local schema used for this feature

## 5. Verification evidence from the partial local repair workspace

The following results were obtained in the local partial repair workspace before this handoff. They are useful regression evidence, but they are **not proof that the current complete GitHub main tree passes with the repair ported**.

Verified locally at that checkpoint:

- host-wiring test: RED 4/4 failures before implementation, then GREEN 4/4
- SSH settings UI test: RED 3/3 failures before implementation, then GREEN 3/3
- canonical SSH test set: 16/16 passed
- current local Desktop verifier: 37/37 passed
- current **partial** Agent test entrypoint: 4/4 passed
- syntax checks passed for:
  - `src/main.cjs`
  - `src/renderer/renderer.js`
  - `src/preload.cjs`

Warnings:

- the local workspace was partial
- no full Electron startup acceptance was completed there
- no full v0.4.5 Desktop baseline suite claim was made there
- no complete Agent 0.9.1 suite claim was made there
- no full package/build/release acceptance claim was made there

After porting to GitHub `main`, run the complete repository verification from the full tree before considering the repair complete.

## 6. Recommended implementation order on main

1. Start from a fresh checkout of `main`; do not use the partial local snapshot as the repository base.
2. Recreate/port the regression tests first and confirm RED where behavior is missing.
3. Port host wiring into `src/main.cjs` without replacing the v0.4.5 lifecycle/preflight/runtime-supervisor code.
4. Port the SSH renderer settings UI.
5. Confirm known-folder, health-probe, proxy, approval-metadata, and SSH security tests are GREEN.
6. Run the complete Desktop test entrypoint from the full tree.
7. Run the complete Agent runtime test entrypoint from the full tree.
8. Run syntax/static checks.
9. Run Electron/dev startup acceptance where possible.
10. Run build/package acceptance only after the full test suites are green.

For every new behavior change, keep RED -> GREEN TDD evidence.

## 7. Tunnel / control-plane blocker remains separate

Current status remains:

`BLOCKED — tunnel-client transport source unavailable`

Do not conflate this with the Desktop local-access/proxy/SSH repair.

Do **not** add workaround behavior such as repeated restart, forced profile regeneration, or `init --force` merely to mask the missing tunnel transport/control-plane source.

The earlier external proxy -> GitHub TLS EOF path also remains a separate environment/transport issue until a dedicated real probe verifies it.

## 8. Repository branch-cleanup audit

At the time of the audit, GitHub had `main` plus 15 historical branches.

Branches confirmed to be pure ancestors of the reviewed main code baseline (`behind_by: 0`) include:

- `automation/v043-release-prep`
- `automation/v043-tag-release`
- `automation/v043-tray-fix-apply`
- `fix/v040-node20-selection`
- `fix/v042-windows-node-runtime`
- `fix/v043-windows-tray-icon-clean`
- `release/v0.4.1`
- `release/v0.4.2`
- `release/v0.4.3-staging`
- `release-v0.4.0`
- `v0.4.5-runtime-governance`

Four historical branches have divergent commit SHAs, but their purpose is historical/superseded rather than a newer release line:

- `fix/v042-windows-node-discovery` — 7 unique historical commits; its final `src/host-path.cjs` blob is exactly the same as main (`cb66b16f41a1ebf2309f71781c8c09d8569dbbb8`)
- `fix/v043-windows-tray-icon` — 3 unique historical commits; its final `src/tray-icon.cjs` blob is exactly the same as main (`77c9980a5e289fd2dbbb411fcdbdc59afaa70c67`)
- `fix/v044-dependency-lifecycle` — 8 unique historical commits; core `agent-runtime/src/process-manager.js` is exactly the same blob as main (`d8e8472cab2452b27c2193817fc8b4980b5bdb2c`), while main contains later v0.4.5 follow-up changes/tests
- `release/v0.4.4` — 7 unique historical release-line commits; its package version is `0.4.4`, while main is `0.4.5`, so it is an older release line rather than the development head

The temporary Windows CI draft PR #3 (`ci: temporary Windows test build`) was closed during repository cleanup and was not merged.

Target repository policy after cleanup: keep `main` as the only development branch. Historical releases remain recoverable from Git commit history/tags where applicable; do not merge obsolete branch tips into main merely to make their SHA ancestry linear.

## 9. Safety / workspace constraints

- Do not overwrite `/Applications/WebGPT Bridge.app` during development.
- Do not reset/restore away local user work.
- Do not force-push main to rewrite valid history.
- Do not commit secrets, runtime keys, proxy credentials, or private SSH material.
- Keep tunnel/control-plane debugging separate from the local Desktop capability repair.

## 10. Definition of done for the next repair phase

Use these reporting categories:

- **VERIFIED** — supported by a fresh command/test result on the current complete tree
- **WARNING** — incomplete verification or a known limitation
- **BLOCKED** — cannot proceed because a required external dependency/source is unavailable

Do not claim full application success from partial test suites.
