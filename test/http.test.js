const test = require('node:test');
const assert = require('node:assert/strict');
const qoderApi = require('../clean/qoder-api');
const { AppError } = require('../clean/errors');
const { createApp, extractRequestOptions, resolveUpstreamOptions } = require('../clean/app');

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

const originalCompletion = qoderApi.chatCompletion;

function restore() {
  qoderApi.chatCompletion = originalCompletion;
}

function makeCompletion(overrides = {}) {
  return {
    id: 'chatcmpl-t',
    model: 'kmodel_latest',
    content: '',
    reasoning: '',
    toolCalls: [],
    finishReason: 'stop',
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    ...overrides,
  };
}

test('health and models endpoints work', async () => {
  const { server, baseUrl } = await listen(createApp());
  try {
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const models = await fetch(`${baseUrl}/v1/models`);
    assert.equal(models.status, 200);
    const body = await models.json();
    assert.equal(body.object, 'list');
    assert.equal(body.data.some((model) => model.id === 'kimi-k3'), true);
    assert.equal(body.data.some((model) => model.id === 'kimi-k3-effort-high'), true);
  } finally {
    server.close();
  }
});

test('OpenAI streaming forwards synthesized chunks with the public model id', async () => {
  qoderApi.chatCompletion = async () => makeCompletion({ content: 'Hello world' });
  const { server, baseUrl } = await listen(createApp());
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'kimi-k3', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const text = await response.text();
    assert.match(text, /"content":"Hello world"/);
    assert.match(text, /"model":"kimi-k3"/);
    assert.equal(text.includes('kmodel_latest'), false);
    assert.match(text, /"finish_reason":"stop"/);
    assert.match(text, /data: \[DONE\]/);
  } finally {
    restore();
    server.close();
  }
});

test('OpenAI non-streaming assembles tool_calls from the completion', async () => {
  qoderApi.chatCompletion = async () => ({
    id: 'chatcmpl-t',
    model: 'kmodel_latest',
    content: '',
    reasoning: '',
    toolCalls: [{ id: 'call_1', name: 'Read', arguments: '{"file_path":"/tmp/x"}' }],
    finishReason: 'tool_calls',
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
  const { server, baseUrl } = await listen(createApp());
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'kimi-k3',
        messages: [{ role: 'user', content: 'read /tmp/x' }],
        tools: [{ type: 'function', function: { name: 'Read', description: 'Read', parameters: { type: 'object' } } }],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.object, 'chat.completion');
    assert.equal(body.model, 'kimi-k3');
    assert.equal(body.choices[0].finish_reason, 'tool_calls');
    assert.equal(body.choices[0].message.tool_calls[0].function.name, 'Read');
    assert.equal(body.choices[0].message.tool_calls[0].function.arguments, '{"file_path":"/tmp/x"}');
    assert.deepEqual(body.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  } finally {
    restore();
    server.close();
  }
});

test('Anthropic streaming converts a buffered completion to Anthropic SSE', async () => {
  qoderApi.chatCompletion = async () => makeCompletion({
    content: 'Let me read.',
    reasoning: 'hmm',
    toolCalls: [{ id: 'call_1', name: 'Read', arguments: '{"file_path":"/tmp/x"}', index: 0 }],
    finishReason: 'tool_calls',
    usage: { prompt_tokens: 3, completion_tokens: 9, total_tokens: 12 },
  });
  const { server, baseUrl } = await listen(createApp());
  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'kimi-k3',
        max_tokens: 1024,
        stream: true,
        tools: [{ name: 'Read', description: 'Read', input_schema: { type: 'object' } }],
        messages: [{ role: 'user', content: 'read /tmp/x' }],
      }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /event: message_start/);
    assert.match(text, /"type":"thinking_delta","thinking":"hmm"/);
    assert.match(text, /"type":"text_delta","text":"Let me read\."/);
    assert.match(text, /"type":"tool_use","id":"call_1","name":"Read"/);
    assert.match(text, /"type":"input_json_delta","partial_json":"\{\\"file_path\\":\\"\/tmp\/x\\"\}"/);
    assert.match(text, /"stop_reason":"tool_use"/);
    assert.match(text, /"output_tokens":9/);
    assert.match(text, /event: message_stop/);
  } finally {
    restore();
    server.close();
  }
});

test('Anthropic non-streaming returns message JSON with tool_use blocks', async () => {
  qoderApi.chatCompletion = async () => ({
    id: 'chatcmpl-t',
    model: 'kmodel_latest',
    content: 'Reading it.',
    reasoning: '',
    toolCalls: [{ id: 'call_9', name: 'Read', arguments: '{"file_path":"/tmp/x"}' }],
    finishReason: 'tool_calls',
    usage: { prompt_tokens: 3, completion_tokens: 9, total_tokens: 12 },
  });
  const { server, baseUrl } = await listen(createApp());
  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'kimi-k3',
        max_tokens: 1024,
        tools: [{ name: 'Read', description: 'Read', input_schema: { type: 'object' } }],
        messages: [{ role: 'user', content: 'read /tmp/x' }],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.type, 'message');
    assert.equal(body.stop_reason, 'tool_use');
    assert.deepEqual(body.content[0], { type: 'text', text: 'Reading it.' });
    assert.equal(body.content[1].type, 'tool_use');
    assert.equal(body.content[1].id, 'call_9');
    assert.deepEqual(body.content[1].input, { file_path: '/tmp/x' });
    assert.deepEqual(body.usage, { input_tokens: 3, output_tokens: 9 });
  } finally {
    restore();
    server.close();
  }
});

