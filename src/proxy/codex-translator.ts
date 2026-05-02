// OpenAI Chat Completions <-> OpenAI Responses translation for Codex backend.
// Codex OAuth uses chatgpt.com/backend-api/codex/responses instead of /chat/completions.

export interface CodexStreamState {
  id: string;
  model: string;
  roleSent: boolean;
  completed: boolean;
  sawTextDelta: boolean;
  sawToolDelta: boolean;
  nextToolIndex: number;
  toolCallIndexById: Map<string, number>;
  toolArgsSeenById: Set<string>;
}

const DEFAULT_CODEX_INSTRUCTIONS = "You are Codex. Follow the user request carefully and respond concisely.";

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function serializeContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return serializeContent(content);
  const parts: string[] = [];
  for (const item of content) {
    const rec = toRecord(item);
    if (!rec) {
      const serialized = serializeContent(item);
      if (serialized) parts.push(serialized);
      continue;
    }
    if (typeof rec.text === "string") parts.push(rec.text);
    else if (typeof rec.output_text === "string") parts.push(rec.output_text);
    else if (rec.type === "text" && typeof rec.content === "string") parts.push(rec.content);
    else {
      const serialized = serializeContent(rec);
      if (serialized) parts.push(serialized);
    }
  }
  return parts.join("\n");
}

function mapToolDefs(tools: unknown): unknown[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const mapped = tools
    .map((tool) => {
      const t = toRecord(tool);
      if (!t || t.type !== "function") return null;
      const fn = toRecord(t.function);
      if (!fn || typeof fn.name !== "string") return null;
      return {
        type: "function",
        name: fn.name,
        description: typeof fn.description === "string" ? fn.description : "",
        parameters: toRecord(fn.parameters) ?? { type: "object", properties: {} },
      };
    })
    .filter((x) => x !== null);
  return mapped.length ? mapped : undefined;
}

function mapToolChoice(toolChoice: unknown): unknown {
  if (toolChoice === "auto" || toolChoice === "required" || toolChoice === "none") return toolChoice;
  const rec = toRecord(toolChoice);
  if (!rec || rec.type !== "function") return undefined;
  const fn = toRecord(rec.function);
  if (!fn || typeof fn.name !== "string" || !fn.name) return undefined;
  return { type: "function", name: fn.name };
}

function defaultCodexToolChoice(): "required" | "auto" | "none" {
  const raw = (process.env.GROUTER_CODEX_DEFAULT_TOOL_CHOICE ?? "required").trim().toLowerCase();
  if (raw === "auto" || raw === "none" || raw === "required") return raw;
  return "required";
}

function mapInputMessages(messages: unknown): unknown[] {
  if (!Array.isArray(messages)) return [];
  const input: unknown[] = [];

  for (const raw of messages) {
    const msg = toRecord(raw);
    if (!msg) continue;
    const role = typeof msg.role === "string" ? msg.role : "user";

    if (role === "system" || role === "developer") continue;

    if (role === "tool") {
      const callId =
        (typeof msg.tool_call_id === "string" && msg.tool_call_id) ||
        (typeof msg.toolCallId === "string" && msg.toolCallId) ||
        "";
      const output = normalizeTextContent(msg.content) || serializeContent(msg.content);
      input.push({
        type: "function_call_output",
        call_id: callId,
        output,
      });
      continue;
    }

    const mappedRole = role === "assistant" ? "assistant" : "user";
    const text = normalizeTextContent(msg.content);
    if (text) input.push({ role: mappedRole, content: text });

    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    for (const tcRaw of toolCalls) {
      const tc = toRecord(tcRaw);
      const fn = toRecord(tc?.function);
      if (!tc || !fn || typeof fn.name !== "string") continue;
      const callId = typeof tc.id === "string" ? tc.id : "";
      const args = typeof fn.arguments === "string" ? fn.arguments : "{}";
      input.push({
        type: "function_call",
        call_id: callId,
        name: fn.name,
        arguments: args,
      });
    }
  }

  return input;
}

