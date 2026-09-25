# AGENTS.md

本文件为编程Agent在本仓库中工作时提供指引。

## 这是什么

Qoder Proxy 是一个**仅限本地**的 HTTP 适配器，将 OpenAI/Anthropic 兼容客户端桥接到 Qoder 账号体系（中国版 `qoderclicn`，国际版 `qodercli`）。它不是官方 API，绝不可公开部署——只绑定到 `127.0.0.1`。它不再启动 CLI 子进程，而是直接调用 Qoder 服务端的 HTTP 端点：用 CLI 自带的 auth wasm 解密 `~/.qoder/.auth/user`（或 `~/.qoderworkcn`）拿到凭证，把 OpenAI/Anthropic 请求转成 Qoder 的上游协议，再把响应重塑回两种格式。

## 源码结构

运行时源码位于 `clean/`（不是 `src/`）——这是发布包的入口（`package.json` 的 `main: clean/server.js`）。核心模块：

- `server.js` — 入口；绑定 `127.0.0.1:PORT`，调用 `createApp()`。
- `app.js` — Express 应用，两个协议端点、请求校验/选项提取（`extractRequestOptions`、`resolveUpstreamOptions`）、上游调用的超时/取消，以及由完整结果合成下游 SSE 的逻辑（`completionToChunks`）。
- `anthropic.js` — Anthropic → 内部 OpenAI 风格消息转换及响应封装（`toolu_` ID，`input` 为解析后的对象）。
- `qoder-api.js` — 上游 HTTP 客户端（见下文"两种传输"）：裸 TLS socket + 可选 HTTP CONNECT 代理（`postStream`）、凭证加载/刷新、agent 端点的请求体构造与 SSE 解析。
- `auth-wasm.js` — 从已安装的 CLI bundle 里提取内嵌 wasm（base64 字面量扫描），并手写 wasm-bindgen ABI 胶水：凭证加解密（`credentialStorageDecrypt/Encrypt`）和 `QoderContext`（agent 请求的编码+签名，见下）。
- `models.js` — 模型注册表与路由（`resolveModelRoute`，`*-effort-{low,medium,high,max}` 后缀解析为推理强度覆盖，未知 ID 回退 `auto`）。
- `errors.js` — `AppError` 类（status、code、message），集中式错误处理器按路由序列化为 OpenAI 或 Anthropic 形态。
- `redact.js` / `logger.js` — 所有日志经 `redact` 清洗，去除 token、Authorization、cookie。
- `usage.js` — 内存中的本地用量估算，每 5 分钟持久化到 `usage.json`。
- `public/`（仓库根）— 静态 Web 控制台，在 `/ui` 提供。

测试在 `test/` 目录，使用 `node:test`：`http.test.js`（端点形态测试，临时端口，不打真实上游）、`anthropic.test.js`、`models.test.js`、`redact.test.js`、`usage.test.js`。`scripts/smoke.js` 是冒烟测试运行器。

## 命令

```bash
npm start            # node clean/server.js — 在 127.0.0.1:3000 启动代理
npm run dev          # npm start 的别名（无 watch/reload）
npm test             # node --test — 运行所有 test/*.test.js
npm run smoke        # 快速检查 /health + /v1/models（需服务器已启动）
npm run smoke:full   # 还会测试 /v1/chat/completions 和 /v1/messages（真实模型调用）
```

运行单个测试文件：`node --test test/http.test.js`。冒烟脚本目标为 `http://127.0.0.1:3000`（可用 `SMOKE_BASE_URL` 覆盖）。

Windows 快速启动：双击 `start-proxy.cmd`（启动服务器）或 `start-ui.cmd`（启动服务器并打开 Web 控制台 `/ui`）。

需要 Node 18+。仅有的依赖：`express`、`cors`、`dotenv`。

## 配置

