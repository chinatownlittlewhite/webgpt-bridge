const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { verifyMacPackages } = require("./verify-package-sizes.cjs");

const MAC_VARIANTS = Object.freeze(["arm64", "x64", "universal"]);
const ARCH_FLAGS = Object.freeze({ arm64: "--arm64", x64: "--x64", universal: "--universal" });
const TUNNEL_TARGETS = Object.freeze({
  arm64: "darwin-arm64",
  x64: "darwin-x64",
  universal: "darwin-universal",
});

function requireVariant(variant) {
  if (!MAC_VARIANTS.includes(variant)) throw new Error(`Unsupported macOS package variant: ${variant || "(missing)"}`);
  return variant;
}

function tunnelTargetForVariant(variant) {
  return TUNNEL_TARGETS[requireVariant(variant)];
}

function builderArgsForVariant(variant) {
  return [
    "--config",
    "electron-builder.config.cjs",
    "--mac",
    "dmg",
    "zip",
    ARCH_FLAGS[requireVariant(variant)],
    "--publish",
    "never",
  ];
}

function runChecked(spawn, command, args, options, label) {
  const result = spawn(command, args, options);
  if (result?.error) throw result.error;
  if (result?.signal) throw new Error(`${label} terminated by ${result.signal}`);
  if (!Number.isInteger(result?.status) || result.status !== 0) {
    throw new Error(`${label} exited with ${Number.isInteger(result?.status) ? result.status : "unknown status"}`);
  }
}

function buildMacVariants({
  spawn = spawnSync,
  nodeExecutable = process.execPath,
  root = path.resolve(__dirname, ".."),
  env = process.env,
} = {}) {
  const prepareLauncher = path.join(root, "scripts", "launch-tunnel-client-prepare.cjs");
  const builderCli = path.join(root, "node_modules", "electron-builder", "out", "cli", "cli.js");

  for (const variant of MAC_VARIANTS) {
    const childOptions = {
      cwd: root,
      env: { ...env },
      stdio: "inherit",
      shell: false,
      windowsHide: true,
    };
    runChecked(
      spawn,
      nodeExecutable,
      [prepareLauncher, tunnelTargetForVariant(variant)],
      childOptions,
      `tunnel-client prepare (${variant})`,
    );
    runChecked(
      spawn,
      nodeExecutable,
      [builderCli, ...builderArgsForVariant(variant)],
      {
        ...childOptions,
        env: { ...env, WEBGPT_MAC_PACKAGE_VARIANT: variant },
      },
      `electron-builder (${variant})`,
    );
  }
}

function runMacDistribution({ verifyPackages = verifyMacPackages, ...buildOptions } = {}) {
  buildMacVariants(buildOptions);
  return verifyPackages();
}

if (require.main === module) {
  try {
    runMacDistribution();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exit(1);
  }
}

module.exports = {
  MAC_VARIANTS,
  builderArgsForVariant,
  buildMacVariants,
  runMacDistribution,
  tunnelTargetForVariant,
};
