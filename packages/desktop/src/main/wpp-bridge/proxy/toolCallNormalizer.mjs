import { looksLikeIncompleteAnthropicToolCall } from "./anthropicToolFormat.mjs";

// Turns model text into OpenAI tool_calls. Only the two transport protocols count, and only outside
// Markdown code: fenced blocks and inline code hold examples, so they never run.
// - XML: a function_calls wrapper holding invoke elements with parameter values.
// - JSON: an object whose type is "tool_call", with tool and args fields.
// Pass the request's tools as options.tools. XML values are then typed by each tool's schema, and a
// JSON call must name a listed tool, so JSON that only appears in an answer stays prose.
export function chooseAssistantResponse(finalText, toolCallParts, alternateAssistantTexts = [], options = {}) {
  const fromText = attemptNormalize(finalText, options);

  if (fromText.response?.finish_reason === "tool_calls" && fromText.response.tool_calls?.length) {
    return fromText.response;
  }

  const fromParts = normalizeFromToolCallParts(toolCallParts);

  if (fromParts?.tool_calls?.length) {
    return withPreamble(fromParts, finalText, options);
  }

  // A malformed candidate must not hide a later valid one, so each is parsed on its own.
  const fromAlternate = (Array.isArray(alternateAssistantTexts) ? alternateAssistantTexts : [])
    .map((content) => attemptNormalize(content, options).response)
    .find((response) => response?.finish_reason === "tool_calls" && response.tool_calls?.length);

  if (fromAlternate) {
    return withPreamble(fromAlternate, finalText, options);
  }

  if (fromText.error) {
    throw fromText.error;
  }

  return fromText.response;
}

export function normalizeFromToolCallParts(toolCallParts) {
  const parts = Object.values(toolCallParts || {}).filter((part) => part?.name);

  if (parts.length === 0) {
    return null;
  }

  return toolCallResponse(
    null,
    parts.map((part) => ({ id: part.id, name: part.name, arguments: part.arguments || "{}" }))
  );
}

export function normalizeAssistantMessage(content, options = {}) {
  if (typeof content !== "string") {
    return proseResponse(content);
  }

  const schemas = toolSchemas(options.tools);
  const code = markdownCodeRanges(content);

  // A real XML call is emitted bare, so parse from the first marker outside Markdown code. Code
  // fences inside its parameter values come after that marker and stay part of the values.
  const xmlStart = firstUnfencedMarker(content, code);

  if (xmlStart >= 0) {
    const xmlContent = content.slice(xmlStart);
    const xml = parseXmlToolCalls(xmlContent, schemas);

    if (xml.incomplete || (xml.calls.length === 0 && looksLikeIncompleteAnthropicToolCall(xmlContent))) {
      throw incompleteToolCallError();
    }

    if (xml.calls.length > 0) {
      return toolCallResponse(content.slice(0, xmlStart).trimEnd() || null, xml.calls);
    }
  }

  // XML markup is unambiguous, so its unknown names still reach OpenCode, which reports them to the
  // model. JSON is checked against the request's tools because answers often contain JSON.
  const jsonCalls = typedJsonToolCalls(content, code).filter((call) => allowedTool(call.tool, schemas));

  if (jsonCalls.length > 0) {
    return toolCallResponse(
      null,
      dedupeToolCalls(jsonCalls).map((call) => ({ id: call.id, name: call.tool, args: call.args }))
    );
  }

  const whole = parseWholeMessageJson(content);

  if (whole?.type === "final") {
    return proseResponse(whole.message || "");
  }

  const delegated = delegatedSubagentCall(whole);

  if (delegated && allowedTool(delegated.name, schemas)) {
    return toolCallResponse(null, [delegated]);
  }

  return proseResponse(content);
}

export function parseAnthropicXmlToolCalls(content, options = {}) {
  if (typeof content !== "string") {
    return null;
  }

  const calls = parseXmlToolCalls(content, toolSchemas(options.tools)).calls;
  return calls.length > 0 ? calls : null;
}

function attemptNormalize(content, options) {
  try {
    return { response: normalizeAssistantMessage(content, options) };
  } catch (error) {
    return { error };
  }
}

