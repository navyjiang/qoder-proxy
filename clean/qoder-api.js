// Direct client for the Qoder model server (OpenAI-compatible chat
// completions with native tool calling), replacing the qodercli subprocess.
//
// Auth: the CLI's own credential store (~/.qoder/.auth/user or
// ~/.qoderworkcn/.auth/user) is decrypted with the auth wasm extracted from
// the installed CLI bundle. Expired tokens are refreshed through the openapi
// deviceToken endpoint and written back to the credential store.

const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');
const { once } = require('events');
const crypto = require('crypto');
const { AppError } = require('./errors');
const { log } = require('./logger');
const { redactString } = require('./redact');
const { extractAuthWasm, loadAuthWasm, resolveCliBundlePath } = require('./auth-wasm');

const BACKENDS = {
  global: {
    cliCommand: 'qodercli',
    modelHost: 'api2-v2.qoder.sh',
    openapiBase: 'https://openapi.qoder.sh',
    authDir: '.qoder',
  },
  cn: {
    cliCommand: 'qoderclicn',
    modelHost: 'api2-v2.qoder.com.cn',
    openapiBase: 'https://openapi.qoder.com.cn',
    authDir: '.qoderworkcn',
  },
};

const TOKEN_REFRESH_MARGIN_MS = 60 * 1000;

// The model server's gateway rejects request bodies larger than 256 KiB with
// an opaque HTTP 500 (measured: 262,134 bytes succeeds, 262,284 fails). Fail
// fast with a clear error instead — 1 KiB margin for measurement noise.
const MAX_UPSTREAM_BODY_BYTES = Number(process.env.QODERCN_MAX_BODY_BYTES) || 262144 - 1024;

function getBackend() {
  const name = (process.env.CLI_BACKEND || 'cn').toLowerCase() === 'global' ? 'global' : 'cn';
  return { name, ...BACKENDS[name] };
}

function proxyUrlForHost(host) {
  const noProxy = (process.env.NO_PROXY || process.env.no_proxy || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (noProxy.some((entry) => entry === '*' || host === entry || host.endsWith(entry.startsWith('.') ? entry : `.${entry}`))) {
    return null;
  }
  const raw = process.env.HTTPS_PROXY || process.env.https_proxy || '';
  return raw ? raw : null;
}

function rawConnectThroughProxy(proxyUrl, targetHost) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(/^https?:\/\//i.test(proxyUrl) ? proxyUrl : `http://${proxyUrl}`);
    } catch {
      reject(new Error(`invalid HTTPS_PROXY: ${proxyUrl}`));
      return;
    }
    const socket = net.connect({ host: parsed.hostname, port: Number(parsed.port) || 8080 });
    let head = `CONNECT ${targetHost}:443 HTTP/1.1\r\nHost: ${targetHost}:443\r\n`;
    if (parsed.username) {
      const auth = Buffer.from(`${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`).toString('base64');
      head += `Proxy-Authorization: Basic ${auth}\r\n`;
    }
    head += '\r\n';

    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString('latin1');
      if (!buffer.includes('\r\n\r\n')) return;
      socket.removeListener('data', onData);
      const statusLine = buffer.slice(0, buffer.indexOf('\r\n'));
      const match = statusLine.match(/HTTP\/\d(?:\.\d)?\s+(\d+)/);
      if (!match || match[1] !== '200') {
        socket.destroy();
        reject(new Error(`proxy CONNECT failed: ${statusLine}`));
        return;
      }
      resolve(socket);
    };
    socket.on('data', onData);
    socket.on('error', reject);
    socket.write(head);
  });
}

// Parse the response head, then expose the body as an async generator that
// handles both chunked and content-length/close-delimited bodies.
async function readResponse(socket, iterator) {
  let buffer = Buffer.alloc(0);
  let statusLine = '';
  let headers = {};

  for (;;) {
    const idx = buffer.indexOf('\r\n\r\n');
    if (idx !== -1) {
      const headText = buffer.slice(0, idx).toString('latin1');
      const lines = headText.split('\r\n');
      statusLine = lines[0];
      headers = {};
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(':');
        if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
      buffer = buffer.slice(idx + 4);
      const statusCode = Number(statusLine.split(' ')[1]);
      if (statusCode === 100) continue; // interim response — read the final head
      return { statusCode, headers, body: readBody(iterator, headers, buffer) };
    }
    const { done, value } = await iterator.next();
    if (done) throw new Error('connection closed before response headers');
    buffer = Buffer.concat([buffer, value]);
  }
}

