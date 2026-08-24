# Self-hosted Development and Public Release Specification

## Goal

WebGPT Bridge ships with a bundled, stable Agent by default while allowing ChatGPT on the web to develop the complete desktop source checkout, rebuild the external Agent, create platform installers, and publish a verified public GitHub Release for one explicitly configured repository.

## Users and modes

- **Bundled mode** is the default. The App uses its packaged `agent-runtime`; the workspace may be any selected project directory.
- **Development mode** uses a selected complete WebGPT Bridge source checkout as its workspace and the checkout's `agent-runtime` as the active runtime. The App must display the active mode and absolute source path.
- In development mode, a successful Agent build does not take effect until the operator selects **Reload Agent**. Reload stops and starts only the Agent process; it must preserve a live Tunnel process whenever possible.
- If the selected development runtime lacks `agent-runtime/dist/server.js`, the App must fail visibly. It must never silently run the bundled Agent.

## Release authority

- The App stores a GitHub fine-grained personal access token in the platform secure store, separately from the OpenAI Tunnel runtime key. It is never written into settings, project files, logs, command arguments, or the Agent process environment.
- The configured publication target is exact: `chinatownlittlewhite/webgpt-bridge`. A release request must fail if the release checkout's `origin` does not resolve to the corresponding GitHub HTTPS remote.
- The token needs `Contents: write` on that repository. `Workflows: write` is required only when the target commit changes `.github/workflows/`.
- The unprivileged Agent requests a release operation through a local host-controlled bridge. The Electron main process owns token retrieval, GitHub REST requests, source push, asset upload, redaction, and policy enforcement. The Agent never receives the token.
- The bridge accepts only structured release requests. There is no arbitrary command, arbitrary repository, delete-release, overwrite-release, or token-read operation.

## Verified public-release pipeline

1. Confirm the selected development checkout is the configured release checkout and has a valid absolute `agent-runtime` runtime.
2. Run the fixed verification sequence: Agent lint, Agent tests, Agent build, and App package validation.
3. Build macOS Apple Silicon installers and Windows x64 installers using the repository's fixed package scripts; create `SHA256SUMS.txt` for the intended assets.
4. Validate that the source version is valid SemVer, the requested tag equals `v<version>`, release artifacts exist, and no forbidden source files are staged.
5. Stage, commit, and push the verified source to the configured remote. The pushed commit SHA is the sole `target_commitish` for the Release.
6. Create one **public**, non-draft GitHub Release with the requested tag and release notes; upload the verified assets and checksum manifest.
7. Return the public Release URL and asset names. Do not report secret values.

## Failure and recovery rules

- All preconditions and verification checks run before any remote write.
- If the tag already has a Release, stop before uploading or changing it.
- If a failure occurs after the source push but before the Release is public, report the exact committed SHA and stop; never delete the commit, tag, Release, or existing assets automatically.
- A Windows artifact created on macOS is reported as packaged but not Windows-native verified. The public release notes must state this until a Windows verification record is supplied.
- Tokens, HTTP authorization headers, Git credential configuration, proxy credentials, and runtime-key-like strings are redacted from every returned result and log entry.

## UI and configuration

- The main controller area shows Agent mode, active runtime path, and a Reload Agent control.
- The release configuration appears in a dedicated **发布设置** section, not mixed with required Tunnel settings. It has the source checkout path, fixed repository display, HTTPS proxy setting reuse, GitHub token status, save/remove token controls, and a local validation action.
- Settings are local to the machine. Secret state is represented only as present/absent.

## Non-goals

- No GitHub organization-wide token, arbitrary repository publishing, deletion, release editing, code-signing, notarization, or automatic Windows-native test is added.
- No GitHub secret is accessible through MCP file tools, shell output, process environment, the tunnel, or renderer JavaScript.
