const fs = require("node:fs");
const { version } = require("../package.json");
const { verifyTagVersion } = require("./release-contract.cjs");

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || "" : "";
}

const tag = argument("--tag") || process.env.GITHUB_REF_NAME || "";
verifyTagVersion({ tag, version });
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\ntag=${tag}\n`);
}
console.log(JSON.stringify({ ok: true, version, tag }));
