import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const agentRoot = path.resolve(scriptDir, "..");
const repositoryRoot = path.resolve(agentRoot, "..");
const source = path.join(repositoryRoot, "shared", "tool-registry.cjs");
const destinationDir = path.join(agentRoot, "shared");
const destination = path.join(destinationDir, "tool-registry.cjs");

const sourceStat = fs.lstatSync(source);
if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
  throw new Error("canonical tool registry source must be a plain file");
}

fs.mkdirSync(destinationDir, { recursive: true });
const bytes = fs.readFileSync(source);
const temp = path.join(destinationDir, `.tool-registry.cjs.${process.pid}.tmp`);
try {
  fs.writeFileSync(temp, bytes, { mode: 0o600 });
  fs.renameSync(temp, destination);
} finally {
  fs.rmSync(temp, { force: true });
}

const projected = fs.readFileSync(destination);
if (!projected.equals(bytes)) throw new Error("canonical tool registry projection verification failed");

console.log(`Synced canonical tool registry to ${path.relative(repositoryRoot, destination)}`);