配置通过 `.env` 文件（从 `.env.example` 复制）。`CLI_BACKEND` 选择 `global`（`qodercli`，认证信息在 `~/.qoder`）或 `cn`（`qoderclicn`，认证信息在 `~/.qoderworkcn`）——先在对应 CLI 里 `login` 一次。推理默认值（`QODERCN_REASONING_EFFORT`、`QODERCN_CONTEXT_WINDOW`、`QODERCN_MAX_OUTPUT_TOKENS`）和 `QODERCN_TIMEOUT_MS` 为全局设置；请求级参数可覆盖它们。`QODERCN_FORCE_EFFORT` 若设置则**覆盖一切** effort 来源（`low|medium|high|xhigh|max`）。`QODERCN_TRANSPORT` 选择上游协议（`agent` 默认 / `model` 回退，见下）。`QODERCN_AGENT_HOST` 可覆盖 agent 端点主机名。`QODERCN_MAX_BODY_BYTES` 仅影响 model 传输的 413 防线阈值。

## 架构

### 端点（均在 `app.js` 中）

`GET /health` · `GET /`（落地页）· `GET /v1/models`（来自 `models.js` 的注册表）· `POST /v1/chat/completions`（OpenAI）· `POST /v1/messages`（Anthropic）· `POST /v1/messages/count_tokens`（估算桩）· `GET /usage/local` + `POST /usage/reset-local`（本地用量）· `/ui`（静态 Web 控制台）。Express body 限制由 `QODERCN_BODY_LIMIT` 控制（默认 25mb，因为客户端会重发全量历史）。错误流经 `createApp` 底部的集中式错误处理器——body 解析失败（如 413）发生在路由之前，处理器按路径用对应协议形态应答。

### 请求流程

`server.js` → `app.js` 中的 `createApp()`。两条并行路径：

- **OpenAI**（`POST /v1/chat/completions`）— 直接处理。
- **Anthropic**（`POST /v1/messages`）— `anthropic.js` 把请求转为内部 OpenAI 风格消息数组后走同一路径；`system` 提取为系统消息，`tools`（含 `input_schema`）规范化为 OpenAI function 工具。

两条路径都调用 `qoder-api.js` 的 `chatCompletion({model, messages, tools, reasoningEffort, maxOutputTokens, contextWindow, signal, rootDir})`，返回统一形态：`{id, model, content, reasoning, toolCalls[{id,name,arguments,index}], finishReason, usage}`。工具调用是**原生**的——直接透传给上游，无 prompt 注入模拟。下游 SSE 由 app.js 从完整结果合成（`completionToChunks`）；带工具调用的流式请求降级为单次 JSON 响应。客户端断开经 `AbortController` 传到上游 socket。

### 两种上游传输（`qoder-api.js`）

`QODERCN_TRANSPORT` 选择：

- **agent（默认，推荐）** — qodercli 原生的对话端点：`POST https://api3.qoder.sh`（cn 后端为 `api3.qoder.com.cn`）`/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`。**没有请求体大小限制**（已实测 1.5MB / 31 万 token 输入全量送达），携带完整消息历史、原生工具和生成参数（`parameters.max_tokens/reasoning_effort/enable_thinking/context_length`）。请求体需要自定义编码（Encode=1）+ Cosy 请求签名（Authorization/Cosy-Key/Cosy-Date 等约 22 个头）——全部由 CLI 的 wasm 完成：`createQoderContext()` → `refreshAuthFields(userJson)` → `prepareInferRequest(endpoint, bodyJson, modelKey, 'system')` 返回 `{url, headers(Map), body}`。响应是 SSE，事件形如 `data:{"body":"<JSON 转义的 OpenAI chunk>",...}`（注意 `data:` 后无空格，body 是二次编码的字符串）；`readAgentSseCompletion` 逐行解码、累积 `delta.content/reasoning_content/tool_calls`、取最终 usage chunk，`body:"[DONE]"` 结束。**错误帧**（外层 `statusCodeValue >= 400` 或内层无 `choices` 但带 `code/message`）会抛 `AppError` 而不是静默返回空。
  - **assistant 消息必须整形**（`normalizeAgentMessages`，经真实端点重放实验验证）：带 `tool_calls` 的 assistant 消息只有同时携带 `contents` 块数组，服务端转换器才会保留 tool_calls，对应的 `role:'tool'` 结果才能通过校验——否则报 `tool_call_id is not found`。有文本时 `contents` 镜像文本块；纯工具轮用 `contents: []`（用空文本块会报 `text content is empty`）。回传的 `reasoning_content` 会让同一转换失败，必须剥离。其余（`role:'tool'` 带 `tool_call_id`、纯文本轮）原样透传。qodercli 的做法相同：两轮间**复用 session_id**（服务端有会话状态，但经实验验证无状态的新 session_id + 完整原生历史同样可用）。
