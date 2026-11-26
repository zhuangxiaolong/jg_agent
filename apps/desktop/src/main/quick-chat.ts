export type QuickChatBackend = 'responses' | 'chat_completions' | 'messages';

export interface QuickChatMessage {
  role: 'user' | 'assistant';
  text: string;
  images?: string[];
}

export interface QuickChatRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  backend: QuickChatBackend;
  messages: QuickChatMessage[];
  signal: AbortSignal;
  onDelta: (text: string) => void;
  fetcher?: typeof fetch;
}

interface ConversationEvent { type: string; text: string }

const SYSTEM_INSTRUCTIONS = '你是通用对话助手。简洁回答。你没有项目文件、命令执行或实时联网工具；遇到需要实时数据的问题，明确说明无法实时查询，不得编造。';
const MAX_INPUT_BYTES = 48 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 256 * 1024;
const MAX_HISTORY_TURNS = 8;
const MAX_HISTORY_CHARS = 24000;

export function quickChatHistory(events: ConversationEvent[]): QuickChatMessage[] {
  const turns: Array<{ user: string; assistant: string }> = [];
  let assistantDraft = '';
  let current: { user: string; assistant: string } | undefined;
  const finishAssistant = () => {
    if (assistantDraft && current) current.assistant += assistantDraft;
    assistantDraft = '';
  };

  for (const event of events) {
    if (event.type === 'user') {
      finishAssistant();
      current = { user: event.text, assistant: '' };
      turns.push(current);
    } else if (event.type === 'delta') assistantDraft += event.text;
    else if (event.type === 'message') {
      finishAssistant();
      if (current && current.assistant.trim() !== event.text.trim()) current.assistant += event.text;
    }
  }
  finishAssistant();

  const selected: Array<{ user: string; assistant: string }> = [];
  let remaining = MAX_HISTORY_CHARS;
  for (const turn of turns.slice(-MAX_HISTORY_TURNS).reverse()) {
    const size = turn.user.length + turn.assistant.length;
    if (size > remaining) {
      if (!selected.length && remaining > 0) {
        const userBudget = Math.min(turn.user.length, Math.floor(remaining / 2));
        const assistantBudget = remaining - userBudget;
        selected.push({ user: turn.user.slice(-userBudget), assistant: turn.assistant.slice(-assistantBudget) });
      }
      break;
    }
    selected.push(turn);
    remaining -= size;
  }
  return selected.reverse().flatMap(turn => [
    { role: 'user' as const, text: turn.user },
    ...(turn.assistant ? [{ role: 'assistant' as const, text: turn.assistant }] : []),
  ]);
}

export async function streamQuickChat(request: QuickChatRequest): Promise<string> {
  validateRequest(request);
  const fetcher = request.fetcher ?? fetch;
  const url = endpoint(request.baseUrl, request.backend);
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json' };
  if (request.backend === 'messages') {
    headers['x-api-key'] = request.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else headers.Authorization = `Bearer ${request.apiKey}`;

  const body = JSON.stringify(requestBody(request));
  if (Buffer.byteLength(body, 'utf8') > MAX_INPUT_BYTES) throw new Error('本轮消息超过轻量会话请求限制，请缩短附件或问题后重试');
  const response = await fetcher(url, { method: 'POST', headers, body, signal: request.signal, redirect: 'error' });
  if (!response.ok) throw new Error(`模型请求失败（HTTP ${response.status}）`);
  const contentType = response.headers.get('content-type') ?? '';
  const output = contentType.includes('text/event-stream')
    ? await readEventStream(response, request)
    : await readJsonResponse(response, request);
  if (!output.trim()) throw new Error('模型未返回有效文本');
  return output;
}

function validateRequest(request: QuickChatRequest): void {
  let base: URL;
  try { base = new URL(request.baseUrl); } catch { throw new Error('模型服务地址无效'); }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('模型服务必须使用不含凭据、查询或片段的 HTTPS 地址');
  if (!request.apiKey || !request.model.trim() || !request.messages.length) throw new Error('轻量会话缺少模型、凭据或消息');
}

function endpoint(baseUrl: string, backend: QuickChatBackend): string {
  const base = baseUrl.replace(/\/+$/, '');
  if (backend === 'messages') return `${base.replace(/\/v1$/i, '')}/v1/messages`;
  return `${base}/${backend === 'responses' ? 'responses' : 'chat/completions'}`;
}

function requestBody(request: QuickChatRequest): Record<string, unknown> {
  if (request.backend === 'messages') {
    return {
      model: request.model,
      max_tokens: 4096,
      stream: true,
      system: SYSTEM_INSTRUCTIONS,
      messages: request.messages.map(message => ({ role: message.role, content: anthropicContent(message) })),
    };
  }
  if (request.backend === 'chat_completions') {
    return {
      model: request.model,
      stream: true,
      messages: [
        { role: 'system', content: SYSTEM_INSTRUCTIONS },
        ...request.messages.map(message => ({ role: message.role, content: openAiContent(message) })),
      ],
    };
  }
  return {
    model: request.model,
    store: false,
    stream: true,
    instructions: SYSTEM_INSTRUCTIONS,
    input: request.messages.map(message => ({ role: message.role, content: [
      { type: 'input_text', text: message.text },
      ...(message.role === 'user' ? (message.images ?? []).map(image => ({ type: 'input_image', image_url: image })) : []),
    ] })),
  };
}

function openAiContent(message: QuickChatMessage): string | Array<Record<string, unknown>> {
  if (message.role !== 'user' || !message.images?.length) return message.text;
  return [
    { type: 'text', text: message.text },
    ...message.images.map(image => ({ type: 'image_url', image_url: { url: image } })),
  ];
}

function anthropicContent(message: QuickChatMessage): string | Array<Record<string, unknown>> {
  if (message.role !== 'user' || !message.images?.length) return message.text;
  return [
    { type: 'text', text: message.text },
    ...message.images.map(image => {
      const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(image);
      if (!match) throw new Error('会话图片格式无效');
      return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
    }),
  ];
}

async function readJsonResponse(response: Response, request: QuickChatRequest): Promise<string> {
  const text = await readBoundedText(response, MAX_RESPONSE_BYTES, request.signal);
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('模型返回了无效 JSON'); }
  const output = extractText(value, request.backend);
  if (output) request.onDelta(output);
  return output;
}

