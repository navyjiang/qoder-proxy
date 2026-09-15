// Public model IDs mapped to the Qoder model server's internal model IDs.
// The server IDs were captured from qodercli's own traffic (relay capture).

const MODELS = [
  { id: 'qoder-cn', name: 'Auto', serverModel: 'auto', reasoning: true },
  { id: 'auto', name: 'Auto', serverModel: 'auto', reasoning: true },
  { id: 'performance', name: 'Performance', serverModel: 'performance', reasoning: true },
  { id: 'efficient', name: 'Efficient', serverModel: 'efficient', reasoning: true },
  { id: 'lite', name: 'Lite', serverModel: 'lite', reasoning: true },
  { id: 'qwen3.8-max', name: 'Qwen3.8-Max', serverModel: 'qmodel_38max', reasoning: true },
  { id: 'qwen3.8-flash', name: 'Qwen3.8-Flash', serverModel: 'qfmodel', reasoning: true },
  { id: 'qwen3.7-max', name: 'Qwen3.7-Max', serverModel: 'qmodel_latest', reasoning: true },
  { id: 'qwen3.7-plus', name: 'Qwen3.7-Plus', serverModel: 'qmodel', reasoning: true },
  { id: 'kimi-k3', name: 'Kimi-K3', serverModel: 'kmodel_latest', reasoning: true },
  { id: 'kimi-k2.7-code', name: 'Kimi-K2.7-Code', serverModel: 'kmodel', reasoning: true },
  { id: 'glm-5.3', name: 'GLM-5.3', serverModel: 'gmodel', reasoning: true },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', serverModel: 'gfmodel', reasoning: true },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', serverModel: 'dmodel', reasoning: true },
  { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', serverModel: 'dfmodel', reasoning: true },
  { id: 'minimax-m3', name: 'MiniMax-M3', serverModel: 'mmodel', reasoning: true },
];

const DEFAULT_MODEL_ID = 'qoder-cn';
const EFFORT_SUFFIX_RE = /^(.*)-effort-(low|medium|high|xhigh|max)$/;

function getModel(modelId) {
  return MODELS.find((model) => model.id === modelId);
}

function resolveServerModel(modelId) {
  if (process.env.QODERCN_MODEL) return process.env.QODERCN_MODEL;
  const model = getModel(modelId);
  if (model) return model.serverModel;
  // Unknown model IDs (e.g. claude-*, gpt-*) fall back to auto routing
  return 'auto';
}

// For effort aliases like kimi-k3-effort-high, register them dynamically on the
// public list so /v1/models shows them for every reasoning-capable model.
for (const model of [...MODELS]) {
  if (!model.reasoning || model.effortAlias) continue;
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    MODELS.push({
      id: `${model.id}-effort-${effort}`,
      name: `${model.name} ${effort}`,
      serverModel: model.serverModel,
      reasoning: true,
      effortAlias: true,
    });
  }
}

function resolveModelRoute(modelId) {
  const match = modelId ? String(modelId).match(EFFORT_SUFFIX_RE) : null;
  const baseModelId = match ? match[1] : modelId;
  return {
    baseModelId,
    serverModel: resolveServerModel(baseModelId),
    reasoningEffort: match?.[2],
  };
}

module.exports = {
  DEFAULT_MODEL_ID,
  MODELS,
  getModel,
  resolveModelRoute,
  resolveServerModel,
};
