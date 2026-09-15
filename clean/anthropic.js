const crypto = require('crypto');
const { AppError } = require('./errors');

function textFromBlocks(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content);
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && part.type === 'text') return part.text || '';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content ?? '');
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object') return part.text || part.content || '';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

// Convert an Anthropic content block to an OpenAI content part. Returns null
// for blocks that cannot be represented (thinking, etc. — those are dropped).
function toOpenAiPart(part) {
  if (typeof part === 'string') return { type: 'text', text: part };
  if (!part || typeof part !== 'object') return null;
  if (part.type === 'text') return { type: 'text', text: part.text || '' };
  if (part.type === 'image' && part.source) {
    if (part.source.type === 'base64') {
      return {
        type: 'image_url',
        image_url: { url: `data:${part.source.media_type || 'image/png'};base64,${part.source.data}` },
      };
    }
    if (part.source.type === 'url') {
      return { type: 'image_url', image_url: { url: part.source.url } };
    }
  }
  return null;
}

function validateAnthropicMessagesRequest(body) {
  if (!body || typeof body !== 'object') {
    throw new AppError(400, 'invalid_request', 'Request body must be a JSON object.');
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new AppError(400, 'invalid_request', 'messages must be a non-empty array.');
  }
  for (const message of body.messages) {
    if (!message || typeof message !== 'object') {
      throw new AppError(400, 'invalid_request', 'Each message must be an object.');
    }
    if (!['user', 'assistant', 'system'].includes(message.role)) {
      throw new AppError(400, 'invalid_request', `Unsupported message role: ${message.role}`);
    }
  }
}

// Anthropic Messages request → OpenAI-style upstream messages.
// tool_result blocks become role:'tool' messages; assistant tool_use blocks
// become native tool_calls. Thinking blocks are dropped (transient by nature).
function anthropicToOpenAiMessages(body) {
  const messages = [];
  const system = textFromBlocks(body.system);
  if (system) messages.push({ role: 'system', content: system });

  // A nameless tool_use is uncallable and poisons the upstream for every
  // later request (clients resend full history) — drop it, and drop any
  // tool_result that references it.
  const droppedToolUseIds = new Set();
  for (const message of body.messages) {
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block && block.type === 'tool_use' && !block.name && block.id) {
          droppedToolUseIds.add(block.id);
        }
      }
    }
  }

  for (const message of body.messages) {
    if (typeof message.content === 'string' || message.content == null) {
      messages.push({ role: message.role, content: message.content ?? '' });
      continue;
    }
    if (!Array.isArray(message.content)) {
      messages.push({ role: message.role, content: String(message.content) });
      continue;
    }

    const parts = [];
    const toolCalls = [];
    for (const block of message.content) {
      if (block && block.type === 'tool_result') {
        if (block.tool_use_id && droppedToolUseIds.has(block.tool_use_id)) continue;
        // Flush any accumulated content before emitting tool messages
        if (parts.length) {
          messages.push({ role: message.role, content: parts });
          parts.length = 0;
        }
        messages.push({
          role: 'tool',
          tool_call_id: block.tool_use_id || '',
          content: toolResultText(block.content),
        });
        continue;
      }
      if (block && block.type === 'tool_use') {
        if (!block.name) continue;
        toolCalls.push({
          id: block.id || `toolu_${crypto.randomBytes(12).toString('hex')}`,
          type: 'function',
          function: {
            name: block.name || '',
            arguments: JSON.stringify(block.input || {}),
          },
        });
        continue;
      }
      const part = toOpenAiPart(block);
      if (part) parts.push(part);
    }

    const content = parts.length === 0
      ? (toolCalls.length ? null : '')
      : (parts.every((p) => p.type === 'text') ? parts.map((p) => p.text).join('\n') : parts);
    const out = { role: message.role, content };
    if (toolCalls.length) out.tool_calls = toolCalls;
    // Skip messages that carried only droppable blocks
    if (content !== '' || toolCalls.length) messages.push(out);
  }

  const tools = Array.isArray(body.tools) && body.tools.length
    ? body.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: tool.input_schema || tool.parameters || {},
      },
    }))
    : null;

  return { messages, tools };
}

function mapStopReason(finishReason) {
  if (finishReason === 'tool_calls') return 'tool_use';
  if (finishReason === 'length') return 'max_tokens';
  return 'end_turn';
}