async function* readBody(iterator, headers, leftover) {
  const chunked = /chunked/i.test(headers['transfer-encoding'] || '');
  if (!chunked) {
    if (leftover.length) yield leftover;
    for (;;) {
      const { done, value } = await iterator.next();
      if (done) return;
      yield value;
    }
  }

  let rest = leftover;
  for (;;) {
    let idx = rest.indexOf('\r\n');
    while (idx === -1) {
      const { done, value } = await iterator.next();
      if (done) return;
      rest = Buffer.concat([rest, value]);
      idx = rest.indexOf('\r\n');
    }
    const size = parseInt(rest.slice(0, idx).toString('latin1'), 16);
    if (!Number.isFinite(size)) return;
    rest = rest.slice(idx + 2);
    if (size === 0) return; // trailers follow; irrelevant for SSE
    while (rest.length < size + 2) {
      const { done, value } = await iterator.next();
      if (done) return;
      rest = Buffer.concat([rest, value]);
    }
    yield rest.slice(0, size);
    rest = rest.slice(size + 2);
  }
}

// Minimal POST over a raw TLS socket (via HTTP CONNECT when a proxy is
// configured). Node's https.request hangs when handed a pre-connected TLS
// socket through createConnection, hence the manual request line/head.
async function postStream({ host, urlPath, headers, body, signal }) {
  const proxyUrl = proxyUrlForHost(host);
  let socket;
  if (proxyUrl) {
    const raw = await rawConnectThroughProxy(proxyUrl, host);
    socket = tls.connect({ socket: raw, servername: host });
  } else {
    socket = tls.connect({ host, port: 443, servername: host });
  }

  const onAbort = () => socket.destroy();
  if (signal) {
    if (signal.aborted) {
      socket.destroy();
      throw new AppError(499, 'request_cancelled', 'Request was cancelled by the client.');
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }

  await once(socket, 'secureConnect');

  const lines = [`POST ${urlPath} HTTP/1.1`, `host: ${host}`];
  for (const [key, value] of Object.entries(headers)) lines.push(`${key}: ${value}`);
  if (process.env.QODERCN_CHUNKED) {
    // Experimental: chunked transfer encoding (what qodercli's HTTP client
    // uses) instead of a single content-length framed body.
    lines.push('transfer-encoding: chunked', 'connection: close', '', '');
    socket.write(lines.join('\r\n'));
    const buf = Buffer.from(body);
    for (let off = 0; off < buf.length; off += 65536) {
      const chunk = buf.subarray(off, Math.min(off + 65536, buf.length));
      socket.write(`${chunk.length.toString(16)}\r\n`);
      socket.write(chunk);
      socket.write('\r\n');
    }
    socket.write('0\r\n\r\n');
  } else {
    lines.push(`content-length: ${Buffer.byteLength(body)}`, 'connection: close', '', '');
    socket.write(lines.join('\r\n') + body);
  }

  const iterator = socket[Symbol.asyncIterator]();
  const response = await readResponse(socket, iterator);
  response.socket = socket;
  if (signal) signal.removeEventListener('abort', onAbort);
  return response;
}

async function readText(body) {
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// --- credentials -----------------------------------------------------------

let wasmModulePromise = null;
let credentialsCache = null; // { backend, data, tokenExpireMs }
let refreshPromise = null;

function authDir(backend) {
  return path.join(process.env.USERPROFILE || process.env.HOME || '~', backend.authDir, '.auth');
}

async function getWasm(backend, rootDir) {
  if (!wasmModulePromise) {
    wasmModulePromise = (async () => {
      const bundlePath = resolveCliBundlePath(process.env.CLI_COMMAND || backend.cliCommand);
      if (!bundlePath) {
        throw new AppError(502, 'cli_not_found', `${backend.cliCommand} is not installed or not on PATH.`);
      }
      const cacheDir = path.join(rootDir || process.cwd(), '.runtime');
      const wasmSource = extractAuthWasm(bundlePath, cacheDir);
      return loadAuthWasm(wasmSource);
    })();
    wasmModulePromise.catch(() => { wasmModulePromise = null; });
  }
  return wasmModulePromise;
}

async function loadCredentials(backend, rootDir) {
  const dir = authDir(backend);
  const userFile = path.join(dir, 'user');
  const machineFile = path.join(dir, 'machine_id');
  let encrypted;
  let machineId;
  try {
    encrypted = fs.readFileSync(userFile, 'utf8').trim();
    machineId = fs.readFileSync(machineFile, 'utf8').trim();
  } catch {
    throw new AppError(
      401,
      'cli_token_missing',
      `No stored Qoder credentials found. Run \`${backend.cliCommand} login\` first.`,
      'authentication_error'
    );
  }
  const wasm = await getWasm(backend, rootDir);
  let data;
  try {
    data = JSON.parse(wasm.credentialStorageDecrypt(encrypted, machineId.slice(0, 16)));
  } catch (error) {
    throw new AppError(
      401,
      'credential_decrypt_failed',
      `Failed to decrypt stored Qoder credentials: ${error.message}. Run \`${backend.cliCommand} login\` again.`,
      'authentication_error'
    );
  }
  return { data, dir, machineId };
}

async function saveCredentials(backend, loaded, data) {
  const wasm = await getWasm(backend);
  const encrypted = wasm.credentialStorageEncrypt(JSON.stringify(data), loaded.machineId.slice(0, 16));
  const userFile = path.join(loaded.dir, 'user');
  const tmpFile = `${userFile}.tmp-${process.pid}`;
  fs.writeFileSync(tmpFile, encrypted, { mode: 0o600 });
  fs.renameSync(tmpFile, userFile);
}

function parseTokenResponse(body) {
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    throw new AppError(502, 'token_refresh_failed', 'Token refresh returned invalid JSON.');
  }
  const token = json.token || json.access_token || json.security_oauth_token;
  if (!token) {
    throw new AppError(502, 'token_refresh_failed', `Token refresh returned no token: ${redactString(body).slice(0, 200)}`);
  }
  return {
    token,
    refreshToken: json.refresh_token || json.refreshToken || null,
    expireTimeS: json.expire_time || json.expireTime || json.expires_at || json.expiresAt
      || (json.expires_in ? Math.floor(Date.now() / 1000) + Number(json.expires_in) : null),
    refreshTokenExpireTimeS: json.refresh_token_expire_time || json.refreshTokenExpireTime
      || json.refresh_token_expires_at || json.refreshTokenExpiresAt || null,
  };
}

async function refreshCredentials(backend, loaded) {
  const refreshToken = loaded.data.refresh_token;
  if (!refreshToken) {
    throw new AppError(401, 'token_expired', `Stored Qoder token expired and no refresh token is available. Run \`${backend.cliCommand} login\` again.`, 'authentication_error');
  }
  const url = new URL(`${backend.openapiBase}/api/v1/deviceToken/refresh`);
  const res = await postStream({
    host: url.host,
    urlPath: url.pathname,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  const text = await readText(res.body);
  if (res.statusCode !== 200) {
    throw new AppError(401, 'token_refresh_failed', `Token refresh failed (HTTP ${res.statusCode}). Run \`${backend.cliCommand} login\` again.`, 'authentication_error');
  }
  const refreshed = parseTokenResponse(text);
  const next = {
    ...loaded.data,
    access_token: refreshed.token,
    security_oauth_token: refreshed.token,
    ...(refreshed.refreshToken ? { refresh_token: refreshed.refreshToken } : {}),
    ...(refreshed.expireTimeS ? { expire_time: refreshed.expireTimeS } : {}),
    ...(refreshed.refreshTokenExpireTimeS ? { refresh_token_expire_time: refreshed.refreshTokenExpireTimeS } : {}),
  };
  try {
    await saveCredentials(backend, loaded, next);
    log('qoder credentials refreshed and persisted');
  } catch (error) {
    // The in-memory token is still valid for this process; persistence is best effort.
    log('qoder credential refresh persisted failed', { message: error.message });
  }
  return next;
}

async function getValidToken(backend, { forceRefresh = false, rootDir } = {}) {
  if (!credentialsCache || credentialsCache.backend !== backend.name) {
    const loaded = await loadCredentials(backend, rootDir);
    credentialsCache = { backend: backend.name, loaded, data: loaded.data };
  }
  const expireMs = Number(credentialsCache.data.expire_time || 0) * 1000;
  const expired = !expireMs || expireMs - TOKEN_REFRESH_MARGIN_MS <= Date.now();
  if (!expired && !forceRefresh) {
    return credentialsCache.data.security_oauth_token || credentialsCache.data.access_token;
  }
  if (!refreshPromise) {
    refreshPromise = refreshCredentials(backend, credentialsCache.loaded)
      .then((data) => { credentialsCache.data = data; return data; })
      .finally(() => { refreshPromise = null; });
  }
  const data = await refreshPromise;
  return data.security_oauth_token || data.access_token;
}

// --- chat completions ------------------------------------------------------

// The model server only accepts requests carrying this business metadata.
function buildMetadata() {
  return {
    context: {
      request_id: crypto.randomUUID(),
      request_set_id: crypto.randomUUID(),
      session_id: crypto.randomUUID(),
      task_id: 'common',
      client_type: '5',
    },
    business: {
      product: 'cli',
      version: process.env.QODER_CLIENT_VERSION || '1.1.25',
      type: 'agent',
      id: crypto.randomUUID(),
      name: 'qoder-proxy',
      begin_at: Date.now(),
      stage: 'start',
    },
  };
}

function buildRequestBody({ model, messages, tools, reasoningEffort, maxOutputTokens, contextWindow }) {
  // Always non-streaming upstream: the model server's SSE serializer drops
  // tool_call names (and finish_reason) whenever text precedes a tool call.
  // The complete JSON response is always correct; downstream SSE is
  // synthesized from it.
  const body = {
    model,
    messages,
    stream: false,
    metadata: buildMetadata(),
  };
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.function?.name || tool.name,
        ...(tool.function?.description || tool.description ? { description: tool.function?.description || tool.description } : {}),
        ...((tool.function?.parameters || tool.parameters) ? { parameters: tool.function?.parameters || tool.parameters } : {}),
      },
    }));
  }
  if (maxOutputTokens) body.max_tokens = maxOutputTokens;
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;
  if (contextWindow) body.context_length = contextWindow;
  return body;
}

