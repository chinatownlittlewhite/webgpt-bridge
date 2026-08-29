import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const serverSource = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

test("MCP server registration derives annotations from runtime registry descriptors", () => {
  assert.equal(serverSource.includes("function toolAnnotations("), false);
  assert.match(serverSource, /createRuntimeToolRegistry/);
  assert.match(serverSource, /descriptor\.mcpAnnotations/);
  assert.match(serverSource, /descriptor\.name/);
  assert.match(serverSource, /descriptor\.description/);
  assert.match(serverSource, /descriptor\.inputSchema/);
});
