# Self-hosted Development and Public Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable WebGPT Bridge to run a desktop source checkout as a development Agent and let the web-connected Agent trigger a verified public release of that exact checkout.

**Architecture:** Electron main owns development-mode lifecycle, secure GitHub-token storage, and a local privileged release controller. The Agent gains only a structured release-request client and never receives the token. The controller validates the exact repository and version, builds fixed artifacts, verifies them, pushes source, then creates and uploads a public GitHub Release.

**Tech Stack:** Electron 40, Node.js 20+, `node:test`, native `https`/`fetch`, Git, electron-builder, MCP SDK.

**Spec:** `docs/superpowers/specs/2026-08-24-self-hosted-development-release.md`

## Global Constraints

- Default mode must keep using the packaged `agent-runtime`.
- Development mode must require an absolute checkout containing `agent-runtime/dist/server.js`; no silent bundled fallback is allowed.
- The App must never pass the GitHub token to renderer JavaScript, Agent environment variables, project files, logs, or command arguments.
- Only `chinatownlittlewhite/webgpt-bridge` may be published, and deletion or overwrite operations are out of scope.
- A public Release may be created only after all local verification gates pass.
- macOS artifacts target Apple Silicon; Windows artifacts target x64 and must state when they lack Windows-native verification.

---

### Task 1: Extract and test host configuration primitives

**Files:**
- Create: `src/host-config.cjs`
- Create: `test/host-config.test.cjs`
- Modify: `src/main.cjs`

**Interfaces:**
- Produces `bundledRuntimePath({ isPackaged, resourcesPath, appDir })`, `normalizeSettings(input, defaults)`, and `validateDevelopmentRuntime(settings, fsImpl)`.
- `validateDevelopmentRuntime` returns `{ mode: "bundled" | "development", runtimePath, workspacePath }` or throws a Chinese diagnostic.

- [ ] **Step 1: Write failing mode-validation tests**

```js
test("development mode requires checkout agent dist", () => {
  assert.throws(
    () => validateDevelopmentRuntime({ agentMode: "development", developmentPath: "/tmp/checkout" }, fs),
    /agent-runtime.*dist\/server\.js/,
  );
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `node --test test/host-config.test.cjs`

Expected: FAIL because `src/host-config.cjs` does not exist.

- [ ] **Step 3: Implement pure configuration normalization**

```js
function validateDevelopmentRuntime(settings, fsImpl = fs) {
  if (settings.agentMode !== "development") return { mode: "bundled", runtimePath: settings.runtimePath, workspacePath: settings.workspacePath };
  const root = settings.developmentPath;
  const runtimePath = path.join(root, "agent-runtime");
  if (!path.isAbsolute(root) || !fsImpl.statSync(root, { throwIfNoEntry: false })?.isDirectory()) throw new Error("开发源码目录必须是存在的绝对目录。");
  if (!fsImpl.existsSync(path.join(runtimePath, "dist", "server.js"))) throw new Error("开发源码目录中的 agent-runtime 未构建：缺少 dist/server.js。");
  return { mode: "development", runtimePath, workspacePath: root };
}
```

- [ ] **Step 4: Run focused tests and commit**

Run: `node --test test/host-config.test.cjs`

Expected: PASS.

```bash
git add src/host-config.cjs test/host-config.test.cjs src/main.cjs
git commit -m "feat: add development runtime configuration"
```

### Task 2: Add development-mode UI and safe Agent reload

**Files:**
- Modify: `src/main.cjs`
- Modify: `src/preload.cjs`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/renderer.js`
- Modify: `src/renderer/styles.css`
- Test: `test/host-config.test.cjs`

**Interfaces:**
- Adds `host:reload-agent` IPC returning the same status shape as `host:status`.
- Adds `settings.agentMode` and `settings.developmentPath`; renderer exposes no filesystem or secret APIs.