// Call the model server and return the normalized completion.
// QODERCN_TRANSPORT selects the upstream protocol:
//   'agent' (default) — qodercli's native agent endpoint: no request-size cap,
//                        native tools, reasoning deltas, real streaming.
//   'model'            — the /model/v1/chat/completions endpoint (256 KiB
//                        request-body cap, kept as a rollback path).
async function chatCompletion(options) {
  if ((process.env.QODERCN_TRANSPORT || 'agent').toLowerCase() === 'model') {
    return chatCompletionModel(options);
  }
  return chatCompletionAgent(options);
}

// --- agent transport (qodercli's native conversation endpoint) --------------
//
// POST /algo/api/v2/service/pro/sse/agent_chat_generation on api3 hosts.
// Unlike the /model/v1/chat/completions endpoint (256 KiB request-body cap),
// this one accepts multi-megabyte bodies and carries the full message history,
// native tools and generation parameters. The request body is custom-encoded
// and Cosy-signed by the CLI's own wasm (QoderContext.prepareInferRequest);
// the SSE response wraps plain OpenAI-style chunks.

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m && m.role === 'user') {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        const text = m.content.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n');
        if (text) return text;
      }
    }
  }
  return '';
}

// The agent service converts messages for the model provider behind the scenes.
// Verified against the real endpoint (replay experiments on a captured qodercli
// conversation): assistant messages keep their tool_calls — and the matching
// role:'tool' results validate — ONLY when the assistant message also carries a
// `contents` blocks array (mirroring the text for text turns, [] for pure tool
// turns). Without it the converter drops tool_calls and the provider rejects
// the tool result ("tool_call_id is not found"); a blank text block instead
// trips "text content is empty". A resent `reasoning_content` breaks the same
// conversion, so it is always stripped. Everything else (role:'tool' with
// tool_call_id, plain text turns) passes through as-is.
function normalizeAgentMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (!m) continue;
    if (m.role !== 'assistant') { out.push(m); continue; }
    const texts = typeof m.content === 'string'
      ? (m.content ? [m.content] : [])
      : (Array.isArray(m.content)
        ? m.content.filter((p) => p && p.type === 'text').map((p) => p.text)
        : []);
    const next = { ...m, contents: texts.map((t) => ({ type: 'text', text: t })) };
    delete next.reasoning_content;
    out.push(next);
  }
  return out;
}

