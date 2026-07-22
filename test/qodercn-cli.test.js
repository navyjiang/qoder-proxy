const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  buildCliArgs,
  buildPrompt,
  buildSpawnCommand,
  extractAssistantContent,
  extractStreamDelta,
  resolveBuiltinToolsDisabled,
  resolveCliCommand,
} = require('../clean/qodercn-cli');
const { resolveModelRoute } = require('../clean/models');

test('prompt preserves multi-turn messages', () => {
  const prompt = buildPrompt([
    { role: 'system', content: 'Be terse.' },
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'second' },
    { role: 'user', content: 'third' },
  ]);

  assert.match(prompt, /Be terse/);
  assert.match(prompt, /first/);
  assert.match(prompt, /second/);
  assert.match(prompt, /third/);
});

test('extracts final assistant content from JSON output', () => {
  const output = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'draft' }] } }),
    JSON.stringify({ type: 'result', result: 'OK' }),
  ].join('\n');

  assert.equal(extractAssistantContent(output), 'OK');
});

test('rejects unstructured text output', () => {
  assert.throws(() => extractAssistantContent('Thinking...\nOK'), /structured JSON/);
});

test('builds qoderclicn print-mode args without unsupported flags', () => {
  const args = buildCliArgs({ model: 'auto' });

  assert.deepEqual(args, [
    '--print',
    '--output-format',
    'json',
    '--model',
    'auto',
    '--dangerously-skip-permissions',
  ]);
  // The prompt is piped via stdin and must never appear on the command line:
  // Linux caps a single argv entry at 128 KiB (spawn E2BIG) and Windows caps
  // the whole command line at ~32k chars.
  assert.equal(args.includes('--'), false);
  assert.equal(args.includes('--attachment'), false);
  assert.equal(args.includes('--max-turns=1'), false);
  assert.equal(args.includes('--tools'), false);
});

test('disables qodercli built-in tools when requested', () => {
  const args = buildCliArgs({ model: 'auto', disableBuiltinTools: true });

  const toolsIndex = args.indexOf('--tools');
  assert.notEqual(toolsIndex, -1);
  assert.equal(args[toolsIndex + 1], '');
});

test('resolves built-in tools mode from env and request tools', () => {
  const original = process.env.QODERCN_BUILTIN_TOOLS;
  const tools = [{ name: 'Bash' }];
  try {
    delete process.env.QODERCN_BUILTIN_TOOLS;
    assert.equal(resolveBuiltinToolsDisabled(tools), true);
    assert.equal(resolveBuiltinToolsDisabled([]), false);
    assert.equal(resolveBuiltinToolsDisabled(undefined), false);

    process.env.QODERCN_BUILTIN_TOOLS = 'off';
    assert.equal(resolveBuiltinToolsDisabled(undefined), true);

    process.env.QODERCN_BUILTIN_TOOLS = 'on';
    assert.equal(resolveBuiltinToolsDisabled(tools), false);
  } finally {
    if (original === undefined) delete process.env.QODERCN_BUILTIN_TOOLS;
    else process.env.QODERCN_BUILTIN_TOOLS = original;
  }
});

test('builds qoderclicn reasoning effort args when requested', () => {
  const args = buildCliArgs({ model: 'Qwen3.7-Max', reasoningEffort: 'high' });

  assert.equal(args.includes('--reasoning-effort'), true);
  assert.equal(args[args.indexOf('--reasoning-effort') + 1], 'high');
});

test('resolves effort model aliases to base qoderclicn model and effort', () => {
  assert.deepEqual(resolveModelRoute('qwen3.7-max-effort-high'), {
    baseModelId: 'qwen3.7-max',
    cliModel: 'Qwen3.7-Max',
    reasoningEffort: 'high',
  });
});

test('builds qoderclicn context and output token args when requested', () => {
  const args = buildCliArgs({
    model: 'Qwen3.7-Max',
    contextWindow: 200000,
    maxOutputTokens: 4096,
  });

  assert.equal(args[args.indexOf('--context-window') + 1], '200000');
  assert.equal(args[args.indexOf('--max-output-tokens') + 1], '4096');
});

test('wraps Windows cmd shims for spawning', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    const spec = buildSpawnCommand('C:\\bin\\qoderclicn.cmd', ['--version']);
    assert.match(spec.command, /cmd\.exe$/i);
    assert.deepEqual(spec.args.slice(0, 4), ['/d', '/s', '/c', 'C:\\bin\\qoderclicn.cmd']);
    assert.equal(spec.args.at(-1), '--version');
  } finally {
    Object.defineProperty(process, 'platform', originalPlatform);
  }
});

