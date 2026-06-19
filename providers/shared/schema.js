"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.zodFieldMapToJsonSchema = zodFieldMapToJsonSchema;
exports.parseFieldMap = parseFieldMap;
exports.parseJsonArguments = parseJsonArguments;
exports.isZodType = isZodType;
const zod_1 = require("zod");
function unwrapSchema(schema) {
    const def = schema._def;
    if (def.typeName === zod_1.ZodFirstPartyTypeKind.ZodDefault) {
        return {
            schema: def.innerType,
            required: false,
            defaultValue: typeof def.defaultValue === "function" ? def.defaultValue() : def.defaultValue,
        };
    }
    if (def.typeName === zod_1.ZodFirstPartyTypeKind.ZodOptional) {
        return { schema: def.innerType, required: false };
    }
    return { schema, required: true };
}
function numberCheckToJsonSchema(schema, check) {
    if (typeof check.value !== "number")
        return;
    if (check.kind === "min") {
        if (check.inclusive === false)
            schema.exclusiveMinimum = check.value;
        else
            schema.minimum = check.value;
    }
    if (check.kind === "max") {
        if (check.inclusive === false)
            schema.exclusiveMaximum = check.value;
        else
            schema.maximum = check.value;
    }
    if (check.kind === "multipleOf") {
        schema.multipleOf = check.value;
    }
}
function zodToJsonSchema(schema) {
    const { schema: unwrapped, defaultValue } = unwrapSchema(schema);
    const def = unwrapped._def;
    const description = unwrapped.description;
    let output;
    switch (def.typeName) {
        case zod_1.ZodFirstPartyTypeKind.ZodString:
            output = { type: "string" };
            for (const check of def.checks) {
                if (check.kind === "url")
                    output.format = "uri";
                if (check.kind === "min" && typeof check.value === "number")
                    output.minLength = check.value;
                if (check.kind === "max" && typeof check.value === "number")
                    output.maxLength = check.value;
            }
            break;
        case zod_1.ZodFirstPartyTypeKind.ZodNumber:
            output = { type: "number" };
            for (const check of def.checks) {
                if (check.kind === "int")
                    output.type = "integer";
                else
                    numberCheckToJsonSchema(output, check);
            }
            break;
        case zod_1.ZodFirstPartyTypeKind.ZodArray:
            output = {
                type: "array",
                items: zodToJsonSchema(def.type),
            };
            if (def.minLength?.value !== undefined)
                output.minItems = def.minLength.value;
            if (def.maxLength?.value !== undefined)
                output.maxItems = def.maxLength.value;
            break;
        case zod_1.ZodFirstPartyTypeKind.ZodEnum:
            output = {
                type: "string",
                enum: [...def.values],
            };
            break;
        default:
            output = {};
            break;
    }
    if (description)
        output.description = description;
    if (defaultValue !== undefined)
        output.default = defaultValue;
    return output;
}
function zodFieldMapToJsonSchema(fields) {
    const properties = {};
    const required = [];
    for (const [name, schema] of Object.entries(fields)) {
        const unwrapped = unwrapSchema(schema);
        properties[name] = zodToJsonSchema(schema);
        if (unwrapped.required)
            required.push(name);
    }
    return {
        type: "object",
        properties,
        required,
        additionalProperties: false,
    };
}
function parseFieldMap(fields, args) {
    const input = args && typeof args === "object" && !Array.isArray(args) ? args : {};
    const parsed = {};
    for (const [name, schema] of Object.entries(fields)) {
        parsed[name] = schema.parse(input[name]);
    }
    return parsed;
}
function parseJsonArguments(args) {
    if (typeof args !== "string")
        return args;
    const trimmed = args.trim();
    if (!trimmed)
        return {};
    return JSON.parse(trimmed);
}
function isZodType(value) {
    return Boolean(value && typeof value === "object" && "parse" in value);
}
