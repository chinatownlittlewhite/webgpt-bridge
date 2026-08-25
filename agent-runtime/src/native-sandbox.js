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
        expectedPath: helper,
        reason: `Windows AppContainer helper not found at ${helper}; run npm run build:native on Windows`,
      };
    }
    return {
      adapter: createWindowsAppContainerAdapter({ helperPath: helper, allowNetwork, extraReadPaths }),
      available: true,
      expectedPath: helper,
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

export function sandboxPreparationDiagnostic(prepared, {
  enabled = true,
  platform = process.platform,
  allowNetwork = false,
} = {}) {
  if (enabled !== true) {
    return Object.freeze({
      status: "disabled",
      usable: false,
      enabled: false,
      platform,
      allowNetwork: allowNetwork === true,
      reason: "dedicated network sandbox is disabled",
      recoverable: true,
    });
  }

  const discovery = prepared?.discovery ?? null;
  const verification = prepared?.verification ?? null;
  const summary = prepared?.summary ?? null;
  const expectedPath = discovery?.expectedPath;
  const base = {
    enabled: true,
    platform,
    allowNetwork: allowNetwork === true,
    usable: summary?.autoRunSafe === true,
  };

  if (!prepared || !discovery) {
    return Object.freeze({
      ...base,
      status: "preparation_failed",
      usable: false,
      reason: "native sandbox preparation did not produce discovery state",
      recoverable: true,
    });
  }

  if (discovery.available !== true) {
    const reason = discovery.reason ?? "native sandbox backend is unavailable";
    const helperMissing = platform === "win32" && /helper not found/i.test(reason);
    const unsupported = /not implemented|unsupported platform/i.test(reason);
    return Object.freeze({
      ...base,
      status: helperMissing ? "helper_missing" : unsupported ? "unsupported" : "backend_unavailable",
      usable: false,
      reason,
      recoverable: !unsupported,
      ...(expectedPath ? { expectedPath } : {}),
    });
  }

  if (summary?.autoRunSafe === true) {
    return Object.freeze({
      ...base,
      status: "ready",
      reason: discovery.reason ?? "native sandbox is verified",
      recoverable: false,
      ...(expectedPath ? { expectedPath } : {}),
      ...(summary ? { sandbox: summary } : {}),
    });
  }

  if (verification?.passed === false) {
    return Object.freeze({
      ...base,
      status: "verification_failed",
      usable: false,
      reason: verification.reason ?? "native sandbox verification failed",
      recoverable: true,
      ...(expectedPath ? { expectedPath } : {}),
      ...(verification?.probe?.code !== undefined && verification?.probe?.code !== null
        ? { errorCode: verification.probe.code }
        : {}),
      verification,
      ...(summary ? { sandbox: summary } : {}),
    });
  }

  return Object.freeze({
    ...base,
    status: "unverified",
    usable: false,
    reason: discovery.reason ?? "native sandbox has not been verified",
    recoverable: true,
    ...(expectedPath ? { expectedPath } : {}),
    ...(summary ? { sandbox: summary } : {}),
  });
}

export function nativeSandboxVerificationRequirements({ platform = process.platform, allowNetwork = false } = {}) {
  return {
    requireNetworkBlocked: allowNetwork !== true,
    // Windows AppContainer without a machine-level loopback exemption is intentionally stricter:
    // localhost is blocked together with external network access. Do not weaken host network
    // isolation or mutate global CheckNetIsolation settings merely to satisfy the verifier.
    requireLoopback: platform !== "win32",
    // Windows profile creation and ACL initialization are substantially heavier than Seatbelt/bwrap.
    // Keep verification bounded, but give the real AppContainer probe the same human-scale budget
    // as the native developer smoke instead of failing a secure first launch at the 5s default.
    timeoutMs: platform === "win32" ? 30_000 : 5_000,
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
