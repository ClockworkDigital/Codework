import { handleChatCompletions } from "./openaiCompat.mjs"
import { streamChunkBase } from "./streamAdapter.mjs"

// Both HTTP formats share prompt admission, worker affinity, recovery and stream quarantine.
export function handleResponses(request, response, body, options = {}) {
  return handleChatCompletions(request, response, chatRequest(body), { ...options, adapter: Responses })
}

function invalid(message) {
  return Object.assign(new Error(message), { statusCode: 400, type: "invalid_request_error" })
}

function chatRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid("Expected a Responses request object.")
  if (body.instructions !== undefined && typeof body.instructions !== "string")
    throw invalid("instructions must be text.")
  if (body.stream !== undefined && typeof body.stream !== "boolean") throw invalid("stream must be a boolean.")
  if (body.previous_response_id || body.conversation)
    throw invalid("Send complete input history; server-side Responses storage is unavailable.")
  if (body.background) throw invalid("Background Responses are unavailable.")
  const input = typeof body.input === "string" ? [{ role: "user", content: body.input }] : body.input
  if (!Array.isArray(input)) throw invalid("input must be a string or an array of input items.")
  if (body.tools !== undefined && !Array.isArray(body.tools)) throw invalid("tools must be an array.")
  const messages = []
  if (body.instructions) messages.push({ role: "system", content: body.instructions })
  for (const item of input) {
    if (!item || typeof item !== "object") throw invalid("Invalid Responses input item.")
    if (item.type === "reasoning") continue
    if (item.type === "image_generation_call") {
      // The WPP thread retains its generated assets. On a fresh replay, include owned bytes when supplied.
      if (item.result)
        messages.push({
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: `data:image/${item.output_format ?? "png"};base64,${item.result}` },
            },
          ],
        })
      continue
    }
    if (item.type === "function_call") {
      if (typeof item.call_id !== "string" || typeof item.name !== "string" || typeof item.arguments !== "string")
        throw invalid("Invalid function_call input.")
      const call = { id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments } }
      const previous = messages.at(-1)
      if (previous?.role === "assistant") (previous.tool_calls ??= []).push(call)
      else messages.push({ role: "assistant", content: null, tool_calls: [call] })
      continue
    }
    if (item.type === "function_call_output") {
      if (typeof item.call_id !== "string") throw invalid("Invalid function_call_output input.")
      messages.push({ role: "tool", tool_call_id: item.call_id, content: content(item.output) })
      continue
    }
    if (item.type && item.type !== "message") throw invalid(`Unsupported Responses input item: ${item.type}`)
    if (!["user", "assistant", "system", "developer"].includes(item.role)) throw invalid("Invalid message role.")
    messages.push({ role: item.role === "developer" ? "system" : item.role, content: content(item.content) })
  }
  return {
    ...body,
    messages,
    tools: (body.tools ?? []).flatMap((tool) => {
      if (!tool || typeof tool !== "object") throw invalid("Invalid tool definition.")
      if (tool.type === "image_generation") return []
      if (tool.type !== "function" || typeof tool.name !== "string")
        throw invalid("Only function and image_generation tools are supported.")
      return [
        {
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            strict: tool.strict,
          },
        },
      ]
    }),
    tool_choice:
      body.tool_choice?.type === "function"
        ? { type: "function", function: { name: body.tool_choice.name } }
        : body.tool_choice?.type === "image_generation"
          ? "auto"
          : body.tool_choice,
    ...(body.reasoning?.effort === undefined ? {} : { reasoning_effort: body.reasoning.effort }),
    max_tokens: body.max_output_tokens,
  }
}

function content(value) {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) throw invalid("Message content must be text or an array of content parts.")
  const parts = value.map((part) => {
    if (!part || typeof part !== "object") throw invalid("Invalid message content part.")
    if (["input_text", "output_text"].includes(part.type) && typeof part.text === "string")
      return { type: "text", text: part.text }
    if (part.type === "refusal" && typeof part.refusal === "string") return { type: "text", text: part.refusal }
    if (part.type === "input_image" && typeof part.image_url === "string")
      return { type: "image_url", image_url: { url: part.image_url, detail: part.detail } }
    throw invalid(`Unsupported Responses content part: ${part.type}`)
  })
  return parts.every((part) => part.type === "text") ? parts.map((part) => part.text).join("\n") : parts
}

function outputItems(id, message) {
  return [
    ...(message.content
      ? [
          {
            id: `${id}_message`,
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: message.content, annotations: [] }],
          },
        ]
      : []),
    ...(message.tool_calls ?? []).map((call) => ({
      id: `${id}_${call.id}`,
      type: "function_call",
      call_id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
      status: "completed",
    })),
    ...(message.images ?? []).map((image, index) => ({
      id: `${id}_image_${index}`,
      type: "image_generation_call",
      status: "completed",
      result: image.data,
      output_format: image.mime.slice("image/".length),
    })),
  ]
}

