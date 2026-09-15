const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_MODEL_ID,
  MODELS,
  getModel,
  resolveModelRoute,
  resolveServerModel,
} = require('../clean/models');

test('all models have required fields: id, name, serverModel, reasoning', () => {
  for (const model of MODELS) {
    assert.equal(typeof model.id, 'string', 'model missing id');
    assert.equal(typeof model.name, 'string', `model ${model.id} missing name`);
    assert.equal(typeof model.serverModel, 'string', `model ${model.id} missing serverModel`);
    assert.equal(model.reasoning, true, `model ${model.id} missing reasoning: true`);
  }
});

test('server model IDs match the captured CLI mapping', () => {
  const expected = {
    'auto': 'auto',
    'performance': 'performance',
    'efficient': 'efficient',
    'lite': 'lite',
    'qwen3.8-max': 'qmodel_38max',
    'qwen3.8-flash': 'qfmodel',
    'qwen3.7-max': 'qmodel_latest',
    'qwen3.7-plus': 'qmodel',
    'kimi-k3': 'kmodel_latest',
    'kimi-k2.7-code': 'kmodel',
    'glm-5.3': 'gmodel',
    'glm-5.3-flash': 'gfmodel',
    'deepseek-v4-pro': 'dmodel',
    'deepseek-v4-flash': 'dfmodel',
    'minimax-m3': 'mmodel',
  };
  for (const [id, serverModel] of Object.entries(expected)) {
    assert.equal(resolveServerModel(id), serverModel, `${id} should map to ${serverModel}`);
  }
});

test('every reasoning model exposes effort aliases', () => {
  const aliases = MODELS.filter((m) => m.effortAlias);
  const bases = MODELS.filter((m) => !m.effortAlias);
  assert.equal(aliases.length, bases.length * 5);
  for (const alias of aliases) {
    const base = MODELS.find((m) => !m.effortAlias && alias.id.startsWith(`${m.id}-effort-`));
    assert.ok(base, `${alias.id} should derive from a base model`);
    assert.equal(alias.serverModel, base.serverModel);
  }
});

test('resolveModelRoute parses effort suffixes correctly', () => {
  const low = resolveModelRoute('qwen3.8-max-effort-low');
  assert.equal(low.baseModelId, 'qwen3.8-max');
  assert.equal(low.serverModel, 'qmodel_38max');
  assert.equal(low.reasoningEffort, 'low');

  const max = resolveModelRoute('deepseek-v4-pro-effort-max');
  assert.equal(max.baseModelId, 'deepseek-v4-pro');
  assert.equal(max.reasoningEffort, 'max');

  const xhigh = resolveModelRoute('kimi-k3-effort-xhigh');
  assert.equal(xhigh.baseModelId, 'kimi-k3');
  assert.equal(xhigh.reasoningEffort, 'xhigh');

  const none = resolveModelRoute('kimi-k3');
  assert.equal(none.baseModelId, 'kimi-k3');
  assert.equal(none.serverModel, 'kmodel_latest');
  assert.equal(none.reasoningEffort, undefined);
});

test('unknown model IDs fall back to auto', () => {
  assert.equal(resolveServerModel('claude-sonnet-4-5'), 'auto');
  assert.equal(resolveServerModel(undefined), 'auto');
});

test('getModel returns correct model for known ID', () => {
  const model = getModel('qoder-cn');
  assert.ok(model);
  assert.equal(model.serverModel, 'auto');
  assert.equal(model.reasoning, true);
});

test('getModel returns undefined for unknown ID', () => {
  assert.equal(getModel('nonexistent-model'), undefined);
  assert.equal(getModel(''), undefined);
  assert.equal(getModel(undefined), undefined);
});

test('DEFAULT_MODEL_ID is qoder-cn', () => {
  assert.equal(DEFAULT_MODEL_ID, 'qoder-cn');
});
