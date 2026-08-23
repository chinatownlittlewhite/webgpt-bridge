import fs from "node:fs";
import path from "node:path";

const obsoleteDemoFiles = ["src/catalog.js", "test/catalog.test.js"];
for (const file of obsoleteDemoFiles) {
  fs.rmSync(file, { force: true });
}

fs.rmSync("dist", { recursive: true, force: true });
fs.mkdirSync("dist", { recursive: true });

for (const entry of fs.readdirSync("src", { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
  fs.copyFileSync(path.join("src", entry.name), path.join("dist", entry.name));
}

console.log("Built dist/ and removed obsolete demo files");