function buildAgentRequestBody({ serverModel, messages, tools, reasoningEffort, maxOutputTokens, contextWindow, backendName }) {
  const system = messages
    .filter((m) => m && m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .filter(Boolean)
    .join('\n\n');
  const text = lastUserText(messages);
  const parameters = {};
  if (maxOutputTokens) parameters.max_tokens = maxOutputTokens;
  if (reasoningEffort) {
    parameters.reasoning_effort = reasoningEffort;
    parameters.enable_thinking = reasoningEffort !== 'none';
  }
  if (contextWindow) parameters.context_length = contextWindow;
  return {
    request_id: crypto.randomUUID(),
    request_set_id: crypto.randomUUID(),
    chat_record_id: crypto.randomUUID(),
    session_id: crypto.randomUUID(),
    stream: true,
    chat_task: 'FREE_INPUT',
    chat_context: {
      text,
      features: [],
      extra: {
        context: [],
        modelConfig: { key: serverModel, is_reasoning: true },
        originalContent: text,
      },
      chatPrompt: '',
      imageUrls: null,
    },
    is_reply: true,
    is_retry: false,
    source: 1,
    version: '3',
    agent_id: 'agent_common',
    task_id: 'common',
    session_type: backendName === 'cn' ? 'qoderclicn' : 'qodercli',
    aliyun_user_type: '',
    model_config: {
      key: serverModel,
      display_name: serverModel,
      model: '',
      format: 'openai',
      is_vl: true,
      is_reasoning: true,
      api_key: '',
      url: '',
      source: 'system',
      max_input_tokens: contextWindow || 200000,
    },
    custom_model: null,
    system,
    messages: normalizeAgentMessages(messages.filter((m) => m && m.role !== 'system')),
    tools: Array.isArray(tools) && tools.length
      ? tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.function?.name || tool.name,
          ...(tool.function?.description || tool.description ? { description: tool.function?.description || tool.description } : {}),
          ...((tool.function?.parameters || tool.parameters) ? { parameters: tool.function?.parameters || tool.parameters } : {}),
        },
      }))
      : [],
    parameters,
  };
}