- **model（回退路径）** — `POST https://api2-v2.qoder.sh/model/v1/chat/completions`，Bearer token + metadata 头。网关对超过 256KiB 的请求体返回不透明 HTTP 500（实测边界 262,134B 成功 / 262,284B 失败），因此 `chatCompletionModel` 有 413 快速失败防线（`MAX_UPSTREAM_BODY_BYTES`，提示切换 agent 传输或 `/compact`）。上游始终非流式（其 SSE 序列化器会丢 tool_call 名称），完整 JSON 一次返回。

`postStream` 是两者共用的发送层：裸 TLS socket（`HTTPS_PROXY`/`https_proxy` 时先 HTTP CONNECT），手动写请求行/头，支持 chunked 与 content-length 响应体解码，`NO_PROXY` 豁免。

### 凭证与 wasm（`auth-wasm.js` + `qoder-api.js`）

`getWasm` 通过 `resolveCliBundlePath` 在 PATH 上找到 CLI bundle（Windows 下解析 `.cmd` 垫片并定位 `node_modules/<pkg>/bundle/<cli>.js`），`extractAuthWasm` 扫描 bundle 里的 base64 wasm 字面量、选导出 `credential_storage_decrypt` 的那个，缓存到 `.runtime/`。wasm 胶水手写 wasm-bindgen ABI：字符串以 (ptr,len) 经 malloc 传入，返回值走栈上返回区（ptr 返回型 `[+0 ptr][+4 errObj][+8 errFlag]`，字符串返回型多一个 len）。`loadCredentials` 用 wasm 解密 `~/.qoder/.auth/user`（密钥为 machine_id 前 16 字符）；token 过期时经 openapi `deviceToken/refresh` 刷新并回写。请求头/响应日志只输出清洗后的内容，**绝不在日志或对话里打印 token 值**。

### 双协议响应封装

`app.js` 和 `anthropic.js` 各有将统一形态转为文本/工具调用响应的函数（OpenAI 为 `tool_calls`，Anthropic 为 `tool_use` 块）。`generateCallId` 按协议使用正确前缀（`call_` vs `toolu_`）。OpenAI 的 `arguments` 是 JSON 字符串；Anthropic 的 `input` 是解析后的对象。reasoning 以 OpenAI `reasoning` 字段 / Anthropic `thinking` 块透传。

### 用量追踪

`usage.js` 维护本地估算，每 5 分钟持久化到 `usage.json`（已 gitignore）。agent 传输下用上游 usage chunk 的真实 token 数。它不存储 prompt、响应或认证信息。

## 安全约定

- 只绑定到 `127.0.0.1`。绝不绑定 `0.0.0.0`，绝不隧道/代理到公网。
- `redact.js` 清洗所有日志中的 `Bearer` token、`Authorization` 头和 `token`/`cookie` 赋值。
- `.env`、`.runtime/`、`usage.json`、`.qoder/` 已 gitignore。绝不提交 token。
- `PROXY_API_KEY` 存在但认证强制不是目标——边界是"仅限本机"。

## 测试说明

测试使用 `node:test` 和 `node:assert/strict`。`test/http.test.js` 在临时端口上启动 Express 应用并用 `fetch` 请求——不打真实上游。`npm run smoke:full` 是唯一做真实模型调用的路径。跑 agent 传输的手动验证时可用 `QODERCN_DEBUG=1 PORT=3999 node clean/server.js` 起隔离实例，日志会打印上游请求摘要（模型、消息数、body 字节数——不含内容）。
