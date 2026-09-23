require('dotenv').config();

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const { anthropicError, openAiError, AppError } = require('./errors');
const { log } = require('./logger');
const qoderApi = require('./qoder-api');
const { DEFAULT_MODEL_ID, MODELS, resolveModelRoute } = require('./models');
const {
  anthropicToOpenAiMessages,
  createAnthropicMessage,
  createAnthropicStreamWriter,
  estimateAnthropicInputTokens,
  validateAnthropicMessagesRequest,
  writeAnthropicSse,
} = require('./anthropic');
const { trackRequest, getUsage, resetUsage, extractTextFromMessages } = require('./usage');

const MODEL_ID = DEFAULT_MODEL_ID;
// Claude Code-style clients resend the full conversation history on every
// request, which easily exceeds 1MB for resumed sessions. Default to 25mb.
const BODY_LIMIT = process.env.QODERCN_BODY_LIMIT || '25mb';
const DEFAULT_TIMEOUT_MS = 300000;

function validateChatRequest(body) {
  if (!body || typeof body !== 'object') {
    throw new AppError(400, 'invalid_request', 'Request body must be a JSON object.');
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new AppError(400, 'invalid_messages', 'messages must be a non-empty array.');
  }
  for (const message of body.messages) {
    if (!message || typeof message !== 'object') {
      throw new AppError(400, 'invalid_messages', 'Each message must be an object.');
    }
    if (!['system', 'user', 'assistant', 'tool'].includes(message.role)) {
      throw new AppError(400, 'unsupported_role', `Unsupported message role: ${message.role}`);
    }
  }
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function extractProviderOption(body, key) {
  return firstDefined(
    body.providerOptions?.['qoder-cn-local']?.[key],
    body.providerOptions?.qoder?.[key],
    body.providerOptions?.openai?.[key],
    body.provider_options?.['qoder-cn-local']?.[key],
    body.provider_options?.qoder?.[key],
    body.provider_options?.openai?.[key],
    body.options?.[key],
    body.modelOptions?.[key],
    body.model_options?.[key]
  );
}

function extractRequestOptions(body) {
  return {
    reasoningEffort: firstDefined(
      body.reasoningEffort,
      body.reasoning_effort,
      body.output_config?.effort,
      body.outputConfig?.effort,
      body.reasoning?.effort,
      body.reasoning?.reasoningEffort,
      body.reasoning?.reasoning_effort,
      extractProviderOption(body, 'reasoningEffort'),
      extractProviderOption(body, 'reasoning_effort')
    ),
    contextWindow: firstDefined(
      body.contextWindow,
      body.context_window,
      extractProviderOption(body, 'contextWindow'),
      extractProviderOption(body, 'context_window')
    ),
    maxOutputTokens: firstDefined(
      body.maxOutputTokens,
      body.max_output_tokens,
      body.max_tokens,
      extractProviderOption(body, 'maxOutputTokens'),
      extractProviderOption(body, 'max_output_tokens'),
      extractProviderOption(body, 'max_tokens')
    ),
  };
}

// Resolve the public model id + request options into upstream call options.
function resolveUpstreamOptions(modelId, requestOptions) {
  const route = resolveModelRoute(modelId);
  // QODERCN_FORCE_EFFORT overrides everything — useful when the client
  // (e.g. Claude Code) clamps the requested effort to a lower value.
  const reasoningEffort = process.env.QODERCN_FORCE_EFFORT
    || requestOptions.reasoningEffort
    || route.reasoningEffort
    || process.env.QODERCN_REASONING_EFFORT
    || undefined;
  const maxOutputTokens = requestOptions.maxOutputTokens
    || (process.env.QODERCN_MAX_OUTPUT_TOKENS ? Number(process.env.QODERCN_MAX_OUTPUT_TOKENS) : undefined)
    || undefined;
  log('resolved server model', { model: modelId, serverModel: route.serverModel });
  return {
    model: route.serverModel,
    reasoningEffort,
    maxOutputTokens,
    contextWindow: requestOptions.contextWindow || undefined,
  };
}

function writeSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

// Convert a buffered completion into a synthetic OpenAI chunk sequence, so
// downstream clients still receive a well-formed SSE stream even though the
// upstream call is buffered (see buildRequestBody for why).
function completionToChunks(completion) {
  const chunks = [{ choices: [{ index: 0, delta: { role: 'assistant' } }] }];
  if (completion.reasoning) {
    chunks.push({ choices: [{ index: 0, delta: { reasoning_content: completion.reasoning } }] });
  }
  if (completion.content) {
    chunks.push({ choices: [{ index: 0, delta: { content: completion.content } }] });
  }
  for (const call of completion.toolCalls) {
    chunks.push({
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: call.index,
            id: call.id || undefined,
            type: 'function',
            function: { name: call.name, arguments: call.arguments },
          }],
        },
      }],
    });
  }
  chunks.push({
    choices: [{ index: 0, delta: {}, finish_reason: completion.finishReason, usage: completion.usage || undefined }],
  });
  return chunks;
}

