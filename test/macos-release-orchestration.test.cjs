const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Step 12 release orchestration contract; executed against the integration-equivalent CI base.
const root = path.join(__dirname, "..");
const orchestratorPath = path.join(root, "scripts", "build-macos-variants.cjs");
const launcherPath = path.join(root, "scripts", "launch-tunnel-client-prepare.cjs");

function loadOrchestrator() {
  assert.ok(fs.existsSync(orchestratorPath), "macOS variant orchestrator must exist");
  delete require.cache[require.resolve(orchestratorPath)];
  return require(orchestratorPath);
}

test("macOS release variants build arm64 then x64 then Universal with matching tunnel bundles", () => {
  const { MAC_VARIANTS, tunnelTargetForVariant, builderArgsForVariant } = loadOrchestrator();
  assert.deepEqual(MAC_VARIANTS, ["arm64", "x64", "universal"]);
  assert.equal(tunnelTargetForVariant("arm64"), "darwin-arm64");
  assert.equal(tunnelTargetForVariant("x64"), "darwin-x64");
  assert.equal(tunnelTargetForVariant("universal"), "darwin-universal");
  assert.deepEqual(builderArgsForVariant("arm64").slice(-3), ["--arm64", "--publish", "never"]);
  assert.deepEqual(builderArgsForVariant("x64").slice(-3), ["--x64", "--publish", "never"]);
  assert.deepEqual(builderArgsForVariant("universal").slice(-3), ["--universal", "--publish", "never"]);
});

test("macOS variant orchestrator prepares each tunnel immediately before its package and never uses a shell", () => {
  const { buildMacVariants } = loadOrchestrator();
  const calls = [];
  const fakeSpawn = (command, args, options) => {
    calls.push({ command, args: [...args], options: { ...options } });
    return { status: 0, signal: null, error: null };
  };

  buildMacVariants({
    spawn: fakeSpawn,
    nodeExecutable: "/trusted/node",
    root: "/project",
    env: { PATH: "/bin" },
  });

  assert.equal(calls.length, 6);
  assert.deepEqual(calls.map((entry) => entry.args.at(-1)), [
    "darwin-arm64",
    "never",
    "darwin-x64",
    "never",
    "darwin-universal",
    "never",
  ]);
  for (const entry of calls) assert.equal(entry.options.shell, false);
  assert.equal(calls[1].options.env.WEBGPT_MAC_PACKAGE_VARIANT, "arm64");
  assert.equal(calls[3].options.env.WEBGPT_MAC_PACKAGE_VARIANT, "x64");
  assert.equal(calls[5].options.env.WEBGPT_MAC_PACKAGE_VARIANT, "universal");
});

test("macOS distribution runs the size verifier only after every package variant is built", () => {
  const { runMacDistribution } = loadOrchestrator();
  const events = [];
  const fakeSpawn = (_command, args) => {
    events.push(args.includes("--arm64") ? "build-arm64"
      : args.includes("--x64") ? "build-x64"
        : args.includes("--universal") ? "build-universal"
          : `prepare-${args.at(-1)}`);
    return { status: 0, signal: null, error: null };
  };
  runMacDistribution({
    spawn: fakeSpawn,
    nodeExecutable: "/trusted/node",
    root: "/project",
    env: { PATH: "/bin" },
    verifyPackages: () => events.push("verify-sizes"),
  });
  assert.deepEqual(events, [
    "prepare-darwin-arm64",
    "build-arm64",
    "prepare-darwin-x64",
    "build-x64",
    "prepare-darwin-universal",
    "build-universal",
    "verify-sizes",
  ]);
});

test("tunnel prepare launcher accepts the explicit macOS x64 vocabulary", () => {
  delete require.cache[require.resolve(launcherPath)];
  const { buildPrepareNodeArgs } = require(launcherPath);
  const args = buildPrepareNodeArgs("darwin-x64");
  assert.equal(args.at(-1), "darwin-x64");
});

test("root dist:mac runs common gates once and delegates the complete macOS distribution to the orchestrator", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const script = pkg.scripts["dist:mac"];
  assert.match(script, /npm run build:icon/);
  assert.match(script, /npm run prepare:agent/);
  assert.match(script, /npm run verify:desktop/);
  assert.match(script, /npm --prefix agent-runtime run acceptance/);
  assert.match(script, /node scripts\/build-macos-variants\.cjs$/);
  assert.doesNotMatch(script, /prepare:tunnel-client:mac/);
  assert.doesNotMatch(script, /electron-builder/);
});
