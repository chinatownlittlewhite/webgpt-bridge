import test from "node:test";
import assert from "node:assert/strict";
import { localRunCommandInputSchema } from "../src/local-broker-client.js";
import { validateJsonSchema } from "../src/schema-validate.js";

test("local_run_command schema permits logical ssh but still blocks scp, sftp, shells, and privilege escalation", () => {
  assert.doesNotThrow(() => validateJsonSchema({ argv: ["ssh", "10.0.0.8", "uptime"], cwd: "/tmp" }, localRunCommandInputSchema));
  for (const argv of [
    ["scp", "a", "b"], ["sftp", "host"], ["sudo", "true"], ["sh", "-c", "echo bad"], ["bash", "-c", "echo bad"],
  ]) {
    assert.throws(() => validateJsonSchema({ argv, cwd: "/tmp" }, localRunCommandInputSchema), /does not match|required|pattern/i, argv[0]);
  }
});
