// OpenAI ↔ Kiro (AWS CodeWhisperer Streaming) translator.
// Kiro returns AWS EventStream frames (application/vnd.amazon.eventstream),
// so we decode binary frames and emit OpenAI-compatible SSE/JSON.

const utf8 = new TextDecoder();

interface KiroUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

interface KiroEvent {
  messageType: string | null;
  eventType: string | null;
  payload: Uint8Array;
}

export interface KiroStreamState {
  id: string;
  model: string;
  created: number;
  roleSent: boolean;
  done: boolean;
  text: string;
  usage: KiroUsage | null;
  decoder: KiroEventStreamDecoder;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const p = part as Record<string, unknown>;
      return p.type === "text" && typeof p.text === "string" ? p.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function mapOpenAIMessageToKiro(msg: Record<string, unknown>, model: string): Record<string, unknown> | null {
  const role = typeof msg.role === "string" ? msg.role : "user";

  if (role === "assistant") {
    const text = extractText(msg.content);
    if (!text) return null;
    return { assistantResponseMessage: { content: text } };
  }

  if (role === "tool") {
    const toolId = typeof msg.tool_call_id === "string" ? ` (${msg.tool_call_id})` : "";
    const raw = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "");
    const text = `Tool result${toolId}: ${raw}`;
    return { userInputMessage: { content: text, modelId: model } };
  }

  const text = extractText(msg.content);
  if (!text) return null;
  return { userInputMessage: { content: text, modelId: model } };
}

export function openaiToKiro(
  model: string,
  body: Record<string, unknown>,
  profileArn?: string | null,
): Record<string, unknown> {
  const messages = Array.isArray(body.messages) ? (body.messages as Record<string, unknown>[]) : [];
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => extractText(m.content))
    .filter(Boolean)
    .join("\n\n");

  const convo: Record<string, unknown>[] = [];
  let systemInjected = false;

  for (const msg of messages) {
    if (msg.role === "system") continue;
    const mapped = mapOpenAIMessageToKiro(msg, model);
    if (!mapped) continue;

    if (!systemInjected && system && "userInputMessage" in mapped) {
      const u = mapped.userInputMessage as Record<string, unknown>;
      const content = typeof u.content === "string" ? u.content : "";
      u.content = content ? `${system}\n\n${content}` : system;
      systemInjected = true;
    }

    convo.push(mapped);
  }

  if (convo.length === 0) {
    convo.push({
      userInputMessage: {
        content: system || "Hello",
        modelId: model,
      },
    });
  }

  const current = convo[convo.length - 1]!;
  const history = convo.slice(0, -1);

  const out: Record<string, unknown> = {
    conversationState: {
      currentMessage: current,
      chatTriggerType: "MANUAL",
      ...(history.length ? { history } : {}),
    },
  };

  if (profileArn) out.profileArn = profileArn;
  return out;
}

function parseUsage(payload: Record<string, unknown>): KiroUsage | null {
  const usage = payload.tokenUsage as Record<string, unknown> | undefined;
  if (!usage) return null;

  const uncached = Number(usage.uncachedInputTokens ?? 0);
  const cacheRead = Number(usage.cacheReadInputTokens ?? 0);
  const cacheWrite = Number(usage.cacheWriteInputTokens ?? 0);
  const output = Number(usage.outputTokens ?? 0);
  const total = Number(usage.totalTokens ?? (uncached + cacheRead + cacheWrite + output));

  if (!Number.isFinite(total) || total <= 0) return null;
  return {
    prompt_tokens: Math.max(0, uncached + cacheRead + cacheWrite),
    completion_tokens: Math.max(0, output),
    total_tokens: Math.max(0, total),
  };
}

function chunkObj(
  state: KiroStreamState,
  delta: Record<string, unknown>,
  finishReason: string | null,
  includeUsage = false,
): string {
  const out: Record<string, unknown> = {
    id: `chatcmpl-${state.id}`,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  if (includeUsage && state.usage) out.usage = state.usage;
  return `data: ${JSON.stringify(out)}\n\n`;
}

function safeJson(payload: Uint8Array): Record<string, unknown> {
  if (!payload.length) return {};
  try {
    return JSON.parse(utf8.decode(payload)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function applyEvent(state: KiroStreamState, event: KiroEvent, out?: string[]): void {
  if (event.messageType !== "event") return;

  // Smithy "initial-response" event carries an empty object.
  if (event.eventType === "initial-response") return;

  if (event.eventType === "assistantResponseEvent") {
    const payload = safeJson(event.payload);
    const content = typeof payload.content === "string" ? payload.content : "";
    const modelId = typeof payload.modelId === "string" && payload.modelId ? payload.modelId : null;
    if (modelId) state.model = modelId;

    if (out && !state.roleSent) {
      out.push(chunkObj(state, { role: "assistant" }, null));
      state.roleSent = true;
    }
    if (content) {
      state.text += content;
      if (out) out.push(chunkObj(state, { content }, null));
    }
    return;
  }

  if (event.eventType === "metadataEvent") {
    const payload = safeJson(event.payload);
    const usage = parseUsage(payload);
    if (usage) state.usage = usage;
  }
}

export function newKiroStreamState(requestedModel: string): KiroStreamState {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    model: requestedModel || "kiro",
    created: Math.floor(Date.now() / 1000),
    roleSent: false,
    done: false,
    text: "",
    usage: null,
    decoder: new KiroEventStreamDecoder(),
  };
}

export function kiroChunkToOpenAI(chunk: Uint8Array, state: KiroStreamState): string[] {
  const out: string[] = [];
  const events = state.decoder.push(chunk);
  for (const ev of events) applyEvent(state, ev, out);
  return out;
}

export function finalizeKiroStream(state: KiroStreamState): string[] {
  if (state.done) return [];
  state.done = true;
  return [chunkObj(state, {}, "stop", true), "data: [DONE]\n\n"];
}

export function translateKiroNonStream(raw: Uint8Array, requestedModel: string): Record<string, unknown> {
  const state = newKiroStreamState(requestedModel);
  for (const ev of state.decoder.push(raw)) applyEvent(state, ev);

  const out: Record<string, unknown> = {
    id: `chatcmpl-${state.id}`,
    object: "chat.completion",
    created: state.created,
    model: state.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: state.text || "" },
        finish_reason: "stop",
      },
    ],
  };

  if (state.usage) out.usage = state.usage;
  return out;
}