// Assemble the SSE stream into the same normalized completion chatCompletion
// returns. Events are `data:{"body":"<OpenAI chunk JSON>","statusCode":...}`.
async function readAgentSseCompletion(response, model) {
  let id = null;
  let content = '';
  let reasoning = '';
  let finishReason = null;
  let usage = null;
  const toolCalls = [];
  let sawEvent = false;

  const consume = (line) => {
    if (!line.startsWith('data:')) return; // event:finish, comments, blanks
    const payload = line.slice(5).trim();
    if (!payload) return;
    let outer;
    try {
      outer = JSON.parse(payload);
    } catch {
      return;
    }
    const inner = typeof outer.body === 'string' ? outer.body : null;
    if (inner === null) return;
    if (outer.statusCodeValue && outer.statusCodeValue >= 400) {
      // Error frame, e.g. body {"code":"provider_error","details":"{...}"}
      throw new AppError(502, 'upstream_error', `Qoder agent endpoint error: ${redactString(inner).slice(0, 300)}`);
    }
    if (inner === '[DONE]') {
      if (!finishReason) finishReason = 'stop';
      sawEvent = true;
      return;
    }
    let ev;
    try {
      ev = JSON.parse(inner);
    } catch {
      return;
    }
    sawEvent = true;
    if (!ev.choices && (ev.error || (ev.code && ev.message))) {
      const err = ev.error || ev;
      throw new AppError(502, err.type || 'upstream_error', `Qoder agent endpoint error: ${redactString(err.message || inner).slice(0, 300)}`);
    }
    if (ev.id) id = ev.id;
    if (ev.usage) usage = ev.usage;
    const choice = ev.choices?.[0];
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    const delta = choice?.delta || {};
    if (typeof delta.content === 'string') content += delta.content;
    if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
    for (const call of delta.tool_calls || []) {
      const idx = call.index ?? 0;
      toolCalls[idx] = toolCalls[idx] || { id: null, name: null, arguments: '', index: idx };
      if (call.id) toolCalls[idx].id = call.id;
      if (call.function?.name && !toolCalls[idx].name) toolCalls[idx].name = call.function.name;
      if (call.function?.arguments) toolCalls[idx].arguments += call.function.arguments;
    }
  };

  const debugRaw = process.env.QODERCN_DEBUG ? [] : null;
  let buffer = Buffer.alloc(0);
  for await (const chunk of response.body) {
    // Decode per line: a chunk boundary can split a multi-byte UTF-8 char.
    buffer = Buffer.concat([buffer, chunk]);
    let nl = buffer.indexOf(0x0a);
    while (nl !== -1) {
      const line = buffer.slice(0, nl).toString('utf8').replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf(0x0a);
      if (debugRaw && debugRaw.join('\n').length < 4000) debugRaw.push(line.slice(0, 600));
      consume(line);
    }
  }
  if (buffer.length) consume(buffer.toString('utf8').replace(/\r$/, ''));

  if (response.socket) response.socket.destroy();

  if (debugRaw) {
    log('agent upstream raw stream (head)', { lines: debugRaw.length, raw: debugRaw.join('\n') });
  }

  if (!sawEvent) {
    throw new AppError(502, 'invalid_upstream_output', 'Qoder agent endpoint returned an empty SSE stream.');
  }
  return {
    id: id || `chatcmpl-${crypto.randomUUID()}`,
    model: model,
    content,
    reasoning,
    toolCalls: toolCalls.filter(Boolean),
    finishReason: finishReason || 'stop',
    usage,
  };
}