- [ ] **Step 1: Write a failing reload lifecycle test using injected process functions**

```js
test("reload keeps the live tunnel and replaces only the agent process", async () => {
  const host = createHostLifecycle({ spawnLogged, waitForHealth, stopChild });
  await host.reloadAgent(settings);
  assert.equal(stopChild.calls[0].name, "Agent 服务");
  assert.equal(spawnLogged.calls[0].label, "agent");
  assert.equal(spawnLogged.calls.some((call) => call.label === "tunnel"), false);
});
```

- [ ] **Step 2: Run the focused lifecycle test and confirm it fails**

Run: `node --test test/host-lifecycle.test.cjs`

Expected: FAIL because `createHostLifecycle` does not exist.

- [ ] **Step 3: Extract lifecycle code and implement reload**

```js
async function reloadAgent(settings) {
  const resolved = validateDevelopmentRuntime(settings);
  await stopChild(serverProcess, "Agent 服务");
  serverProcess = startAgent(resolved.runtimePath, resolved.workspacePath);
  await waitForHealth();
  emit("status", getStatus());
  return getStatus();
}
```

- [ ] **Step 4: Add UI controls and run tests**

Show a mode badge, an absolute development-source chooser, active runtime text, and a disabled Reload Agent button when the server is stopped. Keep Tunnel settings in the required settings card.

Run: `node --test test/host-config.test.cjs test/host-lifecycle.test.cjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat: add development mode and agent reload"
```

### Task 3: Build the token-safe release controller

**Files:**
- Create: `src/release-controller.cjs`
- Create: `src/release-token-store.cjs`
- Create: `test/release-controller.test.cjs`
- Modify: `src/main.cjs`
- Modify: `src/preload.cjs`

**Interfaces:**
- `createReleaseController({ execute, fetchImpl, readToken, log, settings })` exposes `validate()`, `publish({ tag, title, notes })`, and `redact(value)`.
- `release-token-store` exposes `saveGitHubToken`, `readGitHubToken`, `clearGitHubToken`, and `hasGitHubToken`; only Electron main may call it.
- `publish` accepts only `v<SemVer>` tag, checks exact `origin`, and returns `{ releaseUrl, tag, assets, commitSha, windowsNativeVerified: false }`.

- [ ] **Step 1: Write failing controller tests**

```js
test("release refuses a repository other than the configured HTTPS origin", async () => {
  const controller = createReleaseController({ execute: fakeGit("https://github.com/other/repo.git") });
  await assert.rejects(() => controller.publish(validRequest), /chinatownlittlewhite\/webgpt-bridge/);
});

test("release never includes token text in failure output", async () => {
  const controller = createReleaseController({ readToken: async () => "github_pat_secret" });
  await assert.rejects(() => controller.publish(validRequest), (error) => !String(error.message).includes("github_pat_secret"));
});
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `node --test test/release-controller.test.cjs`

Expected: FAIL because release-controller does not exist.

- [ ] **Step 3: Implement exact preflight and local verification**

Use `spawn` with `shell: false` and fixed argv. Validate absolute checkout, `origin` HTTPS URL, SemVer/tag equality, a non-empty token, a clean release-artifact list, and a no-existing-release API response before remote mutation. Run fixed Agent lint/test/build and fixed App package commands. Generate `SHA256SUMS.txt` by hashing only the selected artifacts.

- [ ] **Step 4: Implement source commit/push and GitHub REST release upload**

Use a Git command environment only for `git push`, with hooks disabled and the token never emitted. Use authenticated GitHub REST calls only from Electron main to create the public release and upload verified files. Reject pre-existing Release tags and do not implement deletion or update endpoints.

- [ ] **Step 5: Run tests and commit**

Run: `node --test test/release-controller.test.cjs`

Expected: PASS.

```bash
git add src/release-controller.cjs src/release-token-store.cjs src/main.cjs src/preload.cjs test/release-controller.test.cjs
git commit -m "feat: add verified GitHub release controller"
```

### Task 4: Expose a bounded release-request MCP tool

**Files:**
- Create: `agent-runtime/src/release-client.js`
- Create: `agent-runtime/test/release-client.test.js`
- Modify: `agent-runtime/src/tool.js`
- Modify: `agent-runtime/src/server.js`
- Modify: `agent-runtime/src/index.js`
- Modify: `agent-runtime/test/tool.test.js`

**Interfaces:**
- Adds `release_validate` and `release_publish` tools with `tag`, `title`, and `notes` only.
- The Agent connects to the host's local release bridge without a GitHub token; host-side validation remains authoritative.

- [ ] **Step 1: Write failing schema and client boundary tests**

```js
test("release publish schema rejects repository and token fields", () => {
  assert.equal(releasePublishInputSchema.additionalProperties, false);
  assert.equal(Object.hasOwn(releasePublishInputSchema.properties, "token"), false);
  assert.equal(Object.hasOwn(releasePublishInputSchema.properties, "repository"), false);
});
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `npm --prefix agent-runtime test -- --test-name-pattern="release publish"`

