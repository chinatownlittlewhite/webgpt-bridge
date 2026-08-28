const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const modulePath = path.join(__dirname, "..", "src", "dev-runtime-config.cjs");

function resolve(input) {
  assert.ok(fs.existsSync(modulePath), "development runtime config helper must exist");
  const { resolveDevelopmentRuntimeConfig } = require(modulePath);
  return resolveDevelopmentRuntimeConfig(input);
}

test("packaged runtime ignores every development isolation override", () => {
  assert.deepEqual(resolve({
    isPackaged: true,
    env: {
      WEBGPT_DEV_USER_DATA_DIR: "relative/ignored",
      WEBGPT_DEV_MCP_PORT: "not-a-port",
      WEBGPT_DEV_TUNNEL_HEALTH_PORT: "70000",
    },
    defaultUserDataPath: "/Users/example/Library/Application Support/local-agent-host",
  }), {
    userDataPath: "/Users/example/Library/Application Support/local-agent-host",
    mcpPort: 8787,
    tunnelHealthPort: 8080,
  });
});

test("development runtime accepts an absolute isolated userData directory and bounded port overrides", () => {
  assert.deepEqual(resolve({
    isPackaged: false,
    env: {
      WEBGPT_DEV_USER_DATA_DIR: "/tmp/webgpt-bridge-dev-smoke",
      WEBGPT_DEV_MCP_PORT: "18787",
      WEBGPT_DEV_TUNNEL_HEALTH_PORT: "18080",
    },
    defaultUserDataPath: "/Users/example/Library/Application Support/local-agent-host",
  }), {
    userDataPath: "/tmp/webgpt-bridge-dev-smoke",
    mcpPort: 18787,
    tunnelHealthPort: 18080,
  });
});

test("development runtime fails closed on relative userData or invalid ports", () => {
  assert.throws(() => resolve({
    isPackaged: false,
    env: { WEBGPT_DEV_USER_DATA_DIR: "relative/path" },
    defaultUserDataPath: "/default",
  }), /WEBGPT_DEV_USER_DATA_DIR.*absolute/i);

  for (const [key, value] of [
    ["WEBGPT_DEV_MCP_PORT", "0"],
    ["WEBGPT_DEV_MCP_PORT", "65536"],
    ["WEBGPT_DEV_MCP_PORT", "12.5"],
    ["WEBGPT_DEV_TUNNEL_HEALTH_PORT", "abc"],
  ]) {
    assert.throws(() => resolve({
      isPackaged: false,
      env: { [key]: value },
      defaultUserDataPath: "/default",
    }), new RegExp(`${key}.*1.*65535`, "i"));
  }
});