async function chatCompletionAgent({ model, messages, tools, reasoningEffort, maxOutputTokens, contextWindow, signal, rootDir }) {
  const backend = getBackend();
  const agentHost = process.env.QODERCN_AGENT_HOST
    || (backend.name === 'cn' ? 'api3.qoder.com.cn' : 'api3.qoder.sh');

  const body = buildAgentRequestBody({
    serverModel: model,
    messages,
    tools,
    reasoningEffort,
    maxOutputTokens,
    contextWindow,
    backendName: backend.name,
  });

  const [wasm, loaded] = await Promise.all([getWasm(backend, rootDir), loadCredentials(backend, rootDir)]);
  const ctx = wasm.createQoderContext();
  let request;
  try {
    ctx.refreshAuthFields(JSON.stringify({
      uid: loaded.data.uid,
      encrypt_user_info: loaded.data.encrypt_user_info,
      key: loaded.data.key,
      organization_id: loaded.data.organization_id,
      organization_tags: loaded.data.organization_tags,
    }));
    request = ctx.prepareInferRequest(`https://${agentHost}`, JSON.stringify(body), model, 'system');
  } catch (error) {
    ctx.free();
    throw new AppError(502, 'upstream_prepare_failed', `Failed to prepare agent request: ${error.message}`);
  }

  if (process.env.QODERCN_DEBUG) {
    log('agent upstream request', {
      model: body.model_config.key,
      message_count: body.messages.length,
      tool_count: body.tools.length,
      context_length: body.parameters.context_length,
      body_bytes: Buffer.byteLength(request.body),
      url: request.url,
    });
  }

  let response;
  try {
    const url = new URL(request.url);
    // request.headers is a Map (wasm-bindgen heap object) — postStream wants a
    // plain object. Header names arrive lower-cased by the wasm.
    const headers = request.headers instanceof Map
      ? Object.fromEntries(request.headers)
      : request.headers;
    response = await postStream({
      host: url.host,
      urlPath: url.pathname + url.search,
      headers,
      body: request.body,
      signal,
    });
  } catch (error) {
    request.free();
    ctx.free();
    if (signal?.aborted) throw new AppError(499, 'request_cancelled', 'Request was cancelled by the client.');
    throw new AppError(502, 'upstream_unreachable', `Failed to reach Qoder agent endpoint: ${error.message}`);
  }

  try {
    if (response.statusCode !== 200) {
      const text = await readText(response.body);
      if (response.socket) response.socket.destroy();
      if (response.statusCode === 401 || response.statusCode === 403) {
        throw new AppError(401, 'upstream_auth_failed', `Qoder agent endpoint rejected the credentials: ${redactString(text).slice(0, 200)}`, 'authentication_error');
      }
      throw new AppError(502, 'upstream_error', `Qoder agent endpoint returned HTTP ${response.statusCode}: ${redactString(text).slice(0, 240)}`);
    }
    return await readAgentSseCompletion(response, model);
  } finally {
    request.free();
    ctx.free();
  }
}