export function openaiToCodexResponses(body: Record<string, unknown>, stream: boolean): Record<string, unknown> {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const instructionParts = messages
    .map((m) => toRecord(m))
    .filter((m): m is Record<string, unknown> => !!m && (m.role === "system" || m.role === "developer"))
    .map((m) => normalizeTextContent(m.content))
    .filter(Boolean);

  const mappedInput = mapInputMessages(messages);
  const mappedTools = mapToolDefs(body.tools);
  const mappedToolChoice = mapToolChoice(body.tool_choice);
  const parallelToolCalls =
    typeof body.parallel_tool_calls === "boolean"
      ? body.parallel_tool_calls
      : true;
  const explicitInstructions =
    typeof body.instructions === "string" && body.instructions.trim()
      ? body.instructions.trim()
      : "";

  const out: Record<string, unknown> = {
    model: typeof body.model === "string" ? body.model : "",
    store: false,
    stream,
    input: mappedInput,
  };

  if (instructionParts.length) out.instructions = instructionParts.join("\n");
  else if (explicitInstructions) out.instructions = explicitInstructions;
  else out.instructions = DEFAULT_CODEX_INSTRUCTIONS;
  if (mappedTools) {
    out.tools = mappedTools;
    out.tool_choice = mappedToolChoice ?? defaultCodexToolChoice();
    out.parallel_tool_calls = parallelToolCalls;
  }
  // Codex Responses rejects `temperature` on current rollout.
  // Keep payload minimal and stable.
  // chatgpt.com/backend-api/codex/responses can reject token-cap fields
  // (`max_output_tokens`, `max_tokens`) depending on rollout.
  // Codex CLI requests work without these fields, so we omit them here.

  return out;
}

function parseOpenAIChunkPayload(payload: string): Record<string, unknown> | null {
  const line = payload.trim();
  if (!line.startsWith("data:")) return null;
  const data = line.slice(5).trim();
  if (!data || data === "[DONE]") return null;
  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function mergeToolCall(
  acc: Map<number, Record<string, unknown>>,
  tc: Record<string, unknown>,
): void {
  const index = typeof tc.index === "number" ? tc.index : 0;
  const existing = (acc.get(index) ?? {
    index,
    id: "",
    type: "function",
    function: { name: "", arguments: "" },
  }) as Record<string, unknown>;

  if (typeof tc.id === "string" && tc.id) existing.id = tc.id;
  if (typeof tc.type === "string" && tc.type) existing.type = tc.type;

  const fnIn = toRecord(tc.function);
  if (fnIn) {
    const fnExisting = (toRecord(existing.function) ?? { name: "", arguments: "" }) as Record<string, unknown>;
    if (typeof fnIn.name === "string" && fnIn.name) fnExisting.name = fnIn.name;
    if (typeof fnIn.arguments === "string" && fnIn.arguments) {
      const prev = typeof fnExisting.arguments === "string" ? fnExisting.arguments : "";
      fnExisting.arguments = prev + fnIn.arguments;
    }
    existing.function = fnExisting;
  }

  acc.set(index, existing);
}

function openAIChunksToNonStreamCompletion(chunks: string[]): Record<string, unknown> {
  let id = `chatcmpl-${Date.now()}`;
  let model = "gpt-5.4";
  let created = Math.floor(Date.now() / 1000);
  let finishReason = "stop";
  let text = "";
  let usage: Record<string, number> | undefined;
  const toolCalls = new Map<number, Record<string, unknown>>();

  for (const raw of chunks) {
    const payload = parseOpenAIChunkPayload(raw);
    if (!payload) continue;

    if (typeof payload.id === "string" && payload.id) id = payload.id;
    if (typeof payload.model === "string" && payload.model) model = payload.model;
    if (typeof payload.created === "number" && Number.isFinite(payload.created)) created = Math.floor(payload.created);

    const maybeUsage = toRecord(payload.usage);
    if (maybeUsage) {
      const p = typeof maybeUsage.prompt_tokens === "number" ? maybeUsage.prompt_tokens : 0;
      const c = typeof maybeUsage.completion_tokens === "number" ? maybeUsage.completion_tokens : 0;
      const t = typeof maybeUsage.total_tokens === "number" ? maybeUsage.total_tokens : p + c;
      usage = { prompt_tokens: p, completion_tokens: c, total_tokens: t };
    }

    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const c0 = toRecord(choices[0]);
    if (!c0) continue;
    if (typeof c0.finish_reason === "string" && c0.finish_reason) finishReason = c0.finish_reason;

    const delta = toRecord(c0.delta);
    if (!delta) continue;
    if (typeof delta.content === "string") text += delta.content;

    const tcList = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (const tcRaw of tcList) {
      const tc = toRecord(tcRaw);
      if (!tc) continue;
      mergeToolCall(toolCalls, tc);
    }
  }

  const message: Record<string, unknown> = {
    role: "assistant",
    content: text || null,
  };
  if (toolCalls.size) {
    message.tool_calls = Array.from(toolCalls.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => v);
  }

  const out: Record<string, unknown> = {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
  };
  if (usage) out.usage = usage;
  return out;
}

export function translateCodexSSEToNonStream(rawSse: string): Record<string, unknown> {
  const state = newCodexStreamState();
  const translatedChunks: string[] = [];
  const lines = rawSse.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!trimmed.startsWith("data:")) continue;
    const translated = codexChunkToOpenAI(trimmed, state);
    translatedChunks.push(...translated);
  }

  return openAIChunksToNonStreamCompletion(translatedChunks);
}

