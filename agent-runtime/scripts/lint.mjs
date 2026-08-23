import fs from "node:fs";
import path from "node:path";

const roots = ["src", "test", "scripts"];
const files = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(?:js|mjs)$/.test(entry.name)) files.push(full);
  }
}

for (const root of roots) {
  if (fs.existsSync(root)) walk(root);
}

const problems = [];
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  if (text.includes("\t")) problems.push(`${file}: contains tab characters`);
  if (/ +$/m.test(text)) problems.push(`${file}: contains trailing whitespace`);
  if (!text.endsWith("\n")) problems.push(`${file}: missing final newline`);
}

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}

console.log(`Lint OK (${files.length} files checked)`);
