"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.exportTools = exportTools;
exports.executeToolCall = executeToolCall;
const definitions_1 = require("../../tools/definitions");
const handlers_1 = require("../../tools/handlers");
const runtimeConfig_1 = require("../shared/runtimeConfig");
const schema_1 = require("../shared/schema");
function getToolCallName(call) {
    return "function" in call ? call.function.name : call.name;
}
function getToolCallArguments(call) {
    return "function" in call ? call.function.arguments : call.arguments;
}
function isToolName(name) {
    return name in definitions_1.toolDefinitions;
}
function toolError(name, error) {
    return JSON.stringify({
        tool_error: true,
        tool: name,
        error,
        hint: "Read the error above, adjust the parameters if needed, and retry.",
    }, null, 2);
}
function exportTools() {
    return definitions_1.toolDefinitionList.map((definition) => ({
        type: "function",
        function: {
            name: definition.name,
            description: definition.description,
            parameters: (0, schema_1.zodFieldMapToJsonSchema)(definition.parameters),
        },
    }));
}
async function executeToolCall(call, options = {}) {
    const name = getToolCallName(call);
    if (!isToolName(name)) {
        return toolError(name, `Unknown tool: ${name}`);
    }
    const controller = options.signal ? undefined : new AbortController();
    const signal = options.signal ?? controller?.signal;
    if (!signal)
        return toolError(name, "No AbortSignal available");
    if (signal.aborted) {
        return JSON.stringify({ tool_error: true, tool: name, error: "cancelled" });
    }
    try {
        const definition = definitions_1.toolDefinitions[name];
        const parsedArgs = (0, schema_1.parseFieldMap)(definition.parameters, (0, schema_1.parseJsonArguments)(getToolCallArguments(call)));
        const config = (0, runtimeConfig_1.createRuntimeConfig)(options.config);
        const handlers = (0, handlers_1.createToolHandlers)(config);
        const handler = handlers[name];
        return await handler(parsedArgs, {
            signal,
            status: options.status ?? (() => undefined),
        });
    }
    catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
            return JSON.stringify({ tool_error: true, tool: name, error: "cancelled" });
        }
        const msg = err instanceof Error ? err.message : String(err);
        return toolError(name, msg);
    }
}