function withPreamble(message, content, options) {
  const text = typeof content === "string" ? content.trimEnd() : "";

  if (!text) {
    return message;
  }

  // Text that is itself a tool call, even a broken one, is not a preamble.
  const parsed = attemptNormalize(text, options);
  return parsed.error || parsed.response.tool_calls?.length ? message : { ...message, content: text };
}

function proseResponse(content) {
  return { content, tool_calls: undefined, finish_reason: "stop" };
}

function toolCallResponse(content, calls) {
  const seen = new Set();

  return {
    content,
    tool_calls: calls.map((call) => {
      const given = call.id == null ? "" : String(call.id);
      // OpenCode keys tool results by id, so a repeated id gets a fresh one instead of colliding.
      const id = given && !seen.has(given) ? given : generatedCallId();
      seen.add(id);
      return {
        id,
        type: "function",
        function: {
          name: call.name,
          arguments: call.arguments ?? JSON.stringify(call.args || {})
        }
      };
    }),
    finish_reason: "tool_calls"
  };
}

function generatedCallId() {
  return `call_${crypto.randomUUID().replace(/-/g, "")}`;
}

function incompleteToolCallError() {
  const error = new Error("The WPP agent returned an incomplete XML tool call.");
  error.statusCode = 502;
  error.type = "o1_code_incomplete_tool_call";
  return error;
}

function toolSchemas(tools) {
  return new Map((Array.isArray(tools) ? tools : []).flatMap((tool) => {
    const fn = tool?.function || tool;
    return typeof fn?.name === "string" ? [[fn.name, fn.parameters?.properties || {}]] : [];
  }));
}

function allowedTool(name, schemas) {
  return schemas.size === 0 || schemas.has(name);
}

