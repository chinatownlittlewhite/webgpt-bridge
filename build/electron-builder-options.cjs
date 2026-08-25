function required(env, name) {
  const value = String(env[name] || "").trim();
  if (!value) throw new Error(`Missing formal release configuration: ${name}`);
  return value;
}

function createBuilderConfig(env = process.env) {
  const formalPlatform = String(env.WEBGPT_FORMAL_RELEASE || "").trim();
  if (formalPlatform && formalPlatform !== "windows" && formalPlatform !== "macos") {
    throw new Error("WEBGPT_FORMAL_RELEASE must be windows or macos");
  }

  const config = {
    appId: "com.localagenthost.desktop",
    productName: "WebGPT Bridge",
    artifactName: "${productName}-${version}-${os}-${arch}.${ext}",
    asar: true,
    asarUnpack: ["agent-runtime/**/*"],
    npmRebuild: false,
    directories: { buildResources: "build", output: "release" },
    files: [
      "src/**/*",
      "!src/update-e2e-control.cjs",
      "agent-runtime/**/*",
      "!agent-runtime/.webgpt-bridge{,/**}",
      "!agent-runtime/.npm{,/**}",
      "package.json",
      "README.md",
    ],
    extraResources: [{ from: "build/tunnel-client", to: "tunnel-client" }],
    publish: [{ provider: "github", owner: "chinatownlittlewhite", repo: "webgpt-bridge", releaseType: "draft" }],
    mac: {
      icon: "build/icon.icns",
      category: "public.app-category.developer-tools",
      target: ["dmg", "zip"],
      mergeASARs: false,
      x64ArchFiles: "**/node-pty/prebuilds/darwin-*/{pty.node,spawn-helper}",
      hardenedRuntime: true,
      gatekeeperAssess: false,
    },
    win: {
      target: ["nsis"],
      verifyUpdateCodeSignature: true,
    },
    nsis: {
      oneClick: false,
      perMachine: true,
      include: "build/installer.nsh",
      allowToChangeInstallationDirectory: false,
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
