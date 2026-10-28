import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeModel, generateDraft, generateName, tryGenerateName } from '../lib/llm.js';
import { fakeContext } from './helpers.mjs';

function emptyContext() {
  return { get: () => undefined, logger: { warn() {} }, effect() {} };
}

test('generateName uses the DSH default model selection', async () => {
  const ctx = fakeContext({ reply: '{"displayName":"文档解析"}' });
  const named = await generateName(ctx, { body: '# 文档解析\n\n读取 PDF。', description: '解析文档', slug: 'demo-skill' });
  assert.equal(named.displayName, '文档解析');
  assert.match(named.slug, /^custom-[0-9a-f]{8}-skill$/);
});

test('generateName fails with no_model when DSH has no model configured', async () => {
  await assert.rejects(
    () => generateName(emptyContext(), { body: '# demo\n\n内容', slug: 'demo-skill' }),
    (error) => error.code === 'no_model',
  );
});

test('tryGenerateName degrades instead of blocking an import', async () => {
  const named = await tryGenerateName(emptyContext(), { body: '# demo-skill\n\n内容', slug: 'demo-skill', fallback: '示例技能' });
  assert.equal(named.degraded, true);
  assert.equal(named.displayName, '示例技能');
  assert.match(named.warning, /AI 命名不可用/);
});

test('generateDraft normalizes a fenced model answer', async () => {
  const ctx = fakeContext({
    reply: '```json\n{"displayName":"周报助手","description":"生成周报","whenToUse":"每周五","body":"# 周报\\n\\n整理工作"}\n```',
  });
  const draft = await generateDraft(ctx, { prompt: '每周帮我写周报' });
  assert.equal(draft.displayName, '周报助手');
  assert.equal(draft.description, '生成周报');
  assert.equal(draft.whenToUse, '每周五');
  assert.match(draft.body, /整理工作/);
});

test('generateDraft rejects a model answer without JSON', async () => {
  const ctx = fakeContext({ reply: '抱歉，我无法完成。' });
  await assert.rejects(
    () => generateDraft(ctx, { prompt: '写个技能' }),
    (error) => error.code === 'model_error',
  );
});

test('describeModel reports unavailability without throwing', async () => {
  const described = await describeModel(emptyContext());
  assert.equal(described.available, false);
  assert.match(described.reason, /模型/);
});

test('generateDraft adds marker-parsed scripts when withScripts is set', async () => {
  const draftJson =
    '{"displayName":"表格转换","description":"CSV 转 Markdown","body":"# 表格\\n\\n按环境选择 scripts/ 下脚本。"}';
  const scriptText = [
    '===FILE: scripts/csv2md.py===',
    '#!/usr/bin/env python3',
    'print("ok")',
    '===END===',
    '',
    '===FILE: scripts/csv2md.ps1===',
    'Write-Output ok',
    '===END===',
  ].join('\n');
  const ctx = fakeContext({ replies: [draftJson, scriptText, draftJson] });
  const withScripts = await generateDraft(ctx, { prompt: '把 CSV 转成 Markdown', withScripts: true });
  assert.equal(withScripts.displayName, '表格转换');
  assert.deepEqual(withScripts.scripts.map((script) => script.name), ['csv2md.py', 'csv2md.ps1']);
  assert.deepEqual(withScripts.warnings, []);
  const plain = await generateDraft(ctx, { prompt: '把 CSV 转成 Markdown' });
  assert.deepEqual(plain.scripts, []);
});
