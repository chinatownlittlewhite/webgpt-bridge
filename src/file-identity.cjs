const fsp = require("node:fs/promises");

function freezeFileIdentity(candidate, stat) {
  return Object.freeze({
    path: candidate,
    size: Number(stat.size),
    mtimeMs: Number(stat.mtimeMs),
    dev: Number(stat.dev),
    ino: Number(stat.ino),
  });
}

async function readFileIdentity(candidate, options = {}) {
  if (typeof candidate !== "string" || !candidate) throw new TypeError("FileIdentity path is required");
  const statFile = typeof options.statFile === "function" ? options.statFile : fsp.stat;
  const stat = await statFile(candidate, { bigint: false });
  if (!stat.isFile()) throw Object.assign(new Error("Runtime candidate is not a regular file"), { code: "FILE_IDENTITY_INVALID" });
  return freezeFileIdentity(candidate, stat);
}

function fileIdentityKey(identity) {
  if (!identity || typeof identity !== "object") return "";
  return JSON.stringify([
    identity.path || "",
    Number(identity.size),
    Number(identity.mtimeMs),
    Number(identity.dev),
    Number(identity.ino),
  ]);
}

module.exports = { fileIdentityKey, freezeFileIdentity, readFileIdentity };
