import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharedRegistry = require("../../shared/tool-registry.cjs");

export const TOOL_REGISTRY_VERSION = sharedRegistry.TOOL_REGISTRY_VERSION;
export const listToolMetadata = sharedRegistry.listToolMetadata;
export const listToolNames = sharedRegistry.listToolNames;
export const listGoalToolNames = sharedRegistry.listGoalToolNames;
export const listBrokerToolNames = sharedRegistry.listBrokerToolNames;
export const getToolMetadata = sharedRegistry.getToolMetadata;
export const getBrokerMethodMetadata = sharedRegistry.getBrokerMethodMetadata;
export const findBrokerMethodByImplementation = sharedRegistry.findBrokerMethodByImplementation;
export const getMcpAnnotations = sharedRegistry.getMcpAnnotations;

function inferBrokerEnabled(tools, explicit) {
  if (typeof explicit === "boolean") return explicit;
  return (tools ?? []).some((tool) => sharedRegistry.getToolMetadata(tool?.name)?.availability === "broker");
}

function validateRuntimeTool(tool) {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) throw new TypeError("runtime tool must be an object");
  if (typeof tool.name !== "string" || tool.name.length === 0) throw new TypeError("runtime tool requires a canonical name");
  const metadata = sharedRegistry.getToolMetadata(tool.name);
  if (!metadata) throw new Error(`runtime tool is not present in the canonical registry: ${tool.name}`);
  if (typeof tool.description !== "string" || tool.description.length === 0) throw new TypeError(`runtime tool ${tool.name} requires a description`);
  if (!tool.inputSchema || typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema)) throw new TypeError(`runtime tool ${tool.name} requires an input schema`);
  if (typeof tool.invoke !== "function") throw new TypeError(`runtime tool ${tool.name} requires invoke()`);
  return metadata;
}

export function createRuntimeToolRegistry(tools = [], { requireComplete = false, brokerEnabled } = {}) {
  if (!Array.isArray(tools)) throw new TypeError("runtime tools must be an array");
  const enabled = inferBrokerEnabled(tools, brokerEnabled);
  const seen = new Set();
  const descriptorsByName = new Map();
  for (const tool of tools) {
    const metadata = validateRuntimeTool(tool);
    if (seen.has(tool.name)) throw new Error(`duplicate runtime tool: ${tool.name}`);
    seen.add(tool.name);
    if (metadata.availability === "broker" && !enabled) {
      throw new Error(`broker runtime tool requires brokerEnabled: ${tool.name}`);
    }
    descriptorsByName.set(tool.name, Object.freeze({
      ...metadata,
      description: tool.description,
      inputSchema: tool.inputSchema,
      invoke: tool.invoke,
      ...(Number.isFinite(tool.timeoutMs) ? { timeoutMs: tool.timeoutMs } : {}),
      tool,
    }));
  }

  const canonicalMetadata = sharedRegistry.listToolMetadata({ brokerEnabled: enabled });
  const descriptors = canonicalMetadata
    .filter((metadata) => descriptorsByName.has(metadata.name))
    .map((metadata) => descriptorsByName.get(metadata.name));

  if (requireComplete) {
    const expected = canonicalMetadata.map((metadata) => metadata.name);
    const actual = descriptors.map((descriptor) => descriptor.name);
    if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
      const missing = expected.filter((name) => !seen.has(name));
      const extra = [...seen].filter((name) => !expected.includes(name));
      throw new Error(`runtime tool registry is incomplete or drifted; missing=[${missing.join(",")}] extra=[${extra.join(",")}]`);
    }
  }

  return Object.freeze(descriptors);
}

export function orderRuntimeTools(tools = [], options = {}) {
  return createRuntimeToolRegistry(tools, options).map((descriptor) => descriptor.tool);
}

export function goalEligibleRuntimeTools(tools = [], options = {}) {
  return createRuntimeToolRegistry(tools, options)
    .filter((descriptor) => descriptor.goalEligible)
    .map((descriptor) => descriptor.tool);
}