function createChatCompletionResponse({ id, model, created, message, finishReason, usage }) {
  return {
    id,
    object: "response",
    created_at: created,
    model,
    status: finishReason === "length" ? "incomplete" : "completed",
    error: null,
    incomplete_details: finishReason === "length" ? { reason: "max_output_tokens" } : null,
    output: outputItems(id, message),
    usage: {
      input_tokens: usage?.prompt_tokens ?? 0,
      output_tokens: usage?.completion_tokens ?? 0,
      total_tokens: usage?.total_tokens ?? 0,
      input_tokens_details: { cached_tokens: usage?.prompt_tokens_details?.cached_tokens ?? 0 },
      output_tokens_details: { reasoning_tokens: usage?.completion_tokens_details?.reasoning_tokens ?? 0 },
    },
  }
}

const streams = new WeakMap()

function emit(response, type, fields = {}) {
  const state = streams.get(response)
  response.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: state.sequence++, ...fields })}\n\n`)
}

function openChatCompletionStream(response, base) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  })
  streams.set(response, { sequence: 0, text: "", output: [], base })
  const initial = { ...createChatCompletionResponse({ ...base, message: {} }), status: "in_progress", usage: null }
  emit(response, "response.created", { response: initial })
  emit(response, "response.in_progress", { response: initial })
}

function writeContentDelta(response, base, text) {
  if (!text) return
  const state = streams.get(response)
  if (!state.message) {
    state.message = { id: `${base.id}_message`, type: "message", role: "assistant", status: "in_progress", content: [] }
    state.messageIndex = state.output.length
    state.output.push(state.message)
    emit(response, "response.output_item.added", { output_index: state.messageIndex, item: state.message })
    emit(response, "response.content_part.added", {
      item_id: state.message.id,
      output_index: state.messageIndex,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    })
  }
  state.text += text
  emit(response, "response.output_text.delta", {
    item_id: state.message.id,
    output_index: state.messageIndex,
    content_index: 0,
    delta: text,
  })
}

function writeContentBody(response, base, text) {
  writeContentDelta(response, base, text)
}

function writeToolCallChunks(response, base, tool_calls) {
  for (const item of outputItems(base.id, { tool_calls })) {
    const state = streams.get(response)
    const output_index = state.output.length
    state.output.push(item)
    emit(response, "response.output_item.added", {
      output_index,
      item: { ...item, arguments: "", status: "in_progress" },
    })
    emit(response, "response.function_call_arguments.delta", { item_id: item.id, output_index, delta: item.arguments })
    emit(response, "response.function_call_arguments.done", {
      item_id: item.id,
      output_index,
      arguments: item.arguments,
    })
    emit(response, "response.output_item.done", { output_index, item })
  }
}

function finishChatCompletion(response, base, options) {
  const state = streams.get(response)
  if (state.message) {
    const part = { type: "output_text", text: state.text, annotations: [] }
    const fields = { item_id: state.message.id, output_index: state.messageIndex, content_index: 0 }
    state.message.status = "completed"
    state.message.content = [part]
    emit(response, "response.output_text.done", { ...fields, text: state.text })
    emit(response, "response.content_part.done", { ...fields, part })
    emit(response, "response.output_item.done", { output_index: state.messageIndex, item: state.message })
  }
  for (const item of outputItems(base.id, { images: options.images })) {
    const output_index = state.output.length
    state.output.push(item)
    emit(response, "response.output_item.added", {
      output_index,
      item: { ...item, status: "in_progress", result: null },
    })
    emit(response, "response.output_item.done", { output_index, item })
  }
  const result = createChatCompletionResponse({ ...base, message: {}, ...options })
  emit(response, result.status === "incomplete" ? "response.incomplete" : "response.completed", {
    response: { ...result, output: state.output },
  })
  streams.delete(response)
  response.end()
}

function writeChatCompletionBody(response, options) {
  writeContentBody(response, options, options.content)
  if (options.tool_calls?.length) writeToolCallChunks(response, options, options.tool_calls)
  finishChatCompletion(response, options, options)
}

function writeChatCompletionStream(response, options) {
  openChatCompletionStream(response, options)
  writeChatCompletionBody(response, options)
}

function writeChatCompletionError(response, error) {
  const state = streams.get(response)
  emit(response, "response.failed", {
    response: {
      ...createChatCompletionResponse({ ...state.base, message: {} }),
      status: "failed",
      output: state.output,
      error: { code: error.type ?? "o1_code_proxy_error", message: error.message },
    },
  })
  streams.delete(response)
  response.end()
}

const Responses = {
  idPrefix: "resp",
  replayImages: true,
  createChatCompletionResponse,
  openChatCompletionStream,
  writeChatCompletionBody,
  writeChatCompletionError,
  writeChatCompletionStream,
  streamChunkBase,
  writeContentDelta,
  writeContentBody,
  writeToolCallChunks,
  finishChatCompletion,
}
