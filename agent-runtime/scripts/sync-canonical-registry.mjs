import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const agentRoot = path.resolve(scriptDir, "..");
const repositoryRoot = path.resolve(agentRoot, "..");
const sourceDir = path.join(repositoryRoot, "shared");
const destinationDir = path.join(agentRoot, "shared");
const SHARED_RUNTIME_FILES = Object.freeze([
  "local-broker-protocol.cjs",
  "security-policy-core.cjs",
  "tool-registry.cjs",
]);

fs.mkdirSync(destinationDir, { recursive: true });
for (const name of SHARED_RUNTIME_FILES) {
  const source = path.join(sourceDir, name);
  const destination = path.join(destinationDir, name);
  const sourceStat = fs.lstatSync(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error(`shared runtime source must be a plain file: ${name}`);
  }

  const bytes = fs.readFileSync(source);
  const temp = path.join(destinationDir, `.${name}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temp, bytes, { mode: 0o600 });
    fs.renameSync(temp, destination);
  } finally {
    fs.rmSync(temp, { force: true });
  }

  const projected = fs.readFileSync(destination);
  if (!projected.equals(bytes)) throw new Error(`shared runtime projection verification failed: ${name}`);
}

console.log(`Synced ${SHARED_RUNTIME_FILES.length} shared runtime files to ${path.relative(repositoryRoot, destinationDir)}`);