function mapUsage(raw: unknown): Record<string, number> | undefined {
  const usage = toRecord(raw);
  if (!usage) return undefined;
  const input = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const output = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  const total = typeof usage.total_tokens === "number" ? usage.total_tokens : input + output;
  if (input === 0 && output === 0 && total === 0) return undefined;
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: total,
  };
}

function mapFinishReason(status: string | undefined, hasToolCalls: boolean, incomplete: Record<string, unknown> | null): string {
  if (hasToolCalls) return "tool_calls";
  if (status === "incomplete") {
    const reason = typeof incomplete?.reason === "string" ? incomplete.reason : "";
    return reason.includes("max") ? "length" : "stop";
  }
  if (status === "failed" || status === "cancelled") return "stop";
  return "stop";
}

function extractResponseTextAndTools(response: Record<string, unknown>): {
  text: string;
  toolCalls: unknown[];
} {
  const output = Array.isArray(response.output) ? response.output : [];
  const textParts: string[] = [];
  const toolCalls: unknown[] = [];
  let toolIndex = 0;

  for (const itemRaw of output) {
    const item = toRecord(itemRaw);
    if (!item) continue;
    const type = typeof item.type === "string" ? item.type : "";

    if (type === "message") {
      const content = Array.isArray(item.content) ? item.content : [];
      for (const partRaw of content) {
        const part = toRecord(partRaw);
        if (!part) continue;
        if (typeof part.text === "string") textParts.push(part.text);
        else if (typeof part.output_text === "string") textParts.push(part.output_text);
      }
      continue;
    }

    if (type === "function_call") {
      const callId = typeof item.call_id === "string" ? item.call_id : "";
      const name = typeof item.name === "string" ? item.name : "tool";
      const args = typeof item.arguments === "string" ? item.arguments : "{}";
      toolCalls.push({
        id: callId,
        index: toolIndex++,
        type: "function",
        function: { name, arguments: args },
      });
    }
  }

  return { text: textParts.join(""), toolCalls };
}