// Markdown code that holds examples: fenced blocks (backtick or tilde fences, closed by a matching
// fence or running to the end of the text, as in CommonMark) and inline code on a single line.
// Fences are accepted at any indent so examples nested in list items stay inert too.
function markdownCodeRanges(text) {
  const ranges = [];
  let fence = null;
  let offset = 0;

  for (const line of text.split("\n")) {
    const marker = line.match(/^[ \t]*(`{3,}|~{3,})/);
    const lineEnd = offset + line.length;

    if (fence) {
      const closes = marker
        && marker[1][0] === fence.char
        && marker[1].length >= fence.size
        && !line.slice(marker[0].length).trim();

      if (closes) {
        ranges.push({ start: fence.start, end: lineEnd });
        fence = null;
      }
    } else if (marker && !(marker[1][0] === "`" && line.slice(marker[0].length).includes("`"))) {
      fence = { char: marker[1][0], size: marker[1].length, start: offset };
    } else {
      ranges.push(...inlineCodeRanges(line, offset));
    }

    offset = lineEnd + 1;
  }

  if (fence) {
    ranges.push({ start: fence.start, end: text.length });
  }

  return ranges;
}

function inlineCodeRanges(line, offset) {
  const runs = [...line.matchAll(/`+/g)];
  const ranges = [];

  for (let index = 0; index < runs.length; index += 1) {
    const close = runs.findIndex((run, later) => later > index && run[0].length === runs[index][0].length);

    if (close < 0) {
      continue;
    }

    ranges.push({ start: offset + runs[index].index, end: offset + runs[close].index + runs[close][0].length });
    index = close;
  }

  return ranges;
}

function rangeAt(index, ranges) {
  return ranges.find((range) => index >= range.start && index < range.end);
}

function firstUnfencedMarker(content, code) {
  const marker = /<function_calls\b|<invoke\b/g;
  let match;

  while ((match = marker.exec(content)) !== null) {
    const range = rangeAt(match.index, code);

    if (!range) {
      return match.index;
    }

    marker.lastIndex = Math.max(marker.lastIndex, range.end);
  }

  return -1;
}

function parseXmlToolCalls(content, schemas) {
  const calls = [];
  const open = /<invoke\b([^>]*)>/gi;
  let cursor = 0;
  let match;

  while ((match = open.exec(content)) !== null) {
    const bodyStart = open.lastIndex;
    const close = invokeClose(content, bodyStart);

    if (!close) {
      return { calls, incomplete: true };
    }

    const attributes = parseXmlAttributes(match[1]);
    cursor = close.end;
    open.lastIndex = close.end;

    if (attributes.name) {
      calls.push(normalizeAnthropicInvoke({
        id: attributes.id || "",
        name: attributes.name,
        args: extractInvokeParameters(content.slice(bodyStart, close.start), attributes.name, schemas.get(attributes.name))
      }));
    }
  }

  return { calls, incomplete: calls.length > 0 && truncatedInvokeTail(content.slice(cursor)) };
}

// An invoke ends at the first close tag followed by another invoke, the wrapper's close tag or the
// end of the text. A close tag inside a parameter value is followed by more value text instead.
// Without such a close, the last close tag is used so a call followed by stray prose still parses.
function invokeClose(content, from) {
  const close = /<\/invoke\s*>/gi;
  const structural = /\s*(?:<invoke\b|<\/function_calls\s*>|$)/y;
  close.lastIndex = from;
  let last = null;
  let match;

  while ((match = close.exec(content)) !== null) {
    const found = { start: match.index, end: close.lastIndex };
    structural.lastIndex = found.end;

    if (structural.test(content)) {
      return found;
    }

    last = found;
  }

  return last;
}

// After the last complete invoke, only whitespace, the wrapper's close tag or prose may follow. A
// partial invoke opening there means the output was cut off partway through the batch.
function truncatedInvokeTail(rest) {
  const tail = rest.trim();
  return tail !== "" && (tail.startsWith("<invoke") || "<invoke".startsWith(tail));
}

function parseXmlAttributes(text) {
  const attributes = {};
  const attributeRegex = /([:\w-]+)\s*=\s*(["'])(.*?)\2/g;
  let match;
  while ((match = attributeRegex.exec(String(text || ""))) !== null) {
    attributes[match[1].toLowerCase()] = decodeXmlEntities(match[3]);
  }
  return attributes;
}

// A parameter value is raw text up to a structural close: a close tag (the protocol's, or one named
// after the parameter, which Opus sometimes emits instead) followed by the next parameter opening or
// by the end of the invoke. Close tags inside the value are followed by more value text, so they no
// longer truncate it. A CDATA-wrapped value is taken verbatim.
function extractInvokeParameters(body, toolName, properties = {}) {
  const args = {};
  let open = firstParameterOpen(body, 0);

  while (open) {
    const value = cdataParameterValue(body, open) || plainParameterValue(body, open);
    const schema = Object.hasOwn(properties, open.name) ? properties[open.name] : undefined;
    // Site-tool arguments are JSON text, not a nested transport object.
    args[open.name] = toolName === "browser_execute_site_tool" && open.name === "arguments"
      ? value.text
      : coerceParameterValue(value.text, schema);
    open = value.next;
  }

  return args;
}

function firstParameterOpen(body, from) {
  const open = /<parameter\s+name=(["'])([^"']+)\1\s*>/gi;
  open.lastIndex = from;
  const match = open.exec(body);
  return match ? { name: match[2], start: match.index, valueStart: open.lastIndex } : null;
}

function parameterOpenAt(body, index) {
  const open = /\s*<parameter\s+name=(["'])([^"']+)\1\s*>/iy;
  open.lastIndex = index;
  const match = open.exec(body);
  return match ? { name: match[2], start: match.index, valueStart: open.lastIndex } : null;
}

function closeTagPattern(name, flags) {
  return new RegExp(`<\\/(?:parameter|${escapeRegExp(name)})\\s*>`, `i${flags}`);
}

function parameterBoundaryAt(body, index, name) {
  const close = closeTagPattern(name, "y");
  close.lastIndex = index;

  if (!close.test(body)) {
    return null;
  }

  const next = parameterOpenAt(body, close.lastIndex);

  if (next) {
    return { next };
  }

  return body.slice(close.lastIndex).trim() === "" ? { next: null } : null;
}

function plainParameterValue(body, open) {
  const close = closeTagPattern(open.name, "g");
  close.lastIndex = open.valueStart;
  let match;

  while ((match = close.exec(body)) !== null) {
    const boundary = parameterBoundaryAt(body, match.index, open.name);

    if (boundary) {
      return { text: decodeXmlEntities(body.slice(open.valueStart, match.index)), next: boundary.next };
    }
  }

  // No structural close: the model omitted or mangled it. Keep the legacy guess of ending at the
  // next opening or the end of the invoke, cut at the first close tag in between.
  const next = firstParameterOpen(body, open.valueStart);
  const slice = body.slice(open.valueStart, next ? next.start : body.length);
  const stray = closeTagPattern(open.name, "").exec(slice);
  return { text: decodeXmlEntities(stray ? slice.slice(0, stray.index) : slice), next };
}

function cdataParameterValue(body, open) {
  const cdata = /\s*<!\[CDATA\[/y;
  cdata.lastIndex = open.valueStart;

  if (!cdata.test(body)) {
    return null;
  }

  const innerStart = cdata.lastIndex;

  for (let end = body.indexOf("]]>", innerStart); end >= 0; end = body.indexOf("]]>", end + 1)) {
    const closeAt = end + 3 + body.slice(end + 3).search(/\S|$/);
    const boundary = parameterBoundaryAt(body, closeAt, open.name);

    if (boundary) {
      return { text: body.slice(innerStart, end), next: boundary.next };
    }
  }

  return null;
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeAnthropicInvoke(call) {
  const name = String(call.name || "").trim();

  if (isSubagentName(name) && typeof call.args?.prompt === "string") {
    return {
      id: call.id || "",
      name: "task",
      args: {
        subagent_type: name.toLowerCase(),
        prompt: call.args.prompt,
        description: typeof call.args.description === "string"
          ? call.args.description
          : summarizeTaskDescription(call.args.prompt)
      }
    };
  }

  return call;
}

const XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };

// One pass, so an escaped ampersand is never decoded twice. Numeric references cover all of
// Unicode; invalid ones stay as written.
function decodeXmlEntities(text) {
  return text.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g, (entity, decimal, hex, name) => {
    if (name) {
      return XML_ENTITIES[name];
    }

    const code = decimal ? Number(decimal) : Number.parseInt(hex, 16);
    return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : entity;
  });
}

// A value stays the exact text unless the tool's schema rules out a string. Without a schema, keep
// the legacy guess so unknown tools still receive booleans, numbers and JSON.
function coerceParameterValue(raw, schema) {
  if (schemaTypes(schema).has("string")) {
    return raw;
  }

  const trimmed = raw.trim();

  if (trimmed === "") return raw;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;

  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    return parseJsonLenient(trimmed) ?? raw;
  }

  if (/^-?\d+$/.test(trimmed) && Number.isSafeInteger(Number(trimmed))) return Number(trimmed);
  if (/^-?\d+\.\d+$/.test(trimmed)) return Number(trimmed);

  return raw;
}

function schemaTypes(schema) {
  if (!schema || typeof schema !== "object") {
    return new Set();
  }

  const declared = [schema.type].flat().filter((type) => typeof type === "string");
  const values = [...(Array.isArray(schema.enum) ? schema.enum : []), ...("const" in schema ? [schema.const] : [])]
    .map(jsonType);
  const nested = [schema.anyOf, schema.oneOf, schema.allOf]
    .filter(Array.isArray)
    .flatMap((list) => list.flatMap((item) => [...schemaTypes(item)]));

  return new Set([...declared, ...values, ...nested]);
}

function jsonType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function typedJsonToolCalls(content, code) {
  if (!content.includes("tool_call")) {
    return [];
  }

  return jsonObjectCandidates(content, code)
    .map((candidate) => parseJsonLenient(candidate))
    .filter(isTypedToolCall);
}

// Every balanced object outside Markdown code that starts like JSON. Each start is scanned on its
// own, so a stray brace in prose cannot swallow a later call.
function jsonObjectCandidates(content, code) {
  const candidates = [];
  const start = /\{\s*"/g;
  let lastEnd = 0;
  let match;

  while ((match = start.exec(content)) !== null) {
    const range = rangeAt(match.index, code);

    // Backticks inside an accepted object's strings are data. A range they open can pair with
    // backticks in a later object on the same line, so it must not hide that object.
    if (range && range.start >= lastEnd) {
      start.lastIndex = Math.max(start.lastIndex, range.end);
      continue;
    }

    const end = matchingBrace(content, match.index);

    if (end >= 0) {
      candidates.push(content.slice(match.index, end));
      start.lastIndex = end;
      lastEnd = end;
    }
  }

  return candidates;
}

function matchingBrace(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;

      if (depth === 0) {
        return index + 1;
      }
    }
  }

  return -1;
}

function isTypedToolCall(value) {
  return Boolean(value)
    && typeof value === "object"
    && value.type === "tool_call"
    && typeof value.tool === "string"
    && value.tool.trim() !== "";
}

// Identical calls with the same id, or with no id, are one call repeated in the text. Calls that
// carry different ids are distinct even when their arguments match.
function dedupeToolCalls(calls) {
  const seen = new Set();

  return calls.filter((call) => {
    const key = JSON.stringify([call.id ?? "", call.tool, call.args ?? {}]);

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function parseWholeMessageJson(content) {
  const trimmed = content.trim();

  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }

  const parsed = parseJsonLenient(trimmed);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
}

// Legacy delegation shape: a reply that is only a JSON object naming a subagent, with its prompt.
function delegatedSubagentCall(parsed) {
  const name = typeof parsed?.name === "string" ? parsed.name.trim() : "";

  if (!isSubagentName(name) || typeof parsed.prompt !== "string") {
    return null;
  }

  return {
    id: "",
    name: "task",
    args: {
      subagent_type: name.toLowerCase(),
      prompt: parsed.prompt,
      description: typeof parsed.description === "string"
        ? parsed.description
        : summarizeTaskDescription(parsed.prompt)
    }
  };
}

function isSubagentName(name) {
  return ["explore", "general", "scout", "search"].includes(String(name).toLowerCase());
}

function summarizeTaskDescription(prompt) {
  const text = String(prompt || "").trim().replace(/\s+/g, " ");

  if (!text) {
    return "Run subagent task";
  }

  const words = text.split(" ").slice(0, 5).join(" ");
  return words.length > 48 ? `${words.slice(0, 45)}...` : words;
}

// Strict JSON first, so valid escapes are never rewritten. Models sometimes leave Windows path
// backslashes unescaped, so only text that JSON rejects gets the path repair. Returns undefined
// when neither parse succeeds.
function parseJsonLenient(text) {
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(repairRawWindowsBackslashesInJsonStrings(text));
    } catch {
      return undefined;
    }
  }
}

function repairRawWindowsBackslashesInJsonStrings(content) {
  if (typeof content !== "string" || !/[A-Za-z]:\\/.test(content)) {
    return content;
  }

  let output = "";
  let index = 0;

  while (index < content.length) {
    if (content[index] !== "\"") {
      output += content[index];
      index += 1;
      continue;
    }

    const start = index;
    index += 1;
    const valueStart = index;
    let slashCount = 0;

    while (index < content.length) {
      const char = content[index];

      if (char === "\"" && slashCount % 2 === 0) {
        break;
      }

      if (char === "\\") {
        slashCount += 1;
      } else {
        slashCount = 0;
      }

      index += 1;
    }

    const rawValue = content.slice(valueStart, index);
    const value = hasRawWindowsBackslash(rawValue)
      ? rawValue.replace(/(^|[^\\])\\(?!\\)/g, "$1\\\\")
      : rawValue;

    output += content[start] + value;

    if (index < content.length) {
      output += content[index];
      index += 1;
    }
  }

  return output;
}

function hasRawWindowsBackslash(value) {
  return /[A-Za-z]:/.test(value)
    && /(^|[^\\])\\(?!\\)/.test(value);
}

export { looksLikeIncompleteAnthropicToolCall };
