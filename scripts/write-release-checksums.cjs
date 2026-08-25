const fs = require("node:fs");
const path = require("node:path");
const { sha256Hex } = require("./release-contract.cjs");

function argument(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

const USER_FACING_EXTENSIONS = new Set([".exe", ".dmg", ".zip"]);
const out = path.resolve(argument("--out", "SHA256SUMS"));
const dirs = process.argv.slice(2).filter((value, index, all) => {
  const previous = all[index - 1];
  return value !== "--out" && previous !== "--out";
});
if (dirs.length === 0) throw new Error("at least one release asset directory is required");

const files = dirs.flatMap((dir) => fs.readdirSync(dir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && USER_FACING_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
  .map((entry) => path.join(dir, entry.name)))
  .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
if (files.length === 0) throw new Error("no user-facing release artifacts found");

const basenames = new Set();
const lines = files.map((file) => {
  const name = path.basename(file);
  const key = name.toLowerCase();
  if (basenames.has(key)) throw new Error(`duplicate release checksum basename: ${name}`);
  basenames.add(key);
  return `${sha256Hex(file)}  ${name}`;
});
fs.writeFileSync(out, `${lines.join("\n")}\n`);
console.log(JSON.stringify({ ok: true, out, count: files.length }));
