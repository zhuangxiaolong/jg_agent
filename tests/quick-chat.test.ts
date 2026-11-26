import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quickChatHistory, streamQuickChat, type QuickChatBackend } from '../apps/desktop/src/main/quick-chat';

test('quick chat retains recent complete turns and combines streamed assistant events', () => {
  const history = quickChatHistory([
    { type: 'user', text: '旧问题' },
    { type: 'delta', text: '旧答复' },
    { type: 'message', text: '旧答复' },
    { type: 'user', text: '新问题' },
    { type: 'message', text: '新答复' },
  ]);

  assert.deepEqual(history, [
    { role: 'user', text: '旧问题' },
    { role: 'assistant', text: '旧答复' },
    { role: 'user', text: '新问题' },
    { role: 'assistant', text: '新答复' },
  ]);
});

test('quick chat sends a Responses request and consumes CRLF SSE across chunk boundaries', async () => {
  let requestedUrl = '';
  let requestedBody: Record<string, unknown> | undefined;
  const encoder = new TextEncoder();
  const chunks = [
    'event: response.output_text.delta\r',
    '\ndata: {"type":"response.output_text.delta","delta":"你好"}\r\n\r\n',
    'data: {"type":"response.completed"}\r\n\r\n',
  ];
  const fetcher: typeof fetch = async (input, init) => {
    requestedUrl = String(input);
    requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }), { headers: { 'content-type': 'text/event-stream' } });
  };
  const deltas: string[] = [];
  const output = await streamQuickChat({
    baseUrl: 'https://relay.example/v1', apiKey: 'secret', model: 'model-a', backend: 'responses',
    messages: [{ role: 'user', text: '你好' }, { role: 'assistant', text: '你好呀' }, { role: 'user', text: '继续' }], signal: new AbortController().signal,
    onDelta: text => deltas.push(text), fetcher,
  });

  assert.equal(requestedUrl, 'https://relay.example/v1/responses');
  assert.equal(requestedBody?.model, 'model-a');
  assert.deepEqual(requestedBody?.input, [
    { role: 'user', content: [{ type: 'input_text', text: '你好' }] },
    { role: 'assistant', content: [{ type: 'output_text', text: '你好呀' }] },
    { role: 'user', content: [{ type: 'input_text', text: '继续' }] },
  ]);
  assert.equal(requestedBody?.stream, true);
  assert.equal(output, '你好');
  assert.deepEqual(deltas, ['你好']);
});

test('quick chat maps each backend to its endpoint and message format', async () => {
  const cases: Array<{ backend: QuickChatBackend; baseUrl: string; endpoint: string; response: unknown }> = [
    { backend: 'chat_completions', baseUrl: 'https://relay.example/v1', endpoint: 'https://relay.example/v1/chat/completions', response: { choices: [{ message: { content: '完成' } }] } },
    { backend: 'messages', baseUrl: 'https://relay.example/v1', endpoint: 'https://relay.example/v1/messages', response: { content: [{ type: 'text', text: '完成' }] } },
  ];
  for (const item of cases) {
    let requestedUrl = '';
    let requestedBody: Record<string, unknown> | undefined;
    const fetcher: typeof fetch = async (input, init) => {
      requestedUrl = String(input);
      requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify(item.response), { headers: { 'content-type': 'application/json' } });
    };
    const output = await streamQuickChat({
      baseUrl: item.baseUrl, apiKey: 'secret', model: 'model-b', backend: item.backend,
      messages: [{ role: 'user', text: '开始' }], signal: new AbortController().signal, onDelta: () => {}, fetcher,
    });
    assert.equal(requestedUrl, item.endpoint);
    assert.equal(requestedBody?.stream, true);
    assert.equal(output, '完成');
  }
});
