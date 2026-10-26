/**
 * The two model calls this plugin makes.
 *
 * There is no API key anywhere: both calls use the Harness model services
 * (`agentDefaultModel` for the user's current selection and `llm` for the
 * stream itself, which already holds the configured credentials). The default
 * model therefore follows the user's own DSH settings; switching the default
 * model in DSH changes what this plugin uses.
 */

import { fail } from './errors.js';
import { normalizeAiDraft, normalizeAiName, parseModelJson, stripFrontmatter } from './naming.js';

const CALL_TIMEOUT_MS = 20_000;
const MAX_PROMPT_CHARS = 2_000;
const MAX_NAME_CONTENT = 6_000;

/** Use the DSH default model; fall back to the first configured provider. */
async function resolveRoute(ctx) {
  const selection = ctx?.get?.('agentDefaultModel')?.currentSelection?.();
  if (
    selection &&
    typeof selection.provider === 'string' &&
    selection.provider.trim() &&
    typeof selection.model === 'string' &&
    selection.model.trim()
  ) {
    return {
      provider: selection.provider.trim(),
      model: selection.model.trim(),
      reasoningEffort: selection.reasoningEffort,
      source: 'agent-default-model',
    };
  }
  const llm = ctx?.get?.('llm');
  if (!llm) fail('no_model', 'DSH 模型服务不可用，请检查模型设置');
  const providers = typeof llm.listProviders === 'function' ? llm.listProviders() : [];
  for (const provider of providers ?? []) {
    if (typeof provider?.id !== 'string' || !provider.id) continue;
    try {
      const models = await llm.listModels(provider.id);
      const model = (models ?? []).find((candidate) => typeof candidate?.id === 'string' && candidate.id);
      if (model) return { provider: provider.id, model: model.id, source: 'first-provider' };
    } catch {
      /* Try the next provider. */
    }
  }
  fail('no_model', '尚未配置可用的模型，请先在 DSH 设置中选择默认模型');
}

/** Stream one completion and return its concatenated text. */
async function complete(ctx, { route, system, user, maxTokens }) {
  const llm = ctx.get('llm');
  if (!llm || typeof llm.stream !== 'function') fail('no_model', '当前 DSH 版本没有可用的模型服务');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  let text = '';
  let finish;
  try {
    const options = {
      provider: route.provider,
      model: route.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      temperature: 0.2,
      maxTokens,
      signal: controller.signal,
    };
    if (system) options.system = system;
    for await (const chunk of llm.stream(options)) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
      else if (chunk?.type === 'finish') finish = chunk;
    }
  } catch (error) {
    if (controller.signal.aborted) fail('model_timeout', '模型调用超时，请稍后重试');
    fail('model_error', `模型调用失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
  const reason = finish?.reason;
  if (reason?.kind === 'aborted') {
    if (controller.signal.aborted) fail('model_timeout', '模型调用超时，请稍后重试');
    fail('model_error', `模型调用已中止：${reason.failure?.message ?? '未知原因'}`);
  }
  if (reason?.kind === 'error') {
    fail('model_error', `模型调用失败：${reason.failure?.message ?? '未知错误'}`);
  }
  return text;
}

/**
 * Generate a 3-6 Chinese-character display name for a skill.
 * @returns {Promise<{displayName:string, slug:string}>}
 */
export async function generateName(ctx, { body = '', description = '', slug = '' } = {}) {
  const content = stripFrontmatter(String(body ?? '')).trim().slice(0, MAX_NAME_CONTENT);
  if (!content && !String(description ?? '').trim()) fail('invalid_skill', '缺少可供命名的 Skill 内容');
  const route = await resolveRoute(ctx);
  const system =
    '你是 DSH Skill 命名助手。请阅读 Skill 内容，为它生成一个 3-6 个汉字的简短中文名称。' +
    '只输出 JSON，格式为 {"displayName":"名称"}，不要输出任何其他文字、标点或代码块。';
  const user = [
    `Skill 标识：${slug || '未知'}`,
    description ? `现有描述：${description}` : '',
    'Skill 内容：',
    content || '（无正文，仅有描述）',
    '',
    '请按上述要求只输出 JSON。',
  ]
    .filter((line) => line !== '')
    .join('\n');
  const text = await complete(ctx, { route, system, user, maxTokens: 200 });
  const data = parseModelJson(text);
  if (!data) fail('model_error', '模型返回的名称不是有效 JSON');
  const named = normalizeAiName(data, { body: content, description });
  return { displayName: named.displayName, slug: named.slug, description: named.description ?? '' };
}

/**
 * Best-effort naming: a missing or failing model must never block an import,
 * so the caller gets a warning and a deterministic fallback instead.
 */
export async function tryGenerateName(ctx, { body = '', description = '', slug = '', fallback = '' } = {}) {
  try {
    const named = await generateName(ctx, { body, description, slug });
    return { displayName: named.displayName, slug: named.slug, degraded: false };
  } catch (error) {
    if (!['no_model', 'model_error', 'model_timeout', 'invalid_skill'].includes(error?.code)) throw error;
    return {
      displayName: fallback,
      slug: '',
      degraded: true,
      warning: `AI 命名不可用：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Draft a full skill from a one-sentence request.
 * @returns {Promise<{displayName:string, slug:string, description:string, whenToUse?:string, body:string}>}
 */
export async function generateDraft(ctx, { prompt = '' } = {}) {
  const text = String(prompt ?? '').trim();
  if (!text) fail('invalid_skill', '请先输入一句话需求');
  if (Array.from(text).length > MAX_PROMPT_CHARS) fail('invalid_skill', `需求描述不能超过 ${MAX_PROMPT_CHARS} 个字符`);
  const route = await resolveRoute(ctx);
  const system =
    '你是 DSH Skill 作者。根据用户的一句话需求，生成一个可直接使用的 DSH Skill。' +
    '严格输出 JSON，格式为 {"displayName":"3-6个汉字","description":"一句话描述","whenToUse":"可选，何时使用","body":"Markdown 提示词正文"}。' +
    'body 必须是完整的提示词：写清角色、执行步骤、输出格式与注意事项；正文控制在 200-400 字，保持紧凑。若需要脚本，可在正文中说明 scripts/ 目录下的脚本名称。不要输出任何 JSON 之外的内容。';
  const user = `用户需求：${text}\n\n请生成该 Skill，并只输出 JSON。`;
  const raw = await complete(ctx, { route, system, user, maxTokens: 4_000 });
  const data = parseModelJson(raw);
  if (!data) fail('model_error', '模型返回的 Skill 不是有效 JSON');
  return normalizeAiDraft(data, { prompt: text });
}

/** Describe whether a model route exists, for the panel status line. */
export async function describeModel(ctx) {
  try {
    const route = await resolveRoute(ctx);
    return { available: true, provider: route.provider, model: route.model, source: route.source };
  } catch (error) {
    if (error?.code === 'no_model') return { available: false, reason: error.message };
    throw error;
  }
}
