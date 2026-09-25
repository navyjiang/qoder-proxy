const test = require('node:test');
const assert = require('node:assert/strict');
const {
  anthropicToOpenAiMessages,
  createAnthropicMessage,
  createAnthropicStreamWriter,
  validateAnthropicMessagesRequest,
} = require('../clean/anthropic');

test('system prompt becomes a system message', () => {
  const { messages } = anthropicToOpenAiMessages({
    system: [{ type: 'text', text: 'Be terse.' }],
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.deepEqual(messages, [
    { role: 'system', content: 'Be terse.' },
    { role: 'user', content: 'hi' },
  ]);
});

test('tool_use blocks become native tool_calls on the assistant message', () => {
  const { messages } = anthropicToOpenAiMessages({
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me read it.' },
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/x' } },
        ],
      },
    ],
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'assistant');
  assert.equal(messages[0].content, 'Let me read it.');
  assert.deepEqual(messages[0].tool_calls, [
    { id: 'toolu_1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"/tmp/x"}' } },
  ]);
});

test('tool_result blocks become role:tool messages', () => {
  const { messages } = anthropicToOpenAiMessages({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'file contents' },
          { type: 'text', text: 'what does it say?' },
        ],
      },
    ],
  });
  assert.deepEqual(messages, [
    { role: 'tool', tool_call_id: 'toolu_1', content: 'file contents' },
    { role: 'user', content: 'what does it say?' },
  ]);
});

test('base64 images become image_url data URLs', () => {
  const { messages } = anthropicToOpenAiMessages({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
        ],
      },
    ],
  });
  assert.deepEqual(messages[0].content, [
    { type: 'text', text: 'what is this?' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
  ]);
});

test('thinking blocks in history are dropped', () => {
  const { messages } = anthropicToOpenAiMessages({
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'answer' },
        ],
      },
    ],
  });
  assert.deepEqual(messages, [{ role: 'assistant', content: 'answer' }]);
});

test('anthropic tools map to OpenAI function tools', () => {
  const { tools } = anthropicToOpenAiMessages({
    tools: [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.deepEqual(tools, [
    { type: 'function', function: { name: 'Read', description: 'Read a file', parameters: { type: 'object' } } },
  ]);
});

test('createAnthropicMessage renders text + tool_use blocks', () => {
  const message = createAnthropicMessage({
    model: 'kimi-k3',
    completion: {
      id: 'chatcmpl-x',
      content: 'Reading the file.',
      reasoning: '',
      toolCalls: [{ id: 'call_1', name: 'Read', arguments: '{"file_path":"/tmp/x"}' }],
      finishReason: 'tool_calls',
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    },
  });
  assert.equal(message.stop_reason, 'tool_use');
  assert.deepEqual(message.content[0], { type: 'text', text: 'Reading the file.' });
  assert.equal(message.content[1].type, 'tool_use');
  assert.equal(message.content[1].name, 'Read');
  assert.deepEqual(message.content[1].input, { file_path: '/tmp/x' });
  assert.deepEqual(message.usage, { input_tokens: 10, output_tokens: 5 });
});

test('createAnthropicMessage renders reasoning as a thinking block', () => {
  const message = createAnthropicMessage({
    model: 'kimi-k3',
    completion: {
      content: 'answer',
      reasoning: 'let me think',
      toolCalls: [],
      finishReason: 'stop',
      usage: null,
    },
  });
  assert.deepEqual(message.content, [
    { type: 'thinking', thinking: 'let me think' },
    { type: 'text', text: 'answer' },
  ]);
  assert.equal(message.stop_reason, 'end_turn');
});

function collectWrites() {
  const chunks = [];
  return {
    res: {
      write: (chunk) => chunks.push(chunk),
      end: () => {},
    },
    text: () => chunks.join(''),
  };
}

test('stream writer maps OpenAI chunks to Anthropic SSE', () => {
  const { res, text } = collectWrites();
  const writer = createAnthropicStreamWriter(res, { model: 'kimi-k3' });

  writer.handleChunk({ choices: [{ index: 0, delta: { role: 'assistant' } }] });
  writer.handleChunk({ choices: [{ index: 0, delta: { reasoning_content: 'thinking ' } }] });
  writer.handleChunk({ choices: [{ index: 0, delta: { reasoning_content: 'more' } }] });
  writer.handleChunk({ choices: [{ index: 0, delta: { content: 'Hello' } }] });
  writer.handleChunk({
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'Read', arguments: '' } }] } }],
  });
  writer.handleChunk({
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"file_path":' } }] } }],
  });
  writer.handleChunk({
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    usage: { completion_tokens: 42 },
  });

  const out = text();
  assert.match(out, /event: message_start/);
  assert.match(out, /"type":"thinking","thinking":""/);
  assert.match(out, /"type":"thinking_delta","thinking":"thinking "/);
  assert.match(out, /"type":"text","text":""/);
  assert.match(out, /"type":"text_delta","text":"Hello"/);
  assert.match(out, /"type":"tool_use","id":"call_1","name":"Read"/);
  assert.match(out, /"type":"input_json_delta","partial_json":"\{\\"file_path\\":"/);
  assert.match(out, /"stop_reason":"tool_use"/);
  assert.match(out, /"output_tokens":42/);
  assert.match(out, /event: message_stop/);
  assert.equal(writer.finished, true);
});

