import test from "node:test";
import assert from "node:assert/strict";
import { validateJsonSchema } from "../src/schema-validate.js";

test("validator enforces required and additionalProperties", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["name"],
    properties: {
      name: { type: "string", minLength: 1 },
    },
  };
  assert.deepEqual(validateJsonSchema({ name: "ok" }, schema), { name: "ok" });
  assert.throws(() => validateJsonSchema({}, schema), /missing required property name/);
  assert.throws(() => validateJsonSchema({ name: "ok", extra: true }, schema), /unexpected property extra/);
});

test("validator supports array bounds and nested item schemas", () => {
  const schema = {
    type: "array",
    minItems: 1,
    maxItems: 2,
    items: { type: "integer", minimum: 0, maximum: 10 },
  };
  assert.deepEqual(validateJsonSchema([0, 10], schema), [0, 10]);
  assert.throws(() => validateJsonSchema([], schema), /minimum item count/);
  assert.throws(() => validateJsonSchema([11], schema), /maximum value/);
});

test("validator supports oneOf with const discriminators", () => {
  const schema = {
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["type", "value"],
        properties: { type: { const: "a" }, value: { type: "string" } },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["type", "value"],
        properties: { type: { const: "b" }, value: { type: "integer" } },
      },
    ],
  };
  assert.deepEqual(validateJsonSchema({ type: "a", value: "x" }, schema), { type: "a", value: "x" });
  assert.throws(() => validateJsonSchema({ type: "a", value: 1 }, schema), /did not match any oneOf/);
});

test("validator handles schema-valued additionalProperties", () => {
  const schema = {
    type: "object",
    additionalProperties: { type: "string" },
  };
  assert.deepEqual(validateJsonSchema({ CI: "1" }, schema), { CI: "1" });
  assert.throws(() => validateJsonSchema({ CI: true }, schema), /expected string/);
});

test("validator enforces object property-count bounds", () => {
  const schema = {
    type: "object",
    minProperties: 1,
    maxProperties: 2,
    additionalProperties: { type: "string" },
  };
  assert.deepEqual(validateJsonSchema({ A: "1", B: "2" }, schema), { A: "1", B: "2" });
  assert.throws(() => validateJsonSchema({}, schema), /minimum property count/);
  assert.throws(
    () => validateJsonSchema({ A: "1", B: "2", C: "3" }, schema),
    /maximum property count/,
  );
});