class KiroEventStreamDecoder {
  private buf = new Uint8Array(0);

  push(chunk: Uint8Array): KiroEvent[] {
    if (chunk.length) this.buf = concat(this.buf, chunk);
    const out: KiroEvent[] = [];

    let off = 0;
    while (this.buf.length - off >= 12) {
      const totalLen = readU32(this.buf, off);
      if (totalLen < 16) break;
      if (this.buf.length - off < totalLen) break;

      const headersLen = readU32(this.buf, off + 4);
      const headersStart = off + 12;
      const headersEnd = headersStart + headersLen;
      const payloadStart = headersEnd;
      const payloadEnd = off + totalLen - 4; // trailing message CRC

      if (headersEnd > payloadEnd || payloadStart > payloadEnd) {
        off += totalLen;
        continue;
      }

      const headers = parseHeaders(this.buf.subarray(headersStart, headersEnd));
      const payload = this.buf.slice(payloadStart, payloadEnd);
      out.push({
        messageType: asHeaderString(headers[":message-type"]),
        eventType: asHeaderString(headers[":event-type"]),
        payload,
      });

      off += totalLen;
    }

    this.buf = off > 0 ? this.buf.slice(off) : this.buf;
    return out;
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function readU16(buf: Uint8Array, off: number): number {
  return new DataView(buf.buffer, buf.byteOffset + off, 2).getUint16(0, false);
}

function readU32(buf: Uint8Array, off: number): number {
  return new DataView(buf.buffer, buf.byteOffset + off, 4).getUint32(0, false);
}

function readI64(buf: Uint8Array, off: number): bigint {
  return new DataView(buf.buffer, buf.byteOffset + off, 8).getBigInt64(0, false);
}

function asHeaderString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function parseHeaders(bytes: Uint8Array): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let i = 0;

  while (i < bytes.length) {
    const nameLen = bytes[i++];
    if (i + nameLen > bytes.length) break;

    const name = utf8.decode(bytes.subarray(i, i + nameLen));
    i += nameLen;
    if (i >= bytes.length) break;

    const type = bytes[i++];
    switch (type) {
      case 0:
        out[name] = true;
        break;
      case 1:
        out[name] = false;
        break;
      case 2:
        if (i + 1 > bytes.length) return out;
        out[name] = new DataView(bytes.buffer, bytes.byteOffset + i, 1).getInt8(0);
        i += 1;
        break;
      case 3:
        if (i + 2 > bytes.length) return out;
        out[name] = new DataView(bytes.buffer, bytes.byteOffset + i, 2).getInt16(0, false);
        i += 2;
        break;
      case 4:
        if (i + 4 > bytes.length) return out;
        out[name] = new DataView(bytes.buffer, bytes.byteOffset + i, 4).getInt32(0, false);
        i += 4;
        break;
      case 5:
        if (i + 8 > bytes.length) return out;
        out[name] = readI64(bytes, i);
        i += 8;
        break;
      case 6: {
        if (i + 2 > bytes.length) return out;
        const len = readU16(bytes, i);
        i += 2;
        if (i + len > bytes.length) return out;
        out[name] = bytes.slice(i, i + len);
        i += len;
        break;
      }
      case 7: {
        if (i + 2 > bytes.length) return out;
        const len = readU16(bytes, i);
        i += 2;
        if (i + len > bytes.length) return out;
        out[name] = utf8.decode(bytes.subarray(i, i + len));
        i += len;
        break;
      }
      case 8:
        if (i + 8 > bytes.length) return out;
        out[name] = readI64(bytes, i);
        i += 8;
        break;
      case 9:
        if (i + 16 > bytes.length) return out;
        out[name] = bytes.slice(i, i + 16);
        i += 16;
        break;
      default:
        return out;
    }
  }

  return out;
}
