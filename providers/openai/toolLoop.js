"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runToolLoop = runToolLoop;
function parseArguments(args) {
    if (!args?.trim())
        return {};
    try {
        return JSON.parse(args);
    }
    catch {
        return args;
    }
}
function toolCallSignature(toolCall) {
    return JSON.stringify({
        name: toolCall.function.name,
        arguments: parseArguments(toolCall.function.arguments),
    });
}
const SEARCH_TOOL_NAMES = new Set([
    "search",
    "search_recent",
    "search_news",
    "deep_search",
    "research_topic",
    "fact_check",
    "verify_statistic",
    "find_primary_source",
    "find_expert_views",
    "search_academic",
    "compare_sources",
    "check_source",
]);
function isSearchToolCall(toolCall) {
    return SEARCH_TOOL_NAMES.has(toolCall.function.name);
}
function deniedToolResult(toolName, reason) {
    return JSON.stringify({
        tool_error: true,
        tool: toolName,
        error: reason,
        hint: "Use the successful tool results already returned in this turn, then decide whether another search is still needed in the next iteration.",
    }, null, 2);
}
async function runToolLoop(options) {
    const maxIterations = options.maxIterations ?? 10;
    const maxSearchToolCallsPerTurn = options.maxSearchToolCallsPerTurn ?? 1;
    const messages = [...options.messages];
    const calledTools = [];
    const toolResults = [];
    const seenToolCalls = new Set();
    let iterationsUsed = 0;
    let finalAssistantResponse = null;
    let completedNormally = false;
    let abortedReason = "";
    for (let iteration = 1; iteration <= maxIterations; iteration++) {
        iterationsUsed = iteration;
        const assistantMessage = await options.chat(messages, options.tools);
        options.onEvent?.({ type: "assistant_message", iteration, message: assistantMessage });
        messages.push(assistantMessage);
        const toolCalls = assistantMessage.tool_calls ?? [];
        if (toolCalls.length === 0) {
            finalAssistantResponse = assistantMessage;
            completedNormally = true;
            break;
        }
        let searchToolCallsThisTurn = 0;
        for (const toolCall of toolCalls) {
            const signature = toolCallSignature(toolCall);
            if (seenToolCalls.has(signature)) {
                abortedReason = `repeated identical tool call detected: ${signature}`;
                break;
            }
            seenToolCalls.add(signature);
            calledTools.push(toolCall.function.name);
            options.onEvent?.({
                type: "tool_call",
                iteration,
                toolCall,
                parsedArguments: parseArguments(toolCall.function.arguments),
            });
            const searchToolCall = isSearchToolCall(toolCall);
            if (searchToolCall)
                searchToolCallsThisTurn += 1;
            const deniedReason = searchToolCall && searchToolCallsThisTurn > maxSearchToolCallsPerTurn
                ? `too many search/research tool calls in one assistant turn (${searchToolCallsThisTurn}); limit is ${maxSearchToolCallsPerTurn}`
                : "";
            const result = deniedReason
                ? deniedToolResult(toolCall.function.name, deniedReason)
                : await options.executeToolCall(toolCall, {
                    config: options.config,
                    signal: options.signal,
                    status: options.status,
                });
            if (deniedReason) {
                options.onEvent?.({ type: "tool_denied", iteration, toolCall, reason: deniedReason });
            }
            toolResults.push({ toolCall, result });
            options.onEvent?.({ type: "tool_result", iteration, toolCall, result });
            messages.push({
                role: "tool",
                tool_call_id: toolCall.id,
                content: result,
            });
        }
        if (abortedReason)
            break;
    }
    if (!completedNormally && !abortedReason && iterationsUsed >= maxIterations) {
        abortedReason = `max_iterations reached (${maxIterations})`;
    }
    return {
        messages,
        calledTools,
        iterationsUsed,
        toolResults,
        finalAssistantResponse,
        completedNormally,
        abortedReason,
    };
}
