import path from "node:path";

const INTERNAL_STATE_DIR = ".webgpt-bridge";

export function isNestedWindowsAppContainer({
  platform = process.platform,
  userProfile = process.env.USERPROFILE,
  cwd = process.cwd(),
} = {}) {
  if (platform !== "win32" || typeof userProfile !== "string" || userProfile.length === 0) return false;
  const expected = path.win32.join(
    path.win32.resolve(cwd),
    INTERNAL_STATE_DIR,
    "windows-profile",
  );
  return path.win32.resolve(userProfile).toLowerCase() === expected.toLowerCase();
}

export function isNestedMacOSManagedRunner({
  platform = process.platform,
  home = process.env.HOME,
  tmpdir = process.env.TMPDIR,
  cwd = process.cwd(),
} = {}) {
  if (
    platform !== "darwin" ||
    typeof home !== "string" || home.length === 0 ||
    typeof tmpdir !== "string" || tmpdir.length === 0
  ) return false;
  const resolvedHome = path.resolve(home);
  const resolvedCwd = path.resolve(cwd);
  const relativeCwd = path.relative(resolvedHome, resolvedCwd);
  const cwdInsideSandboxRoot = relativeCwd === "" || (
    relativeCwd !== ".." &&
    !relativeCwd.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativeCwd)
  );
  return cwdInsideSandboxRoot
    && path.resolve(tmpdir) === path.join(resolvedHome, INTERNAL_STATE_DIR, "tmp");
}

export function isManagedNestedSandbox(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return isNestedWindowsAppContainer({ ...options, platform });
  if (platform === "darwin") return isNestedMacOSManagedRunner({ ...options, platform });
  return false;
}
