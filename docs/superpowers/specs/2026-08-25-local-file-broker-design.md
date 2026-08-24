# Local File Broker Design

## Goal

Add an opt-in App-owned local file broker that lets the web-connected Agent browse and read non-sensitive local files, while requiring native App confirmation before any batch of up to 20 writes, moves, or deletions.

## Security boundary

- The existing project Agent remains sandboxed to its configured workspace.
- Electron main owns all broker filesystem access and is the only process that evaluates global-path policy or performs global mutations.
- The Agent receives no broad filesystem grant, OS credential, GitHub token, or shell privilege.
- Sensitive locations are denied by default, including SSH material, credential/keychain files, browser profiles, cloud credential directories, `.env` files, package-manager auth files, and App secret stores.
- A request for a sensitive path opens a native App confirmation dialog. Approval is bound to that single request and expires immediately after it returns.

## MCP tools

- `local_list(path, depth, includeHidden)`: enumerate an allowed directory without following symlinks.
- `local_read(path, startLine, maxLines)`: read one allowed UTF-8 file with a SHA-256 precondition value.
- `local_request_sensitive_access(path, operation)`: request one-time native approval for a sensitive list/read request.
- `local_stage_changes(changes)`: validate a batch of 1–20 structured add/update/move/delete operations, each with path and required source SHA where applicable; return an opaque batch id and summaries only.
- `local_confirm_batch(batchId)`: open native App confirmation; if accepted, revalidate every SHA and atomically apply the entire batch or none of it.

## Native confirmation and audit

- The confirmation panel lists full paths, operation types, current SHA values, and bounded text/binary change summaries for every item.
- Confirmation is non-persistent and scoped only to the presented batch. Any mismatch, added item, changed SHA, timeout, cancel, or App restart invalidates the batch.
- Audit records timestamp, action, paths, result, and hashes. It never stores file bodies, secret values, token material, or credentials.

## Approval modes and terminal broker

- `cautious`: non-sensitive reads and classified project checks run automatically; non-sensitive writes, all destructive operations, dependency installation, Git mutation, network commands, and external publication require approval.
- `development`: non-sensitive reads plus classified Git read/test/lint/build commands run automatically; writes, destructive operations, dependency installation, Git mutation, network commands, and external publication require approval.
- `auto`: applies automatic approval to all non-sensitive local reads, searches, and non-destructive classified development commands across the computer, plus non-sensitive file updates. It never auto-approves moves, overwrites, deletions, dependency installation, Git mutation, network commands, external publication, system directories, or sensitive paths.
- Destructive file actions are always presented as an atomic confirmation batch of at most 20 items. Any source SHA mismatch invalidates the whole batch.
- A distinct terminal broker reuses the existing Agent command classifier and accepts argv only. It never accepts a shell string, `sudo`, privilege escalation, or an unrestricted executable path. Network operations remain separately approval-gated in every mode.
- The approval mode is stored as local non-secret App configuration, displayed continuously in the controller, and can be changed back to `cautious` at any time.

## Non-goals

- No arbitrary shell, sudo, executable launch, network access, recursive destructive command, permanent sensitive-path allowlist, or direct secret export.
- No modification to existing project-scoped file tools; the broker is a distinct opt-in capability.