async function chatCompletionModel({ model, messages, tools, reasoningEffort, maxOutputTokens, contextWindow, signal, rootDir }) {
  const backend = getBackend();
  const body = buildRequestBody({ model, messages, tools, reasoningEffort, maxOutputTokens, contextWindow });
  const urlPath = '/model/v1/chat/completions';
  const payload = JSON.stringify(body);
  const payloadBytes = Buffer.byteLength(payload);

  if (payloadBytes > MAX_UPSTREAM_BODY_BYTES) {
    throw new AppError(
      413,
      'prompt_too_large',
      `Request is ${payloadBytes} bytes, exceeding the Qoder model server's ~256 KiB body limit. Switch to the agent transport (QODERCN_TRANSPORT=agent, the default) or shorten the conversation (e.g. run /compact) and try again.`,
      'invalid_request_error'
    );
  }

  if (process.env.QODERCN_DEBUG) {
    log('upstream request', {
      model: body.model,
      message_count: body.messages.length,
      context_length: body.context_length,
      max_tokens: body.max_tokens,
      reasoning_effort: body.reasoning_effort,
      body_bytes: payloadBytes,
    });
  }

  let response = null;
  let lastAuthError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = await getValidToken(backend, { forceRefresh: attempt > 0, rootDir });
    if (!token) {
      throw new AppError(401, 'cli_token_missing', `No Qoder access token available. Run \`${backend.cliCommand} login\` first.`, 'authentication_error');
    }
    try {
      response = await postStream({
        host: backend.modelHost,
        urlPath,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          'x-request-id': body.metadata.context.request_id,
          'x-session-id': body.metadata.context.session_id,
          'cosy-version': process.env.QODER_CLIENT_VERSION || '1.1.25',
          'cosy-clienttype': '5',
        },
        body: payload,
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw new AppError(499, 'request_cancelled', 'Request was cancelled by the client.');
      throw new AppError(502, 'upstream_unreachable', `Failed to reach Qoder model server: ${error.message}`);
    }
    if (response.statusCode === 401 || response.statusCode === 403) {
      lastAuthError = await readText(response.body);
      response.socket.destroy();
      response = null;
      continue; // refresh once and retry
    }
    break;
  }
  if (!response) {
    throw new AppError(401, 'upstream_auth_failed', `Qoder model server rejected the token: ${redactString(lastAuthError || '').slice(0, 200)}`, 'authentication_error');
  }

  const text = await readText(response.body);
  response.socket.destroy();
  if (response.statusCode !== 200) {
    throw new AppError(502, 'upstream_error', `Qoder model server returned HTTP ${response.statusCode}: ${redactString(text).slice(0, 240)}`);
  }

  if (process.env.QODERCN_DEBUG) {
    log('upstream raw response', { body: redactString(text).slice(0, 2000) });
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AppError(502, 'invalid_upstream_output', `Qoder model server returned invalid JSON: ${redactString(text).slice(0, 240)}`);
  }
  if (parsed.error || (parsed.code && parsed.message && !parsed.choices)) {
    const err = parsed.error || parsed;
    throw new AppError(502, err.code || err.type || 'upstream_error', err.message || 'Upstream error.');
  }

  const choice = parsed.choices?.[0];
  const message = choice?.message || {};
  return {
    id: parsed.id || `chatcmpl-${crypto.randomUUID()}`,
    model: parsed.model || model,
    content: typeof message.content === 'string' ? message.content : '',
    reasoning: typeof message.reasoning_content === 'string' ? message.reasoning_content : '',
    toolCalls: (message.tool_calls || []).map((call, index) => ({
      id: call.id || null,
      name: call.function?.name || null,
      arguments: call.function?.arguments || '',
      index: call.index ?? index,
    })),
    finishReason: choice?.finish_reason || 'stop',
    usage: parsed.usage || choice?.usage || null,
  };
}

module.exports = {
  BACKENDS,
  buildRequestBody,
  chatCompletion,
  getBackend,
  // exposed for tests
  loadCredentials,
};
