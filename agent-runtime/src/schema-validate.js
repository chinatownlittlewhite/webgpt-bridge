function fail(path, message) {
  throw new TypeError(`${path}: ${message}`);
}

function sameValue(a, b) {
  return Object.is(a, b);
}

function validateType(value, type, path) {
  switch (type) {
    case "object":
      if (value === null || typeof value !== "object" || Array.isArray(value)) fail(path, "expected object");
      break;
    case "array":
      if (!Array.isArray(value)) fail(path, "expected array");
      break;
    case "string":
      if (typeof value !== "string") fail(path, "expected string");
      break;
    case "integer":
      if (!Number.isInteger(value)) fail(path, "expected integer");
      break;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "expected finite number");
      break;
    case "boolean":
      if (typeof value !== "boolean") fail(path, "expected boolean");
      break;
    case "null":
      if (value !== null) fail(path, "expected null");
      break;
    default:
      fail(path, `unsupported schema type ${String(type)}`);
  }
}

export function validateJsonSchema(value, schema, path = "$") {
  if (!schema || typeof schema !== "object") return value;

  if (Array.isArray(schema.oneOf)) {
    let matches = 0;
    let lastError = null;
    for (const candidate of schema.oneOf) {
      try {
        validateJsonSchema(value, candidate, path);
        matches += 1;
      } catch (error) {
        lastError = error;
      }
    }
    if (matches !== 1) {
      fail(path, matches === 0 ? `did not match any oneOf schema (${lastError?.message ?? "no match"})` : "matched multiple oneOf schemas");
    }
    return value;
  }

  if (Object.hasOwn(schema, "const") && !sameValue(value, schema.const)) {
    fail(path, `must equal ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => sameValue(value, entry))) {
    fail(path, `must be one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(", ")}`);
  }

  if (schema.type) validateType(value, schema.type, path);

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) fail(path, `minimum length is ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) fail(path, `maximum length is ${schema.maxLength}`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) fail(path, "does not match required pattern");
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) fail(path, `minimum value is ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) fail(path, `maximum value is ${schema.maximum}`);
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) fail(path, `minimum item count is ${schema.minItems}`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(path, `maximum item count is ${schema.maxItems}`);
    if (schema.items) {
      value.forEach((entry, index) => validateJsonSchema(entry, schema.items, `${path}[${index}]`));
    }
    if (Array.isArray(schema.prefixItems)) {
      schema.prefixItems.forEach((entry, index) => {
        if (index < value.length) validateJsonSchema(value[index], entry, `${path}[${index}]`);
      });
    }
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const entryCount = Object.keys(value).length;
    if (schema.minProperties !== undefined && entryCount < schema.minProperties) {
      fail(path, `minimum property count is ${schema.minProperties}`);
    }
    if (schema.maxProperties !== undefined && entryCount > schema.maxProperties) {
      fail(path, `maximum property count is ${schema.maxProperties}`);
    }
    const properties = schema.properties ?? {};
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) fail(path, `missing required property ${required}`);
    }
    for (const [key, entry] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        validateJsonSchema(entry, properties[key], `${path}.${key}`);
      } else if (schema.additionalProperties === false) {
        fail(path, `unexpected property ${key}`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        validateJsonSchema(entry, schema.additionalProperties, `${path}.${key}`);
      }
    }
  }

  return value;
}