test('upstream errors surface as an Anthropic SSE error event', async () => {
  qoderApi.chatCompletion = async () => {
    throw new AppError(502, 'upstream_error', 'model server exploded');
  };
  const { server, baseUrl } = await listen(createApp());
  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'kimi-k3',
        max_tokens: 32,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /event: error/);
    assert.match(text, /model server exploded/);
  } finally {
    restore();
    server.close();
  }
});

test('upstream errors on non-streaming return an OpenAI error body', async () => {
  qoderApi.chatCompletion = async () => {
    throw new AppError(401, 'cli_token_missing', 'No stored Qoder credentials found.', 'authentication_error');
  };
  const { server, baseUrl } = await listen(createApp());
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.match(body.error.message, /No stored Qoder credentials/);
  } finally {
    restore();
    server.close();
  }
});

test('tool role messages and assistant tool_calls history are accepted', async () => {
  let captured;
  qoderApi.chatCompletion = async (options) => {
    captured = options;
    return {
      id: 'chatcmpl-t', model: 'kmodel_latest', content: 'done', reasoning: '',
      toolCalls: [], finishReason: 'stop', usage: null,
    };
  };
  const { server, baseUrl } = await listen(createApp());
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'user', content: 'read file' },
          { role: 'assistant', content: '', tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'Read', arguments: '{"path":"/tmp/x"}' } }] },
          { role: 'tool', tool_call_id: 'call_x', content: 'file contents here' },
          { role: 'user', content: 'what was in the file?' },
        ],
      }),
    });
    assert.equal(response.status, 200);
    // Messages are forwarded natively — no prompt re-serialization
    assert.equal(captured.messages.length, 4);
    assert.equal(captured.messages[2].role, 'tool');
    assert.equal(captured.messages[2].tool_call_id, 'call_x');
  } finally {
    restore();
    server.close();
  }
});

test('anthropic tool_use/tool_result history converts to native OpenAI messages', async () => {
  let captured;
  qoderApi.chatCompletion = async (options) => {
    captured = options;
    return {
      id: 'chatcmpl-t', model: 'kmodel_latest', content: 'It says hello.', reasoning: '',
      toolCalls: [], finishReason: 'stop', usage: null,
    };
  };
  const { server, baseUrl } = await listen(createApp());
  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'kimi-k3',
        max_tokens: 32,
        messages: [
          { role: 'user', content: 'read /tmp/x' },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/x' } }],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'hello' }],
          },
        ],
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(captured.messages[1].tool_calls[0].function.name, 'Read');
    assert.deepEqual(captured.messages[2], { role: 'tool', tool_call_id: 'toolu_1', content: 'hello' });
  } finally {
    restore();
    server.close();
  }
});

test('anthropic count_tokens returns an approximate input token count', async () => {
  const { server, baseUrl } = await listen(createApp());
  try {
    const response = await fetch(`${baseUrl}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'kimi-k3',
        messages: [{ role: 'user', content: 'hello world' }],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(typeof body.input_tokens, 'number');
    assert.equal(body.input_tokens > 0, true);
  } finally {
    server.close();
  }
});

test('extracts OpenCode and OpenAI-compatible model options', () => {
  assert.deepEqual(
    extractRequestOptions({
      reasoningEffort: 'high',
      contextWindow: 200000,
      maxOutputTokens: 4096,
    }),
    {
      reasoningEffort: 'high',
      contextWindow: 200000,
      maxOutputTokens: 4096,
    }
  );

  assert.deepEqual(
    extractRequestOptions({
      reasoning_effort: 'low',
      context_window: 64000,
      max_tokens: 1024,
    }),
    {
      reasoningEffort: 'low',
      contextWindow: 64000,
      maxOutputTokens: 1024,
    }
  );

  assert.equal(
    extractRequestOptions({
      providerOptions: {
        'qoder-cn-local': {
          reasoningEffort: 'max',
        },
      },
    }).reasoningEffort,
    'max'
  );

  // Claude Code sends its effortLevel setting as output_config.effort
  assert.equal(
    extractRequestOptions({
      output_config: { effort: 'high' },
    }).reasoningEffort,
    'high'
  );
});

test('QODERCN_FORCE_EFFORT overrides client-sent effort', () => {
  const original = process.env.QODERCN_FORCE_EFFORT;
  try {
    // Without force: client-sent effort (Claude Code clamps to 'high') is respected
    delete process.env.QODERCN_FORCE_EFFORT;
    assert.equal(
      resolveUpstreamOptions('kimi-k3', { reasoningEffort: 'high' }).reasoningEffort,
      'high'
    );

    // With force: overrides whatever the client sent
    process.env.QODERCN_FORCE_EFFORT = 'max';
    assert.equal(
      resolveUpstreamOptions('kimi-k3', { reasoningEffort: 'high' }).reasoningEffort,
      'max'
    );

    // Force also wins when the client sent nothing
    assert.equal(
      resolveUpstreamOptions('kimi-k3', {}).reasoningEffort,
      'max'
    );

    // Force wins over model suffix effort too
    assert.equal(
      resolveUpstreamOptions('kimi-k3-effort-low', { reasoningEffort: 'high' }).reasoningEffort,
      'max'
    );
  } finally {
    if (original === undefined) {
      delete process.env.QODERCN_FORCE_EFFORT;
    } else {
      process.env.QODERCN_FORCE_EFFORT = original;
    }
  }
});
