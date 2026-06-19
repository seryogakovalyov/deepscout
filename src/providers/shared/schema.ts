import { z, ZodFirstPartyTypeKind, type ZodTypeAny } from "zod";

export type JsonSchema = {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: string[];
  format?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  default?: unknown;
};

type FieldMap = Record<string, ZodTypeAny>;

type UnwrappedSchema = {
  schema: ZodTypeAny;
  required: boolean;
  defaultValue?: unknown;
};

function unwrapSchema(schema: ZodTypeAny): UnwrappedSchema {
  const def = schema._def;
  if (def.typeName === ZodFirstPartyTypeKind.ZodDefault) {
    return {
      schema: def.innerType,
      required: false,
      defaultValue: typeof def.defaultValue === "function" ? def.defaultValue() : def.defaultValue,
    };
  }
  if (def.typeName === ZodFirstPartyTypeKind.ZodOptional) {
    return { schema: def.innerType, required: false };
  }
  return { schema, required: true };
}

function numberCheckToJsonSchema(schema: JsonSchema, check: { kind: string; value?: number; inclusive?: boolean }): void {
  if (typeof check.value !== "number") return;
  if (check.kind === "min") {
    if (check.inclusive === false) schema.exclusiveMinimum = check.value;
    else schema.minimum = check.value;
  }
  if (check.kind === "max") {
    if (check.inclusive === false) schema.exclusiveMaximum = check.value;
    else schema.maximum = check.value;
  }
  if (check.kind === "multipleOf") {
    schema.multipleOf = check.value;
  }
}

function zodToJsonSchema(schema: ZodTypeAny): JsonSchema {
  const { schema: unwrapped, defaultValue } = unwrapSchema(schema);
  const def = unwrapped._def;
  const description = unwrapped.description;
  let output: JsonSchema;

  switch (def.typeName) {
    case ZodFirstPartyTypeKind.ZodString:
      output = { type: "string" };
      for (const check of def.checks as Array<{ kind: string; value?: number }>) {
        if (check.kind === "url") output.format = "uri";
        if (check.kind === "min" && typeof check.value === "number") output.minLength = check.value;
        if (check.kind === "max" && typeof check.value === "number") output.maxLength = check.value;
      }
      break;

    case ZodFirstPartyTypeKind.ZodNumber:
      output = { type: "number" };
      for (const check of def.checks as Array<{ kind: string; value?: number; inclusive?: boolean }>) {
        if (check.kind === "int") output.type = "integer";
        else numberCheckToJsonSchema(output, check);
      }
      break;

    case ZodFirstPartyTypeKind.ZodArray:
      output = {
        type: "array",
        items: zodToJsonSchema(def.type),
      };
      if (def.minLength?.value !== undefined) output.minItems = def.minLength.value;
      if (def.maxLength?.value !== undefined) output.maxItems = def.maxLength.value;
      break;

    case ZodFirstPartyTypeKind.ZodEnum:
      output = {
        type: "string",
        enum: [...def.values],
      };
      break;

    default:
      output = {};
      break;
  }

  if (description) output.description = description;
  if (defaultValue !== undefined) output.default = defaultValue;
  return output;
}

export function zodFieldMapToJsonSchema(fields: FieldMap): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const [name, schema] of Object.entries(fields)) {
    const unwrapped = unwrapSchema(schema);
    properties[name] = zodToJsonSchema(schema);
    if (unwrapped.required) required.push(name);
  }

  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

export function parseFieldMap<T extends FieldMap>(fields: T, args: unknown): Record<string, unknown> {
  const input = args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
  const parsed: Record<string, unknown> = {};

  for (const [name, schema] of Object.entries(fields)) {
    parsed[name] = schema.parse(input[name]);
  }

  return parsed;
}

export function parseJsonArguments(args: unknown): unknown {
  if (typeof args !== "string") return args;
  const trimmed = args.trim();
  if (!trimmed) return {};
  return JSON.parse(trimmed);
}

export function isZodType(value: unknown): value is z.ZodTypeAny {
  return Boolean(value && typeof value === "object" && "parse" in value);
}