function sseHeaders(res) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
}

function makeTimeoutSignal(controller) {
  const timeoutMs = Number(process.env.QODERCN_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return () => clearTimeout(timer);
}

function createChatCompletionJson({ model, completion }) {
  const message = { role: 'assistant', content: completion.content || null };
  if (completion.toolCalls.length) {
    message.tool_calls = completion.toolCalls.map((call) => ({
      id: call.id || `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
      type: 'function',
      function: { name: call.name, arguments: call.arguments || '{}' },
    }));
  }
  return {
    id: completion.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: completion.finishReason || 'stop',
      },
    ],
    usage: {
      prompt_tokens: completion.usage?.prompt_tokens || 0,
      completion_tokens: completion.usage?.completion_tokens || 0,
      total_tokens: completion.usage?.total_tokens
        || (completion.usage?.prompt_tokens || 0) + (completion.usage?.completion_tokens || 0),
    },
  };
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: true }));
  app.use(express.json({ limit: BODY_LIMIT }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/', (_req, res) => {
    const backend = qoderApi.getBackend();
    res.json({
      ok: true,
      name: 'qoder-proxy',
      mode: 'direct',
      cli_backend: backend.name,
      model_host: backend.modelHost,
      auth_home: backend.authDir,
    });
  });

  app.get('/v1/models', (_req, res) => {
    res.json({
      object: 'list',
      data: MODELS.map((model) => ({
        id: model.id,
        object: 'model',
        created: 0,
        owned_by: 'qoder',
        name: model.name,
        capabilities: {
          reasoning: model.reasoning || false,
        },
        ...(model.effortAlias ? { effort_alias: true } : {}),
      })),
    });
  });

  app.post('/v1/chat/completions', async (req, res) => {
    const started = Date.now();
    const controller = new AbortController();
    req.on('aborted', () => controller.abort());
    const clearTimer = makeTimeoutSignal(controller);

    try {
      validateChatRequest(req.body);
      const model = req.body.model || MODEL_ID;
      const requestOptions = extractRequestOptions(req.body);
      const upstream = resolveUpstreamOptions(model, requestOptions);
      log('chat request accepted', {
        model,
        message_count: req.body.messages.length,
        stream: Boolean(req.body.stream),
        tool_count: Array.isArray(req.body.tools) ? req.body.tools.length : 0,
        reasoning_effort: upstream.reasoningEffort,
      });

      const callOptions = {
        messages: req.body.messages,
        tools: Array.isArray(req.body.tools) ? req.body.tools : null,
        signal: controller.signal,
        rootDir: process.cwd(),
        ...upstream,
      };

      if (req.body.stream) {
        sseHeaders(res);
        try {
          const completion = await qoderApi.chatCompletion(callOptions);
          const created = Math.floor(Date.now() / 1000);
          for (const chunk of completionToChunks(completion)) {
            writeSse(res, {
              id: completion.id,
              object: 'chat.completion.chunk',
              created,
              model,
              ...chunk,
            });
          }
          res.write('data: [DONE]\n\n');
          res.end();
        } catch (streamError) {
          if (!res.writableEnded) {
            try {
              writeSse(res, {
                error: {
                  message: streamError.message || 'Upstream request failed.',
                  type: streamError.code || 'api_error',
                },
              });
              res.write('data: [DONE]\n\n');
              res.end();
            } catch { /* ignore */ }
          }
          log('chat stream failed', {
            code: streamError.code || 'internal_error',
            status: streamError.status || 500,
            duration_ms: Date.now() - started,
            message: streamError.message,
          });
          return;
        }
        log('chat stream completed', { duration_ms: Date.now() - started });
        trackRequest({
          model,
          inputText: extractTextFromMessages(req.body.messages),
          outputText: '',
          isError: false,
        });
        return;
      }

      const completion = await qoderApi.chatCompletion(callOptions);
      res.json(createChatCompletionJson({ model, completion }));
      log('chat request completed', { duration_ms: Date.now() - started });
      trackRequest({
        model,
        inputText: extractTextFromMessages(req.body.messages),
        outputText: completion.content || '',
        isError: false,
        usage: completion.usage,
      });
    } catch (error) {
      log('chat request failed', {
        code: error.code || 'internal_error',
        status: error.status || 500,
        duration_ms: Date.now() - started,
        message: error.message,
      });
      trackRequest({
        model: req.body?.model || MODEL_ID,
        inputText: extractTextFromMessages(req.body?.messages),
        outputText: '',
        isError: true,
      });
      if (!res.headersSent && !res.writableEnded) openAiError(res, error);
    } finally {
      clearTimer();
    }
  });

  app.post('/v1/messages', async (req, res) => {
    const started = Date.now();
    const controller = new AbortController();
    req.on('aborted', () => controller.abort());
    const clearTimer = makeTimeoutSignal(controller);

    try {
      validateAnthropicMessagesRequest(req.body);
      const model = req.body.model || MODEL_ID;
      const requestOptions = extractRequestOptions(req.body);
      if (!requestOptions.maxOutputTokens && req.body.max_tokens) {
        requestOptions.maxOutputTokens = req.body.max_tokens;
      }
      const upstream = resolveUpstreamOptions(model, requestOptions);
      const { messages, tools } = anthropicToOpenAiMessages(req.body);
      log('anthropic message request accepted', {
        model,
        message_count: req.body.messages.length,
        stream: Boolean(req.body.stream),
        tool_count: tools ? tools.length : 0,
        reasoning_effort: upstream.reasoningEffort,
      });

      const callOptions = {
        messages,
        tools,
        signal: controller.signal,
        rootDir: process.cwd(),
        ...upstream,
      };

      if (req.body.stream) {
        sseHeaders(res);
        const writer = createAnthropicStreamWriter(res, { model });
        try {
          const completion = await qoderApi.chatCompletion(callOptions);
          for (const chunk of completionToChunks(completion)) {
            writer.handleChunk(chunk);
          }
          writer.finalize();
        } catch (streamError) {
          if (!res.writableEnded) {
            try {
              if (writer.finished) {
                res.end();
              } else {
                writeAnthropicSse(res, 'error', {
                  type: 'error',
                  error: {
                    type: streamError.type || 'api_error',
                    message: streamError.message || 'Upstream request failed.',
                  },
                });
                res.end();
              }
            } catch { /* ignore */ }
          }
          log('anthropic stream failed', {
            code: streamError.code || 'internal_error',
            status: streamError.status || 500,
            duration_ms: Date.now() - started,
            message: streamError.message,
          });
          return;
        }
        log('anthropic stream completed', { duration_ms: Date.now() - started });
        trackRequest({
          model,
          inputText: extractTextFromMessages(req.body.messages),
          outputText: '',
          isError: false,
        });
        return;
      }

      const completion = await qoderApi.chatCompletion(callOptions);
      res.json(createAnthropicMessage({ model, completion }));
      log('anthropic message request completed', { duration_ms: Date.now() - started });
      trackRequest({
        model,
        inputText: extractTextFromMessages(req.body.messages),
        outputText: completion.content || '',
        isError: false,
        usage: completion.usage,
      });
    } catch (error) {
      log('anthropic message request failed', {
        code: error.code || 'internal_error',
        status: error.status || 500,
        duration_ms: Date.now() - started,
        message: error.message,
      });
      trackRequest({
        model: req.body?.model || MODEL_ID,
        inputText: extractTextFromMessages(req.body?.messages),
        outputText: '',
        isError: true,
      });
      if (!res.headersSent && !res.writableEnded) anthropicError(res, error);
    } finally {
      clearTimer();
    }
  });

  app.post('/v1/messages/count_tokens', (req, res) => {
    try {
      res.json({ input_tokens: estimateAnthropicInputTokens(req.body) });
    } catch (error) {
      anthropicError(res, error);
    }
  });

  // --- Usage / Credits API ---
  app.get('/usage/local', (_req, res) => {
    res.json(getUsage());
  });

  app.post('/usage/reset-local', (_req, res) => {
    resetUsage();
    res.json({ ok: true });
  });

  // --- Static Web Console at /ui ---
  const publicDir = path.join(__dirname, '..', 'public');

  // Redirect /ui → /ui/ so relative asset paths resolve correctly in the browser
  app.use('/ui', (req, res, next) => {
    if (req.originalUrl === '/ui' || req.originalUrl === '/ui?') {
      return res.redirect(301, '/ui/');
    }
    next();
  });

  // Serve /ui/ → index.html, and static assets under /ui/*
  app.get('/ui/', (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  app.use('/ui', express.static(publicDir));

  app.use((_req, res) => {
    openAiError(res, new AppError(404, 'not_found', 'Route not found.'));
  });

  app.use((error, req, res, _next) => {
    // Body-parse failures (e.g. 413) land here before any route runs —
    // answer in Anthropic shape for Anthropic routes so clients like
    // Claude Code can display the real error message.
    if (req.path && req.path.startsWith('/v1/messages')) {
      anthropicError(res, error);
      return;
    }
    openAiError(res, error);
  });

  return app;
}

module.exports = {
  MODEL_ID,
  createApp,
  extractRequestOptions,
  resolveUpstreamOptions,
  validateChatRequest,
};