test('uses qoderclicn JS bundle directly when npm cmd shim is available', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qodercn-spawn-'));
  const shim = path.join(temp, 'qoderclicn.cmd');
  const bundle = path.join(
    temp,
    'node_modules',
    '@qodercn-ai',
    'qoderclicn',
    'bundle',
    'qoderclicn.js'
  );
  fs.mkdirSync(path.dirname(bundle), { recursive: true });
  fs.writeFileSync(shim, '@echo off\n');
  fs.writeFileSync(bundle, 'console.log("ok")\n');

  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    const spec = buildSpawnCommand(shim, ['--print', 'hello']);
    assert.equal(spec.command, process.execPath);
    assert.equal(spec.args[0], bundle);
    assert.equal(spec.args.at(-1), 'hello');
  } finally {
    Object.defineProperty(process, 'platform', originalPlatform);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('resolves bare qoderclicn command to Windows npm cmd shim on PATH', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qodercn-path-'));
  const shim = path.join(temp, 'qoderclicn.cmd');
  fs.writeFileSync(shim, '@echo off\n');

  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    const command = resolveCliCommand('qoderclicn', { PATH: temp, PATHEXT: '.EXE;.BAT;.CMD' });
    assert.equal(command, shim);
  } finally {
    Object.defineProperty(process, 'platform', originalPlatform);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('resolveCliCommand keeps explicit CLI paths unchanged', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    assert.equal(resolveCliCommand('C:\\bin\\qoderclicn.cmd', { PATH: '' }), 'C:\\bin\\qoderclicn.cmd');
  } finally {
    Object.defineProperty(process, 'platform', originalPlatform);
  }
});

test('builds stream-json output format when stream is requested', () => {
  const args = buildCliArgs({ model: 'auto', stream: true });
  assert.deepEqual(args.slice(0, 5), ['--print', '--output-format', 'stream-json', '--model', 'auto']);
});

test('defaults to non-streaming json format when stream is not set', () => {
  const args = buildCliArgs({ model: 'auto' });
  assert.deepEqual(args.slice(0, 5), ['--print', '--output-format', 'json', '--model', 'auto']);
});

test('extractStreamDelta extracts text from assistant message with content array', () => {
  const record = {
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Hello world' }] },
  };
  assert.equal(extractStreamDelta(record), 'Hello world');
});

test('extractStreamDelta extracts text from assistant message with delta field', () => {
  const record = { type: 'assistant', delta: 'partial text' };
  assert.equal(extractStreamDelta(record), 'partial text');
});

test('extractStreamDelta extracts text from assistant message with text field', () => {
  const record = { type: 'assistant', text: 'some text' };
  assert.equal(extractStreamDelta(record), 'some text');
});

test('extractStreamDelta returns null for non-assistant types', () => {
  assert.equal(extractStreamDelta({ type: 'system' }), null);
  assert.equal(extractStreamDelta({ type: 'result', result: 'done' }), null);
  assert.equal(extractStreamDelta({ type: 'user', content: 'hi' }), null);
});

test('extractStreamDelta returns null for tool_use content blocks', () => {
  const record = {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] },
  };
  assert.equal(extractStreamDelta(record), null);
});

test('extractStreamDelta returns null for null or non-object input', () => {
  assert.equal(extractStreamDelta(null), null);
  assert.equal(extractStreamDelta(undefined), null);
  assert.equal(extractStreamDelta('string'), null);
});

test('extractStreamDelta joins multiple text blocks', () => {
  const record = {
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'first ' },
        { type: 'tool_use', name: 'X', input: {} },
        { type: 'text', text: 'second' },
      ],
    },
  };
  assert.equal(extractStreamDelta(record), 'first second');
});

test('buildPrompt includes large system prompts without size limits', () => {
  // Regression guard for the spawn E2BIG fix: oversized system prompts used to
  // be passed via --append-system-prompt / --attachment. Now they stay inside
  // the prompt string that is piped to the CLI over stdin, which has no size
  // cap. A 140 KB system prompt must survive intact in the built prompt.
  const longSystemPrompt = 'x'.repeat(140 * 1024);
  const prompt = buildPrompt([
    { role: 'system', content: longSystemPrompt },
    { role: 'user', content: 'hi' },
  ]);

  assert.equal(prompt.includes(longSystemPrompt), true);
  assert.equal(prompt.includes('"role": "system"'), true);
});
