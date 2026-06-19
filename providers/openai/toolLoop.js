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
async function runToolLoop(options) {
    const maxIterations = options.maxIterations ?? 10;
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
            const result = await options.executeToolCall(toolCall, {
                config: options.config,
                signal: options.signal,
                status: options.status,
            });
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
