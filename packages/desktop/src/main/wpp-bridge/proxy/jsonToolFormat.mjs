import { parseToolArguments } from "./toolArguments.mjs";

// Render an OpenAI tool_call back into the JSON protocol the GPT/"o1-code-builder" agent emits,
// so prior tool calls replayed into the transcript match the format the model is asked to produce
// (see TOOL_CALL_SYSTEM_REMINDER_JSON). The proxy parses this same shape back out in
// toolCallNormalizer.mjs, keeping the call id so a replayed call keeps its identity.
//
// Mirrors anthropicToolFormat.mjs's formatAnthropicToolCall, but for JSON instead of XML.
export function formatJsonToolCall(toolCall) {
  const fn = toolCall?.function || toolCall;
  const name = fn?.name || "unknown";
  const id = toolCall?.id || fn?.id || "";
  const args = parseToolArguments(fn?.arguments);

  return JSON.stringify(id ? { type: "tool_call", id, tool: name, args } : { type: "tool_call", tool: name, args });
}
