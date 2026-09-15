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
  lines.push(`content-length: ${Buffer.byteLength(body)}`, 'connection: close', '', '');
  socket.write(lines.join('\r\n') + body);

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

// Call the model server (stream:false) and return the normalized completion.
async function chatCompletion({ model, messages, tools, reasoningEffort, maxOutputTokens, contextWindow, signal, rootDir }) {
  const backend = getBackend();
  const body = buildRequestBody({ model, messages, tools, reasoningEffort, maxOutputTokens, contextWindow });
  const urlPath = '/model/v1/chat/completions';

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
        body: JSON.stringify(body),
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
