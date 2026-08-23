import { createHash } from "node:crypto";
import path from "node:path";
import { INTERNAL_STATE_DIR } from "./workspace.js";

function assertWrappedArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new TypeError("sandbox adapter must return a non-empty argv array");
  }
  for (const arg of argv) {
    if (typeof arg !== "string" || arg.length === 0 || arg.includes("\0")) {
      throw new TypeError("sandbox adapter argv entries must be non-empty strings without NUL bytes");
    }
  }
}

function quoteSeatbelt(value) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function subpathRule(operation, paths) {
  const unique = [...new Set(paths.map((entry) => path.resolve(entry)))];
  if (unique.length === 0) return "";
  return `(allow ${operation} ${unique.map((entry) => `(subpath ${quoteSeatbelt(entry)})`).join(" ")})`;
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function createNoSandboxAdapter() {
  return Object.freeze({
    name: "none",
    enforced: false,
    autoRunSafe: false,
    verificationId: "none",
    capabilities: Object.freeze({
      readIsolation: "none",
      writeIsolation: "none",
      networkIsolation: "none",
    }),
    wrapArgv({ argv }) {
      return [...argv];
    },
  });
}

export function createMacOSSandboxExecAdapter({
  sandboxExecPath = "/usr/bin/sandbox-exec",
  allowNetwork = false,
  extraReadPaths = [],
} = {}) {
  if (typeof sandboxExecPath !== "string" || !path.isAbsolute(sandboxExecPath)) {
    throw new TypeError("sandboxExecPath must be an absolute path supplied by the trusted host");
  }
  if (!Array.isArray(extraReadPaths) || extraReadPaths.some((entry) => typeof entry !== "string")) {
    throw new TypeError("extraReadPaths must be an array of path strings");
  }
  const normalizedExtraReadPaths = [...new Set(extraReadPaths.map((entry) => path.resolve(entry)))].sort();
  const verificationId = fingerprint({
    name: "macos-sandbox-exec",
    sandboxExecPath,
    allowNetwork,
    extraReadPaths: normalizedExtraReadPaths,
  });

  return Object.freeze({
    name: "macos-sandbox-exec",
    enforced: true,
    autoRunSafe: false,
    verificationId,
    capabilities: Object.freeze({
      readIsolation: "seatbelt-profile",
      writeIsolation: "workspace-only",
      networkIsolation: allowNetwork ? "host-network" : "deny",
    }),
    wrapArgv({ argv, workspace, extraReadPaths: dynamicReadPaths = [], extraWritePaths: dynamicWritePaths = [] }) {
      const workspaceRoot = path.resolve(workspace);
      const tempRoot = path.join(workspaceRoot, INTERNAL_STATE_DIR, "tmp");
      const systemReadRoots = [
        "/System",
        "/usr",
        "/bin",
        "/sbin",
        "/Library",
        "/opt/homebrew",
        "/usr/local",
      ];
      const profile = [
        "(version 1)",
        "(deny default)",
        "(allow process*)",
        "(allow signal (target self))",
        "(allow sysctl-read)",
        "(allow mach-lookup)",
        "(allow ipc-posix-shm)",
        "(allow file-read-metadata)",
        subpathRule("file-read*", [...systemReadRoots, workspaceRoot, ...normalizedExtraReadPaths, ...dynamicReadPaths, ...dynamicWritePaths]),
        subpathRule("file-write*", [workspaceRoot, tempRoot, ...dynamicWritePaths]),
        '(allow file-read* (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))',
        '(allow file-write* (literal "/dev/null"))',
        allowNetwork ? "(allow network*)" : "(deny network*)",
      ]
        .filter(Boolean)
        .join("\n");

      return [sandboxExecPath, "-p", profile, ...argv];
    },
  });
}

export function createBubblewrapAdapter({
  bubblewrapPath = "/usr/bin/bwrap",
  allowNetwork = false,
  extraReadPaths = [],
} = {}) {
  if (typeof bubblewrapPath !== "string" || !path.isAbsolute(bubblewrapPath)) {
    throw new TypeError("bubblewrapPath must be an absolute path supplied by the trusted host");
  }
  if (!Array.isArray(extraReadPaths) || extraReadPaths.some((entry) => typeof entry !== "string")) {
    throw new TypeError("extraReadPaths must be an array of path strings");
  }
  const normalizedExtraReadPaths = [...new Set(extraReadPaths.map((entry) => path.resolve(entry)))].sort();
  const verificationId = fingerprint({
    name: "linux-bubblewrap",
    bubblewrapPath,
    allowNetwork,
    extraReadPaths: normalizedExtraReadPaths,
  });

  return Object.freeze({
    name: "linux-bubblewrap",
    enforced: true,
    autoRunSafe: false,
    verificationId,
    capabilities: Object.freeze({
      readIsolation: "mount-namespace-allowlist",
      writeIsolation: "workspace-only",
      networkIsolation: allowNetwork ? "host-network" : "network-namespace",
    }),
    wrapArgv({ argv, cwd, workspace, extraReadPaths: dynamicReadPaths = [], extraWritePaths: dynamicWritePaths = [] }) {
      const workspaceRoot = path.resolve(workspace);
      const systemRoots = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/opt", "/nix/store"];
      const args = [
        bubblewrapPath,
        "--die-with-parent",
        "--new-session",
        "--unshare-user",
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-uts",
        "--unshare-cgroup-try",
      ];
      if (!allowNetwork) args.push("--unshare-net");
      args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
      for (const root of systemRoots) args.push("--ro-bind-try", root, root);
      for (const root of [...normalizedExtraReadPaths, ...dynamicReadPaths]) args.push("--ro-bind-try", path.resolve(root), path.resolve(root));
      for (const root of dynamicWritePaths) args.push("--bind-try", path.resolve(root), path.resolve(root));
      args.push("--bind", workspaceRoot, workspaceRoot);
      args.push("--chdir", path.resolve(cwd));
      args.push("--", ...argv);
      return args;
    },
  });
}

export function createMacOSSeatbeltAdapter(options = {}) {
  const base = createMacOSSandboxExecAdapter(options);
  const verificationId = fingerprint({
    name: "macos-seatbelt",
    backend: base.verificationId,
  });
  return Object.freeze({
    ...base,
    name: "macos-seatbelt",
    verificationId,
    capabilities: Object.freeze({
      ...base.capabilities,
      processIsolation: "seatbelt-policy",
    }),
  });
}

export function createWindowsAppContainerAdapter({
  helperPath,
  allowNetwork = false,
  extraReadPaths = [],
  profilePrefix = "LocalProjectCoding",
} = {}) {
  if (
    typeof helperPath !== "string" ||
    !(path.isAbsolute(helperPath) || path.win32.isAbsolute(helperPath))
  ) {
    throw new TypeError("Windows AppContainer helperPath must be an absolute trusted-host path");
  }
  if (!Array.isArray(extraReadPaths) || extraReadPaths.some((entry) => typeof entry !== "string")) {
    throw new TypeError("extraReadPaths must be an array of path strings");
  }
  if (typeof profilePrefix !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(profilePrefix)) {
    throw new TypeError("profilePrefix must contain only safe profile-name characters");
  }
  const normalizedExtraReadPaths = [...new Set(extraReadPaths.map((entry) => path.resolve(entry)))].sort();
  const verificationId = fingerprint({
    name: "windows-appcontainer",
    helperPath,
    allowNetwork,
    extraReadPaths: normalizedExtraReadPaths,
    profilePrefix,
  });

  return Object.freeze({
    name: "windows-appcontainer",
    enforced: true,
    autoRunSafe: false,
    verificationId,
    capabilities: Object.freeze({
      readIsolation: "appcontainer-token",
      writeIsolation: "workspace-acl",
      networkIsolation: allowNetwork ? "internet-client-capability" : "no-network-capability",
      processIsolation: "windows-job-object",
    }),
    wrapArgv({ argv, cwd, workspace, extraReadPaths: dynamicReadPaths = [], extraWritePaths: dynamicWritePaths = [] }) {
      const args = [
        helperPath,
        "--profile-prefix",
        profilePrefix,
        "--workspace",
        path.resolve(workspace),
        "--cwd",
        path.resolve(cwd),
        "--parent-pid",
        String(process.pid),
        "--network",
        allowNetwork ? "allow" : "deny",
      ];
      for (const readPath of [...normalizedExtraReadPaths, ...dynamicReadPaths]) args.push("--read-path", path.resolve(readPath));
      for (const writePath of dynamicWritePaths) args.push("--write-path", path.resolve(writePath));
      args.push("--", ...argv);
      return args;
    },
  });
}

export function createNativeSandboxAdapter({
  platform = process.platform,
  windowsHelperPath,
  allowNetwork = false,
  extraReadPaths = [],
  macSandboxExecPath,
  bubblewrapPath,
} = {}) {
  if (platform === "win32") {
    return windowsHelperPath
      ? createWindowsAppContainerAdapter({ helperPath: windowsHelperPath, allowNetwork, extraReadPaths })
      : createNoSandboxAdapter();
  }
  if (platform === "darwin") {
    return createMacOSSeatbeltAdapter({
      ...(macSandboxExecPath ? { sandboxExecPath: macSandboxExecPath } : {}),
      allowNetwork,
      extraReadPaths,
    });
  }
  if (platform === "linux") {
    return createBubblewrapAdapter({
      ...(bubblewrapPath ? { bubblewrapPath } : {}),
      allowNetwork,
      extraReadPaths,
    });
  }
  return createNoSandboxAdapter();
}

export function normalizeSandboxAdapter(adapter) {
  const resolved = adapter ?? createNoSandboxAdapter();
  if (!resolved || typeof resolved !== "object") {
    throw new TypeError("sandboxAdapter must be an object");
  }
  if (typeof resolved.name !== "string" || resolved.name.length === 0) {
    throw new TypeError("sandboxAdapter.name must be a non-empty string");
  }
  if (typeof resolved.enforced !== "boolean") {
    throw new TypeError("sandboxAdapter.enforced must be a boolean");
  }
  if (resolved.autoRunSafe !== undefined && typeof resolved.autoRunSafe !== "boolean") {
    throw new TypeError("sandboxAdapter.autoRunSafe must be a boolean when supplied");
  }
  if (
    resolved.verificationId !== undefined &&
    (typeof resolved.verificationId !== "string" || resolved.verificationId.length === 0)
  ) {
    throw new TypeError("sandboxAdapter.verificationId must be a non-empty string when supplied");
  }
  if (typeof resolved.wrapArgv !== "function") {
    throw new TypeError("sandboxAdapter.wrapArgv must be a function");
  }
  return Object.freeze({
    ...resolved,
    autoRunSafe: resolved.autoRunSafe === true,
    capabilities: Object.freeze({
      readIsolation: resolved.capabilities?.readIsolation ?? "unknown",
      writeIsolation: resolved.capabilities?.writeIsolation ?? "unknown",
      networkIsolation: resolved.capabilities?.networkIsolation ?? "unknown",
      processIsolation: resolved.capabilities?.processIsolation ?? "unknown",
    }),
  });
}

export function sandboxSummary(adapter) {
  const normalized = normalizeSandboxAdapter(adapter);
  return {
    name: normalized.name,
    enforced: normalized.enforced,
    autoRunSafe: normalized.autoRunSafe,
    verificationId: normalized.verificationId ?? null,
    capabilities: normalized.capabilities,
  };
}

export function wrapWithSandbox(adapter, context) {
  const wrapped = adapter.wrapArgv({
    argv: [...context.argv],
    cwd: context.cwd,
    workspace: context.workspace,
    extraReadPaths: Array.isArray(context.extraReadPaths) ? [...context.extraReadPaths] : [],
    extraWritePaths: Array.isArray(context.extraWritePaths) ? [...context.extraWritePaths] : [],
  });
  assertWrappedArgv(wrapped);
  return wrapped;
}