// Buffered upstream completion → Anthropic message JSON.
function createAnthropicMessage({ model, completion }) {
  const content = [];
  if (completion.reasoning) {
    content.push({ type: 'thinking', thinking: completion.reasoning });
  }
  if (completion.content) {
    content.push({ type: 'text', text: completion.content });
  }
  for (const call of completion.toolCalls) {
    let input = {};
    try {
      input = JSON.parse(call.arguments || '{}');
    } catch {
      input = {};
    }
    content.push({
      type: 'tool_use',
      id: call.id || `toolu_${crypto.randomBytes(12).toString('hex')}`,
      name: call.name,
      input,
    });
  }
  return {
    id: `msg_${crypto.randomUUID().replace(/-/g, '')}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: mapStopReason(completion.finishReason),
    stop_sequence: null,
    usage: {
      input_tokens: completion.usage?.prompt_tokens || 0,
      output_tokens: completion.usage?.completion_tokens || 0,
    },
  };
}

function writeAnthropicSse(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

// Streaming converter: OpenAI chat.completion.chunk events → Anthropic SSE.
// Maps reasoning_content → thinking blocks, content → text blocks, and
// streamed tool_calls → tool_use blocks with input_json_delta fragments.
function createAnthropicStreamWriter(res, { model }) {
  const msgId = `msg_${crypto.randomUUID().replace(/-/g, '')}`;
  let started = false;
  let blockIndex = -1;
  let currentBlock = null; // 'thinking' | 'text' | { toolIndex }
  const toolBlockByIndex = new Map();
  // Tool-call deltas can arrive before the function name; buffer them.
  const pendingTools = new Map(); // toolIndex -> { id, name, args: [] }
  let finished = false;

  function start() {
    if (started) return;
    started = true;
    writeAnthropicSse(res, 'message_start', {
      type: 'message_start',
      message: {
        id: msgId,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  function closeBlock() {
    if (currentBlock === null) return;
    writeAnthropicSse(res, 'content_block_stop', { type: 'content_block_stop', index: blockIndex });
    currentBlock = null;
  }

  function openTextualBlock(kind) {
    closeBlock();
    blockIndex += 1;
    currentBlock = kind;
    writeAnthropicSse(res, 'content_block_start', {
      type: 'content_block_start',
      index: blockIndex,
      content_block: kind === 'thinking'
        ? { type: 'thinking', thinking: '' }
        : { type: 'text', text: '' },
    });
  }

  function openToolBlock(toolIndex, pending) {
    closeBlock();
    blockIndex += 1;
    toolBlockByIndex.set(toolIndex, blockIndex);
    writeAnthropicSse(res, 'content_block_start', {
      type: 'content_block_start',
      index: blockIndex,
      content_block: {
        type: 'tool_use',
        id: pending.id || `toolu_${crypto.randomBytes(12).toString('hex')}`,
        name: pending.name,
        input: {},
      },
    });
    currentBlock = { toolIndex };
    for (const args of pending.args) {
      writeAnthropicSse(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'input_json_delta', partial_json: args },
      });
    }
    pending.args.length = 0;
  }

  function finish(finishReason, usage) {
    if (finished) return;
    finished = true;
    start();
    // A tool call that never got a name is uncallable — emitting it with an
    // empty name hard-errors clients, so drop it.
    closeBlock();
    writeAnthropicSse(res, 'message_delta', {
      type: 'message_delta',
      delta: { stop_reason: mapStopReason(finishReason), stop_sequence: null },
      usage: { output_tokens: usage?.completion_tokens || 0 },
    });
    writeAnthropicSse(res, 'message_stop', { type: 'message_stop' });
    res.end();
  }

  function handleChunk(chunk) {
    if (finished) return;
    start();
    const choice = chunk.choices?.[0];
    if (!choice) return; // usage-only chunk
    const delta = choice.delta || {};

    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      if (currentBlock !== 'thinking') openTextualBlock('thinking');
      writeAnthropicSse(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
      });
    }
    if (typeof delta.content === 'string' && delta.content) {
      if (currentBlock !== 'text') openTextualBlock('text');
      writeAnthropicSse(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'text_delta', text: delta.content },
      });
    }
    for (const call of delta.tool_calls || []) {
      const toolIndex = call.index ?? 0;
      let pending = pendingTools.get(toolIndex);
      if (!pending) {
        pending = { id: null, name: null, args: [] };
        pendingTools.set(toolIndex, pending);
      }
      if (call.id) pending.id = call.id;
      if (call.function?.name) pending.name = call.function.name;
      if (!pending.name) {
        // Name not known yet — buffer argument fragments until it arrives.
        if (call.function?.arguments) pending.args.push(call.function.arguments);
        continue;
      }
      if (!toolBlockByIndex.has(toolIndex)) {
        openToolBlock(toolIndex, pending);
      }
      if (call.function?.arguments) {
        writeAnthropicSse(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: toolBlockByIndex.get(toolIndex),
          delta: { type: 'input_json_delta', partial_json: call.function.arguments },
        });
      }
    }
    if (choice.finish_reason) {
      finish(choice.finish_reason, choice.usage || chunk.usage);
    }
  }

  return {
    handleChunk,
    // Called when the upstream stream ends without a finish_reason chunk.
    finalize: () => finish('end_turn', null),
    get finished() { return finished; },
  };
}

function estimateAnthropicInputTokens(body) {
  const text = [
    textFromBlocks(body?.system),
    ...(Array.isArray(body?.messages)
      ? body.messages.map((message) => textFromBlocks(message.content))
      : []),
  ].join('\n');
  return Math.max(1, Math.ceil(text.length / 4));
}

module.exports = {
  anthropicToOpenAiMessages,
  createAnthropicMessage,
  createAnthropicStreamWriter,
  estimateAnthropicInputTokens,
  textFromBlocks,
  validateAnthropicMessagesRequest,
  writeAnthropicSse,
};
