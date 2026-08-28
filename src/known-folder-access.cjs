const path = require("node:path");

const ALLOWED_FOLDERS = Object.freeze(["desktop", "downloads", "documents"]);

function normalizeRelativePath(value = "") {
  if (typeof value !== "string" || value.includes("\0")) throw new TypeError("relativePath 必须是不含 NUL 的相对路径字符串。");
  const trimmed = value.trim();
  if (!trimmed || trimmed === ".") return "";
  if (path.isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed)) throw new TypeError("relativePath 必须是相对路径。");
  const segments = trimmed.split(/[\\/]+/);
  if (segments.some((segment) => segment === "..")) throw new TypeError("relativePath 不能跳出固定目录。");
  return segments.filter((segment) => segment && segment !== ".").join(path.sep);
}

function createKnownFolderAccess({ roots, fileBroker } = {}) {
  if (!roots || typeof roots !== "object" || Array.isArray(roots)) throw new TypeError("known-folder roots 必须是对象。");
  if (!fileBroker || typeof fileBroker.list !== "function" || typeof fileBroker.read !== "function") throw new TypeError("known-folder access 需要本机文件 broker。");
  const normalizedRoots = {};
  for (const folder of ALLOWED_FOLDERS) {
    const root = roots[folder];
    if (typeof root !== "string" || !path.isAbsolute(root)) throw new TypeError(`${folder} 固定目录必须是绝对路径。`);
    normalizedRoots[folder] = root;
  }

  function resolveTarget(folder, relativePath) {
    if (!ALLOWED_FOLDERS.includes(folder)) throw new TypeError("folder 只能是 desktop、downloads 或 documents。");
    const relative = normalizeRelativePath(relativePath);
    return relative ? path.join(normalizedRoots[folder], relative) : normalizedRoots[folder];
  }

  function list({ folder, relativePath = "", depth = 1, includeHidden = false } = {}) {
    return fileBroker.list({ path: resolveTarget(folder, relativePath), depth, includeHidden });
  }

  function read({ folder, relativePath = "", startLine = 1, maxLines = 200 } = {}) {
    return fileBroker.read({ path: resolveTarget(folder, relativePath), startLine, maxLines });
  }

  return Object.freeze({ list, read });
}

module.exports = { ALLOWED_FOLDERS, createKnownFolderAccess, normalizeRelativePath };
