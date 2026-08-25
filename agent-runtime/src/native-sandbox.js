import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findExecutableInPath, normalizedPlatform } from "./platform.js";
import {
  createBubblewrapAdapter,
  createMacOSSeatbeltAdapter,
  createNoSandboxAdapter,
  createWindowsAppContainerAdapter,
  sandboxSummary,
} from "./sandbox.js";
import { promoteVerifiedSandboxAdapter, verifySandboxAdapter } from "./sandbox-verify.js";

function moduleRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function discoverNativeSandboxAdapter({
  platform = process.platform,
  allowNetwork = false,
  extraReadPaths = [],
  windowsHelperPath,
} = {}) {
  if (platform === "win32") {
    const helper = windowsHelperPath ?? path.join(
      moduleRoot(),
      "native",
      "windows-sandbox",
      "bin",
      "release",
      "lpc-windows-sandbox.exe",
    );
    if (!fs.existsSync(helper)) {
      return {
        adapter: createNoSandboxAdapter(),
        available: false,
        reason: `Windows AppContainer helper not found at ${helper}; run npm run build:native on Windows`,
      };
    }
    return {
      adapter: createWindowsAppContainerAdapter({ helperPath: helper, allowNetwork, extraReadPaths }),
      available: true,
      reason: "Windows AppContainer helper found",
    };
  }

  if (platform === "darwin") {
    const executable = "/usr/bin/sandbox-exec";
    if (!fs.existsSync(executable)) {
      return { adapter: createNoSandboxAdapter(), available: false, reason: "macOS Seatbelt launcher is unavailable" };
    }
    return {
      adapter: createMacOSSeatbeltAdapter({ sandboxExecPath: executable, allowNetwork, extraReadPaths }),
      available: true,
      reason: "macOS Seatbelt launcher found",
    };
  }

  if (platform === "linux") {
    const bwrap = findExecutableInPath("bwrap", { platform });
    if (!bwrap) {
      return { adapter: createNoSandboxAdapter(), available: false, reason: "Bubblewrap is not installed" };
    }
    return {
      adapter: createBubblewrapAdapter({ bubblewrapPath: bwrap, allowNetwork, extraReadPaths }),
      available: true,
      reason: "Bubblewrap found",
    };
  }

  return {
    adapter: createNoSandboxAdapter(),
    available: false,
    reason: `no native sandbox backend is implemented for ${normalizedPlatform(platform)}`,
  };
}

export function nativeSandboxVerificationRequirements({ platform = process.platform, allowNetwork = false } = {}) {
  return {
    requireNetworkBlocked: allowNetwork !== true,
    // Windows AppContainer without a machine-level loopback exemption is intentionally stricter:
    // localhost is blocked together with external network access. Do not weaken host network
    // isolation or mutate global CheckNetIsolation settings merely to satisfy the verifier.
    requireLoopback: platform !== "win32",
  };
}

export async function prepareNativeSandbox({
  workspace,
  platform = process.platform,
  allowNetwork = false,
  extraReadPaths = [],
  windowsHelperPath,
  verify = true,
} = {}) {
  const discovered = discoverNativeSandboxAdapter({ platform, allowNetwork, extraReadPaths, windowsHelperPath });
  if (!discovered.available || verify !== true) {
    return {
      adapter: discovered.adapter,
      discovery: discovered,
      verification: null,
      summary: sandboxSummary(discovered.adapter),
    };
  }

  const verification = await verifySandboxAdapter({
    adapter: discovered.adapter,
    workspace,
    ...nativeSandboxVerificationRequirements({ platform, allowNetwork }),
  });
  const adapter = verification.passed
    ? promoteVerifiedSandboxAdapter(discovered.adapter, verification)
    : discovered.adapter;
  return {
    adapter,
    discovery: discovered,
    verification,
    summary: sandboxSummary(adapter),
  };
}