test('stream writer reports real input_tokens from upstream usage', () => {
  const { res, text } = collectWrites();
  const writer = createAnthropicStreamWriter(res, {
    model: 'kimi-k3',
    usage: { prompt_tokens: 36109, completion_tokens: 240 },
  });

  writer.handleChunk({ choices: [{ index: 0, delta: { content: 'Hi' } }] });
  writer.handleChunk({
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 36109, completion_tokens: 240 },
  });

  const out = text();
  // message_start must carry real input_tokens so the client's context
  // indicator doesn't render 0%.
  assert.match(out, /message_start[\s\S]*"input_tokens":36109/);
  assert.match(out, /message_delta[\s\S]*"input_tokens":36109,"output_tokens":240|"output_tokens":240,"input_tokens":36109/);
});

test('stream writer finalizes cleanly when upstream ends without finish_reason', () => {
  const { res, text } = collectWrites();
  const writer = createAnthropicStreamWriter(res, { model: 'kimi-k3' });
  writer.handleChunk({ choices: [{ index: 0, delta: { content: 'partial' } }] });
  writer.finalize();
  const out = text();
  assert.match(out, /"stop_reason":"end_turn"/);
  assert.match(out, /event: message_stop/);
});

test('stream writer buffers tool calls until the function name arrives', () => {
  const { res, text } = collectWrites();
  const writer = createAnthropicStreamWriter(res, { model: 'kimi-k3' });

  // id-only chunk first, then an arguments fragment, then the name
  writer.handleChunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function' }] } }] });
  writer.handleChunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":' } }] } }] });
  writer.handleChunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'Read' } }] } }] });
  writer.handleChunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }] });
  writer.handleChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });

  const out = text();
  // The tool_use block must not open before the name chunk
  const startIdx = out.indexOf('"type":"tool_use"');
  const firstArgsIdx = out.indexOf('"partial_json":"{\\"a\\":"');
  const secondArgsIdx = out.indexOf('"partial_json":"1}"');
  assert.ok(startIdx !== -1);
  assert.ok(firstArgsIdx > startIdx, 'buffered args flush after block start');
  assert.ok(secondArgsIdx > firstArgsIdx, 'later args stream after buffered ones');
  assert.match(out, /"type":"tool_use","id":"call_1","name":"Read"/);
  assert.match(out, /"stop_reason":"tool_use"/);
});

test('validateAnthropicMessagesRequest rejects invalid bodies', () => {
  assert.throws(() => validateAnthropicMessagesRequest(null));
  assert.throws(() => validateAnthropicMessagesRequest({ messages: [] }));
  assert.throws(() => validateAnthropicMessagesRequest({ messages: [{ role: 'nope', content: 'x' }] }));
});