async function readEventStream(response: Response, request: QuickChatRequest): Promise<string> {
  if (!response.body) throw new Error('模型返回空响应体');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let bytes = 0;
  let output = '';
  let completed = false;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  request.signal.addEventListener('abort', abort, { once: true });
  const append = (value: string) => {
    if (!value) return;
    if (output.length + value.length > MAX_OUTPUT_CHARS) throw new Error('模型回复超过轻量会话限制');
    output += value;
    request.onDelta(value);
  };
  const consume = (block: string) => {
    const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    if (data.trim() === '[DONE]') { completed = true; return; }
    let event: Record<string, unknown>;
    try { event = JSON.parse(data) as Record<string, unknown>; } catch { throw new Error('模型流式响应格式无效'); }
    if (event.type === 'error' || event.type === 'response.failed' || event.type === 'response.incomplete') throw new Error('模型未能完成本轮回复');
    if (request.backend === 'responses' && event.type === 'response.output_text.delta' && typeof event.delta === 'string') append(event.delta);
    if (request.backend === 'chat_completions') {
      const choices = Array.isArray(event.choices) ? event.choices : [];
      const delta = (choices[0] as { delta?: { content?: unknown } } | undefined)?.delta?.content;
      if (typeof delta === 'string') append(delta);
      else if (Array.isArray(delta)) append(delta.flatMap(part => typeof part?.text === 'string' ? [part.text] : []).join(''));
      if (choices.some(choice => (choice as { finish_reason?: unknown }).finish_reason)) completed = true;
    }
    if (request.backend === 'messages') {
      const delta = event.delta as { type?: string; text?: unknown } | undefined;
      if (event.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string') append(delta.text);
      if (event.type === 'message_stop') completed = true;
    }
    if (request.backend === 'responses' && (event.type === 'response.completed' || event.type === 'response.done')) completed = true;
  };
  try {
    if (request.signal.aborted) throw abortedError();
    while (true) {
      const { done, value } = await reader.read();
      if (done) { buffer += decoder.decode(); break; }
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error('模型响应超过大小限制');
      buffer += decoder.decode(value, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        consume(buffer.slice(0, boundary.index));
        buffer = buffer.slice(boundary.index + boundary[0].length);
      }
      if (completed && request.backend !== 'chat_completions') break;
    }
    if (buffer.trim()) consume(buffer);
    if (request.signal.aborted) throw abortedError();
    if (!completed) throw new Error('模型流在完成事件前中断');
    return output;
  } finally {
    request.signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function extractText(value: unknown, backend: QuickChatBackend): string {
  if (!value || typeof value !== 'object') return '';
  const response = value as Record<string, unknown>;
  if (backend === 'messages') return Array.isArray(response.content) ? response.content.flatMap(item => {
    const text = item && typeof item === 'object' ? (item as { text?: unknown }).text : undefined;
    return typeof text === 'string' ? [text] : [];
  }).join('') : '';
  if (backend === 'chat_completions') {
    const choices = Array.isArray(response.choices) ? response.choices : [];
    const content = (choices[0] as { message?: { content?: unknown } } | undefined)?.message?.content;
    return typeof content === 'string' ? content : Array.isArray(content) ? content.flatMap(item => {
      const text = item && typeof item === 'object' ? (item as { text?: unknown }).text : undefined;
      return typeof text === 'string' ? [text] : [];
    }).join('') : '';
  }
  if (typeof response.output_text === 'string') return response.output_text;
  return Array.isArray(response.output) ? response.output.flatMap(item => {
    const content = (item as { content?: unknown })?.content;
    return Array.isArray(content) ? content.flatMap(part => (part as { type?: string; text?: unknown })?.type === 'output_text' && typeof (part as { text: unknown }).text === 'string' ? [(part as { text: string }).text] : []) : [];
  }).join('') : '';
}

async function readBoundedText(response: Response, limit: number, signal: AbortSignal): Promise<string> {
  if (!response.body) throw new Error('模型返回空响应体');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let result = '';
  let bytes = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) throw abortedError();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new Error('模型响应超过大小限制');
      result += decoder.decode(value, { stream: true });
    }
    result += decoder.decode();
    if (signal.aborted) throw abortedError();
    return result;
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function abortedError(): Error {
  const error = new Error('轻量会话请求已停止');
  error.name = 'AbortError';
  return error;
}