export function translateCodexNonStream(raw: Record<string, unknown>): Record<string, unknown> {
  const response = toRecord(raw.response) ?? raw;
  const { text, toolCalls } = extractResponseTextAndTools(response);
  const usage = mapUsage(response.usage);
  const status = typeof response.status === "string" ? response.status : undefined;
  const finishReason = mapFinishReason(status, toolCalls.length > 0, toRecord(response.incomplete_details));

  const message: Record<string, unknown> = {
    role: "assistant",
    content: text || null,
  };
  if (toolCalls.length) message.tool_calls = toolCalls;

  const out: Record<string, unknown> = {
    id: `chatcmpl-${typeof response.id === "string" ? response.id : Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: typeof response.model === "string" ? response.model : "gpt-5.4",
    choices: [{ index: 0, message, finish_reason: finishReason }],
  };
  if (usage) out.usage = usage;
  return out;
}

function chunkBase(state: CodexStreamState): Record<string, unknown> {
  return {
    id: `chatcmpl-${state.id || Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: state.model || "gpt-5.4",
  };
}

export function newCodexStreamState(): CodexStreamState {
  return {
    id: "",
    model: "",
    roleSent: false,
    completed: false,
    sawTextDelta: false,
    sawToolDelta: false,
    nextToolIndex: 0,
    toolCallIndexById: new Map<string, number>(),
    toolArgsSeenById: new Set<string>(),
  };
}

function roleChunk(state: CodexStreamState): string {
  return `data: ${JSON.stringify({
    ...chunkBase(state),
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  })}\n\n`;
}

function getToolIndex(state: CodexStreamState, callId: string): number {
  const known = state.toolCallIndexById.get(callId);
  if (typeof known === "number") return known;
  const idx = state.nextToolIndex++;
  state.toolCallIndexById.set(callId, idx);
  return idx;
}

function toolCallDeltaChunk(state: CodexStreamState, toolDelta: Record<string, unknown>): string {
  return `data: ${JSON.stringify({
    ...chunkBase(state),
    choices: [{ index: 0, delta: { tool_calls: [toolDelta] }, finish_reason: null }],
  })}\n\n`;
}

export function codexChunkToOpenAI(rawLine: string, state: CodexStreamState): string[] {
  if (!rawLine.startsWith("data:")) return [];
  const data = rawLine.slice(5).trim();
  if (!data) return [];
  if (data === "[DONE]") {
    if (state.completed) return [];
    state.completed = true;
    return ["data: [DONE]\n\n"];
  }

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return [];
  }

  const type = typeof event.type === "string" ? event.type : "";

  if (type === "response.created") {
    const response = toRecord(event.response);
    if (response) {
      if (typeof response.id === "string") state.id = response.id;
      if (typeof response.model === "string") state.model = response.model;
    }
    return [];
  }

  if (type === "response.output_text.delta") {
    const delta = typeof event.delta === "string" ? event.delta : "";
    if (!delta) return [];
    const out: string[] = [];
    if (!state.roleSent) {
      state.roleSent = true;
      out.push(roleChunk(state));
    }
    state.sawTextDelta = true;
    out.push(
      `data: ${JSON.stringify({
        ...chunkBase(state),
        choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
      })}\n\n`,
    );
    return out;
  }

  if (type === "response.refusal.delta") {
    const delta = typeof event.delta === "string" ? event.delta : "";
    if (!delta) return [];
    const out: string[] = [];
    if (!state.roleSent) {
      state.roleSent = true;
      out.push(roleChunk(state));
    }
    state.sawTextDelta = true;
    out.push(
      `data: ${JSON.stringify({
        ...chunkBase(state),
        choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
      })}\n\n`,
    );
    return out;
  }

  if (type === "response.output_item.added" || type === "response.output_item.done") {
    const item = toRecord(event.item);
    if (!item) return [];
    if (item.type !== "function_call") return [];

    const callId = typeof item.call_id === "string" ? item.call_id : "";
    if (!callId) return [];
    const alreadyKnown = state.toolCallIndexById.has(callId);
    const name = typeof item.name === "string" ? item.name : "tool";
    const args = typeof item.arguments === "string" ? item.arguments : "";
    const toolIndex = getToolIndex(state, callId);
    if (type === "response.output_item.added" && alreadyKnown) return [];
    if (type === "response.output_item.done" && state.toolArgsSeenById.has(callId)) return [];

    const out: string[] = [];
    if (!state.roleSent) {
      state.roleSent = true;
      out.push(roleChunk(state));
    }
    out.push(
      toolCallDeltaChunk(state, {
        index: toolIndex,
        id: callId,
        type: "function",
        function: { name, arguments: args || "" },
      }),
    );
    state.sawToolDelta = true;
    if (args) state.toolArgsSeenById.add(callId);
    return out;
  }

  if (type === "response.function_call_arguments.delta" || type === "response.function_call_arguments.done") {
    const callId = typeof event.call_id === "string" ? event.call_id : "";
    const delta = typeof event.delta === "string"
      ? event.delta
      : typeof event.arguments === "string"
        ? event.arguments
        : "";
    if (!callId || !delta) return [];

    const toolIndex = getToolIndex(state, callId);
    const out: string[] = [];
    if (!state.roleSent) {
      state.roleSent = true;
      out.push(roleChunk(state));
    }
    out.push(
      toolCallDeltaChunk(state, {
        index: toolIndex,
        function: { arguments: delta },
      }),
    );
    state.sawToolDelta = true;
    state.toolArgsSeenById.add(callId);
    return out;
  }

  if (type === "response.completed" || type === "response.done" || type === "response.incomplete") {
    if (state.completed) return [];
    const response = toRecord(event.response) ?? {};
    if (typeof response.id === "string") state.id = response.id;
    if (typeof response.model === "string") state.model = response.model;
    const { text, toolCalls } = extractResponseTextAndTools(response);
    const hasToolCalls = toolCalls.length > 0 || state.sawToolDelta;
    const usage = mapUsage(response.usage);
    const finishReason = mapFinishReason(
      typeof response.status === "string" ? response.status : "completed",
      hasToolCalls,
      toRecord(response.incomplete_details),
    );
    state.completed = true;
    const out: string[] = [];

    // Fallback: some upstream responses only include full text on completion.
    if (!state.sawTextDelta && text) {
      if (!state.roleSent) {
        state.roleSent = true;
        out.push(roleChunk(state));
      }
      out.push(
        `data: ${JSON.stringify({
          ...chunkBase(state),
          choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
        })}\n\n`,
      );
    }

    // Fallback: some upstream responses only include function calls on completion.
    if (!state.sawToolDelta && toolCalls.length) {
      if (!state.roleSent) {
        state.roleSent = true;
        out.push(roleChunk(state));
      }
      for (const rawToolCall of toolCalls) {
        const tc = toRecord(rawToolCall);
        const fn = toRecord(tc?.function);
        if (!tc || !fn) continue;
        const callId = typeof tc.id === "string" ? tc.id : "";
        const name = typeof fn.name === "string" ? fn.name : "tool";
        const args = typeof fn.arguments === "string" ? fn.arguments : "";
        const toolIndex = typeof tc.index === "number" ? tc.index : getToolIndex(state, callId);

        out.push(
          toolCallDeltaChunk(state, {
            index: toolIndex,
            id: callId,
            type: "function",
            function: { name, arguments: args },
          }),
        );
        state.sawToolDelta = true;
        if (callId) state.toolCallIndexById.set(callId, toolIndex);
        if (callId && args) state.toolArgsSeenById.add(callId);
      }
    }

    const doneChunk: Record<string, unknown> = {
      ...chunkBase(state),
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    };
    if (usage) doneChunk.usage = usage;

    out.push(`data: ${JSON.stringify(doneChunk)}\n\n`);
    out.push("data: [DONE]\n\n");
    return out;
  }

  if (type === "error" || type === "response.failed") {
    if (state.completed) return [];
    state.completed = true;
    return [
      `data: ${JSON.stringify({
        ...chunkBase(state),
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`,
      "data: [DONE]\n\n",
    ];
  }

  return [];
}
