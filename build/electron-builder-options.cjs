const fs = require("node:fs");
const path = require("node:path");
const { normalizeNodePtyMacPayload } = require("../scripts/node-pty-macos-payload.cjs");

function required(env, name) {
  const value = String(env[name] || "").trim();
  if (!value) throw new Error(`Missing formal release configuration: ${name}`);
  return value;
}

function agentDevDependencyExcludes() {
  const lockPath = path.join(__dirname, "..", "agent-runtime", "package-lock.json");
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  return Object.entries(lock.packages || {})
    .filter(([packagePath, metadata]) => packagePath.startsWith("node_modules/") && metadata?.dev === true)
    .map(([packagePath]) => `!agent-runtime/${packagePath}/**/*`)
    .sort();
}

async function normalizeMacNodePtyAfterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const productFilename = context.packager.appInfo.productFilename;
  const appRoot = path.join(context.appOutDir, `${productFilename}.app`);
  normalizeNodePtyMacPayload(appRoot);
}

function createBuilderConfig(env = process.env) {
  const formalPlatform = String(env.WEBGPT_FORMAL_RELEASE || "").trim();
  if (formalPlatform && formalPlatform !== "windows" && formalPlatform !== "macos") {
    throw new Error("WEBGPT_FORMAL_RELEASE must be windows or macos");
  }

  const config = {
    afterPack: normalizeMacNodePtyAfterPack,
    appId: "com.localagenthost.desktop",
    productName: "WebGPT Bridge",
    artifactName: "WebGPT-Bridge-${version}-${os}-${arch}.${ext}",
    asar: true,
    asarUnpack: [
      "agent-runtime/dist/**/*",
      "agent-runtime/node_modules/**/*",
      "agent-runtime/package.json",
      "agent-runtime/native/windows-host/bin/release/**/*",
      "shared/**/*",
    ],
    electronLanguages: ["en-US", "zh-CN", "zh-TW", "ja"],
    npmRebuild: false,
    directories: { buildResources: "build", output: "release" },
    files: [
      "src/**/*",
      "!src/update-e2e-control.cjs",
      "agent-runtime/dist/**/*",
      "agent-runtime/node_modules/**/*",
      "!agent-runtime/node_modules/.bin/**/*",
      ...agentDevDependencyExcludes(),
      "agent-runtime/package.json",
      "agent-runtime/native/windows-host/bin/release/**/*",
      "shared/**/*",
      "package.json",
      "README.md",
    ],
    extraResources: [
      { from: "build/tunnel-client", to: "tunnel-client" },
      { from: "agent-runtime/shared", to: "app.asar.unpacked/agent-runtime/shared" },
    ],
    publish: [{ provider: "github", owner: "chinatownlittlewhite", repo: "webgpt-bridge", releaseType: "draft" }],
    mac: {
      icon: "build/icon.icns",
      category: "public.app-category.developer-tools",
      target: ["dmg", "zip"],
      mergeASARs: false,
      x64ArchFiles: "**/{node-pty/prebuilds/darwin-*/pty.node,node-pty/prebuilds/darwin-*/spawn-helper,node-pty-helper/darwin-*/spawn-helper}",
      hardenedRuntime: true,
      gatekeeperAssess: false,
    },
    win: {
      target: ["nsis"],
      verifyUpdateCodeSignature: true,
      extraResources: [
        { from: "build/windows-host-prep-task.xml", to: "windows-host-prep-task.xml" },
        { from: "build/node-runtime", to: "node-runtime" },
      ],
    },
    nsis: {
      oneClick: false,
      perMachine: true,
      include: "build/installer.nsh",
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
    },
  };

  if (formalPlatform === "windows") {
    config.win.forceCodeSigning = true;
    config.win.azureSignOptions = {
      publisherName: required(env, "WEBGPT_WINDOWS_PUBLISHER"),
      endpoint: required(env, "WEBGPT_WINDOWS_SIGN_ENDPOINT"),
      codeSigningAccountName: required(env, "WEBGPT_WINDOWS_SIGN_ACCOUNT"),
      certificateProfileName: required(env, "WEBGPT_WINDOWS_SIGN_PROFILE"),
    };
  }

  if (formalPlatform === "macos") {
    config.mac.forceCodeSigning = true;
    config.mac.identity = required(env, "WEBGPT_MAC_IDENTITY");
    config.mac.notarize = true;
    config.mac.entitlements = "build/entitlements.mac.plist";
    config.mac.entitlementsInherit = "build/entitlements.mac.plist";
    config.mac.binaries = [
      "Contents/Resources/tunnel-client/tunnel-client",
      "Contents/Resources/tunnel-client/cloudflared",
    ];
  }

  return config;
}

module.exports = { createBuilderConfig };