Expected: FAIL because release client and schemas do not exist.

- [ ] **Step 3: Implement the structured client and tool registration**

The client sends only validated JSON to the local host bridge, has a bounded timeout, and returns host redacted output. Register tools only when the host bridge path is configured. Add neither a token field nor a generic HTTP/request tool.

- [ ] **Step 4: Run Agent tests and commit**

Run: `npm --prefix agent-runtime test`

Expected: PASS.

```bash
git add agent-runtime/src agent-runtime/test
git commit -m "feat: expose bounded release MCP tools"
```

### Task 5: Add release settings UI, documentation, and end-to-end dry run

**Files:**
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/renderer.js`
- Modify: `src/renderer/styles.css`
- Modify: `README.md`
- Create: `test/release-workflow.test.cjs`

**Interfaces:**
- Adds GitHub-token present/absent UI state, save/remove actions, source checkout display, and validate-release action.
- README documents Fine-grained Token setup, direct-public-release behavior, recovery after partial failure, and Windows verification caveat.

- [ ] **Step 1: Write failing dry-run workflow test**

```js
test("verified workflow creates no remote release in dry-run mode", async () => {
  const result = await controller.publish({ ...validRequest, dryRun: true });
  assert.equal(result.status, "verified");
  assert.equal(fetchCalls.length, 0);
});
```

- [ ] **Step 2: Run focused test and confirm failure**

Run: `node --test test/release-workflow.test.cjs`

Expected: FAIL because dry-run behavior is not implemented.

- [ ] **Step 3: Implement dry run, settings UI, and concise README workflow**

Dry run must run all local checks but perform no commit, push, Release creation, or upload. The renderer only sees Boolean token status. README must contain exact named tools and state that public publication follows successful validation by design.

- [ ] **Step 4: Run complete verification**

Run:

```bash
node --test test/*.test.cjs
npm --prefix agent-runtime run lint
npm --prefix agent-runtime test
npm --prefix agent-runtime run build
npm run pack
```

Expected: all tests pass and Electron package output is produced.

- [ ] **Step 5: Commit**

```bash
git add src agent-runtime README.md test
git commit -m "feat: document and validate direct public release workflow"
```

## Plan self-review

- Spec coverage: Tasks 1–2 cover bundled/development mode and manual reload; Tasks 3–4 cover token isolation, exact-repository policy, fixed verification, direct public release, and MCP boundary; Task 5 covers UI, documentation, dry-run recovery, and full verification.
- Placeholder scan: no implementation step relies on unspecified file names, public interfaces, or test commands.
- Type consistency: `agentMode`, `developmentPath`, `release_validate`, `release_publish`, `tag`, `title`, and `notes` use the same names across UI, host, Agent client, tests, and documentation.
