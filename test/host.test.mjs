import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createService } from '../index.js';
import { resolveLayout } from '../lib/paths.js';
import { cleanup, callRoute, fakeContext, makeZipFixture, tempDir } from './helpers.mjs';

async function setup(options) {
  const root = await tempDir();
  const layout = resolveLayout(root);
  const ctx = fakeContext(options);
  const service = createService(ctx, { layout });
  return { root, layout, ctx, service };
}

async function post(service, body) {
  return callRoute(service, '/dsh-skill-manager/action', { method: 'POST', body });
}

test('state route reports skills, model and limits', async () => {
  const { root, service } = await setup();
  try {
    const { status, payload } = await callRoute(service, '/dsh-skill-manager/state');
    assert.equal(status, 200);
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.skills, []);
    assert.equal(payload.model.available, true);
    assert.equal(payload.model.model, 'deepseek-flash');
    assert.equal(payload.limits.maxStaging, 5);
    assert.equal(payload.limits.stagingTtlMinutes, 30);
  } finally {
    await cleanup(root);
  }
});

test('create without a name asks the default model for a 3-6 character name', async () => {
  const { root, service, layout } = await setup({ reply: '{"displayName":"文档解析"}' });
  try {
    const body = '# 文档解析\n\n读取 PDF 并总结要点。';
    const { status, payload } = await post(service, { action: 'create', body });
    assert.equal(status, 200);
    assert.equal(payload.skill.displayName, '文档解析');
    assert.match(payload.skill.slug, /^custom-[0-9a-f]{8}-skill$/);
    assert.equal(payload.naming.degraded, false);
    assert.equal(payload.skill.modelInvocable, false);
    const file = await readFile(`${layout.skills}/${payload.skill.slug}/SKILL.md`, 'utf8');
    assert.match(file, /displayName: "文档解析"/);
  } finally {
    await cleanup(root);
  }
});

test('manual names win over the model and duplicate slugs conflict', async () => {
  const { root, service } = await setup();
  try {
    const body = '# 我的技能\n\n做点什么。';
    const first = await post(service, { action: 'create', displayName: '我的技能', body });
    assert.equal(first.payload.skill.displayName, '我的技能');
    const second = await post(service, { action: 'create', displayName: '我的技能', body });
    assert.equal(second.status, 409);
    assert.equal(second.payload.error.code, 'conflict');
  } finally {
    await cleanup(root);
  }
});

test('mounts are added, listed and removed per session', async () => {
  const { root, service } = await setup();
  try {
    const created = await post(service, { action: 'create', displayName: '挂载技能', body: '# 挂载技能\n\n步骤。' });
    const slug = created.payload.skill.slug;

    const added = await post(service, { action: 'mounts', sessionId: 'session-abc', add: [slug] });
    assert.equal(added.status, 200);
    assert.deepEqual(added.payload.mounted, [slug]);

    const listed = await callRoute(service, `/dsh-skill-manager/session?sessionId=session-abc`);
    assert.deepEqual(listed.payload.mounted, [slug]);
    assert.equal(listed.payload.skills[0].displayName, '挂载技能');

    const removed = await post(service, { action: 'mounts', sessionId: 'session-abc', remove: [slug] });
    assert.deepEqual(removed.payload.mounted, []);

    const unknown = await post(service, { action: 'mounts', sessionId: 'session-abc', add: ['missing-skill'] });
    assert.equal(unknown.status, 404);
  } finally {
    await cleanup(root);
  }
});

test('unknown mounts are rejected by the session route', async () => {
  const { root, service } = await setup();
  try {
    const { status, payload } = await callRoute(service, '/dsh-skill-manager/session');
    assert.equal(status, 400);
    assert.equal(payload.error.code, 'bad_request');
  } finally {
    await cleanup(root);
  }
});

test('delete removes the skill and clears mounts', async () => {
  const { root, service } = await setup();
  try {
    const created = await post(service, { action: 'create', displayName: '删除技能', body: '# 删除\n\n内容。' });
    const slug = created.payload.skill.slug;
    await post(service, { action: 'mounts', sessionId: 'session-1', add: [slug] });
    const deleted = await post(service, { action: 'delete', slug });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.payload.unmountedSessions, 1);
    const state = await callRoute(service, '/dsh-skill-manager/state');
    assert.deepEqual(state.payload.skills, []);
  } finally {
    await cleanup(root);
  }
});

test('generate drafts a skill from one sentence', async () => {
  const { root, service } = await setup({
    reply: '```json\n{"displayName":"周报助手","description":"写周报","body":"# 周报\\n\\n整理本周工作"}\n```',
  });
  try {
    const { status, payload } = await post(service, { action: 'generate', prompt: '帮我写周报' });
    assert.equal(status, 200);
    assert.equal(payload.draft.displayName, '周报助手');
    assert.match(payload.draft.body, /周报/);
    assert.match(payload.draft.slug, /-skill$/);
  } finally {
    await cleanup(root);
  }
});

test('archive upload stages a preview and installs it on confirm', async () => {
  const { root, service, layout } = await setup();
  try {
    const zip = await makeZipFixture(root);
    const raw = await readFile(zip);
    const imported = await callRoute(service, '/dsh-skill-manager/import', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-skill-manager-filename': encodeURIComponent('demo.zip') },
      body: raw,
    });
    assert.equal(imported.status, 200);
    const preview = imported.payload.preview;
    assert.equal(preview.name, 'demo-skill');
    assert.deepEqual(preview.scripts.map((file) => file.path), ['scripts/run.sh']);

    const confirmed = await post(service, { action: 'create-imported', stagingId: preview.stagingId, autoSummary: false });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.payload.skill.displayName, '文档解析');
    assert.deepEqual(confirmed.payload.skill.scripts.map((file) => file.path), ['run.sh']);
    assert.equal(confirmed.payload.warnings.length, 0);
    assert.ok(layout.skills.startsWith(root));
  } finally {
    await cleanup(root);
  }
});

test('a corrupt archive is refused without touching the store', async () => {
  const { root, service } = await setup();
  try {
    const imported = await callRoute(service, '/dsh-skill-manager/import', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-skill-manager-filename': 'broken.zip' },
      body: Buffer.from('this is not an archive'),
    });
    assert.equal(imported.status, 415);
    assert.equal(imported.payload.ok, false);
  } finally {
    await cleanup(root);
  }
});

test('cross-site requests are refused', async () => {
  const { root, service } = await setup();
  try {
    const response = await callRoute(service, '/dsh-skill-manager/state', { headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(response.status, 403);
    assert.equal(response.payload.ok, false);
  } finally {
    await cleanup(root);
  }
});

test('unknown actions and methods are refused', async () => {
  const { root, service } = await setup();
  try {
    const unknown = await post(service, { action: 'nope' });
    assert.equal(unknown.status, 400);
    const wrongMethod = await callRoute(service, '/dsh-skill-manager/state', { method: 'POST', body: {} });
    assert.equal(wrongMethod.status, 405);
  } finally {
    await cleanup(root);
  }
});

test('create writes imported scripts under scripts/ and documents the environment note', async () => {
  const { root, service, layout } = await setup({ reply: '{"displayName":"表格转换"}' });
  try {
    const created = await post(service, {
      action: 'create',
      displayName: '表格转换',
      body: '# 表格转换\n\n把 CSV 转成 Markdown。',
      autoSummary: false,
      scripts: [
        { name: 'csv2md.py', content: '#!/usr/bin/env python3\nprint("ok")\n' },
        { name: 'csv2md.ps1', content: 'Write-Output ok\n' },
      ],
    });
    assert.equal(created.status, 200);
    assert.deepEqual(created.payload.scripts.map((script) => script.name), ['csv2md.py', 'csv2md.ps1']);
    assert.deepEqual(created.payload.warnings, []);
    const skillDir = `${layout.skills}/${created.payload.skill.slug}`;
    const stored = await post(service, { action: 'content', slug: created.payload.skill.slug });
    assert.deepEqual(stored.payload.skill.scripts.map((script) => script.path).sort(), ['csv2md.ps1', 'csv2md.py']);
    const markdown = await readFile(`${skillDir}/SKILL.md`, 'utf8');
    assert.match(markdown, /脚本与环境/);
  } finally {
    await cleanup(root);
  }
});

test('create rejects a script outside scripts/ and leaves no skill behind', async () => {
  const { root, service, layout } = await setup();
  try {
    const created = await post(service, {
      action: 'create',
      displayName: '坏脚本',
      body: '# 坏脚本\n\n内容。',
      scripts: [{ name: 'bin/evil.py', content: 'print(1)' }],
    });
    assert.equal(created.status, 422);
    assert.equal(created.payload.ok, false);
    const remaining = existsSync(layout.skills) ? await readdir(layout.skills) : [];
    assert.deepEqual(remaining, []);
  } finally {
    await cleanup(root);
  }
});

test('generate forwards withScripts and reports pairing warnings', async () => {
  const { root, service } = await setup({
    replies: [
      '{"displayName":"表格转换","description":"CSV 转 Markdown","body":"# 表格\\n\\n按环境选择 scripts/ 下脚本。"}',
      '===FILE: scripts/run.sh===\n#!/bin/sh\necho hi\n===END===\n',
      '{"displayName":"表格转换","description":"CSV 转 Markdown","body":"# 表格\\n\\n按环境选择 scripts/ 下脚本。"}',
    ],
  });
  try {
    const generated = await post(service, { action: 'generate', prompt: 'CSV 转 Markdown', withScripts: true });
    assert.equal(generated.status, 200);
    assert.deepEqual(generated.payload.draft.scripts.map((script) => script.name), ['run.sh']);
    assert.ok(generated.payload.draft.warnings.some((warning) => warning.includes('Windows')));
    const plain = await post(service, { action: 'generate', prompt: 'CSV 转 Markdown' });
    assert.deepEqual(plain.payload.draft.scripts, []);
  } finally {
    await cleanup(root);
  }
});

test('mount-info reports the workspace and session labels of every mount', async () => {
  const services = {
    workspaceRegistry: {
      list: () => [
        { id: 'ws-1', title: 'dsh-dev', path: '/tmp/dsh-dev', sessionIds: ['session-a', 'session-b'] },
      ],
    },
    sessionQuery: {
      readTitleSnapshots: async (ids) =>
        ids.map((sessionId) => ({
          sessionId,
          status: 'fulfilled',
          value: { title: { title: sessionId === 'session-a' ? '会话甲' : '会话乙' } },
        })),
    },
  };
  const { root, service } = await setup({ services });
  try {
    const created = await post(service, { action: 'create', displayName: '挂载位置', body: '# 挂载位置\n\n查看挂载。' });
    const slug = created.payload.skill.slug;
    await post(service, { action: 'mounts', sessionId: 'session-a', add: [slug] });
    await post(service, { action: 'mounts', sessionId: 'session-b', add: [slug] });
    const info = await post(service, { action: 'mount-info', slug });
    assert.equal(info.status, 200);
    assert.equal(info.payload.skill.slug, slug);
    assert.equal(info.payload.skill.mountedSessions, 2);
    const byId = new Map(info.payload.sessions.map((entry) => [entry.sessionId, entry]));
    assert.equal(byId.get('session-a').title, '会话甲');
    assert.equal(byId.get('session-a').workspaceTitle, 'dsh-dev');
    assert.equal(byId.get('session-b').title, '会话乙');
    assert.equal(byId.get('session-b').workspacePath, '/tmp/dsh-dev');
    assert.ok(byId.get('session-a').mountedAt);
  } finally {
    await cleanup(root);
  }
});

test('mount-info rejects unknown and missing slugs', async () => {
  const { root, service } = await setup();
  try {
    const unknown = await post(service, { action: 'mount-info', slug: 'nope-skill' });
    assert.equal(unknown.status, 404);
    const missing = await post(service, { action: 'mount-info' });
    assert.equal(missing.status, 400);
  } finally {
    await cleanup(root);
  }
});

test('create honours the requested invocation mode and the switch rewrites only one line', async () => {
  const { root, service, layout } = await setup();
  try {
    const created = await post(service, {
      action: 'create',
      displayName: '自动技能',
      body: '# 自动技能\n\n## 步骤\n1. 做点什么。',
      invocation: 'auto',
    });
    assert.equal(created.status, 200);
    const slug = created.payload.skill.slug;
    assert.equal(created.payload.skill.modelInvocable, true);
    assert.equal(created.payload.skill.invocation, 'auto');
    assert.equal(created.payload.skill.name, slug);
    assert.equal(created.payload.skill.token, `/${slug}`);

    const file = `${layout.skills}/${slug}/SKILL.md`;
    const before = await readFile(file, 'utf8');
    assert.doesNotMatch(before, /disable-model-invocation/);

    const turnedOff = await post(service, { action: 'set-invocation', slug, invocation: 'manual' });
    assert.equal(turnedOff.status, 200);
    assert.equal(turnedOff.payload.changed, true);
    assert.equal(turnedOff.payload.skill.modelInvocable, false);
    const after = await readFile(file, 'utf8');
    const beforeLines = before.split('\n');
    const afterLines = after.split('\n');
    const diff = afterLines.filter((line) => !beforeLines.includes(line));
    assert.deepEqual(diff.filter((line) => line.trim()), ['disable-model-invocation: true']);

    const again = await post(service, { action: 'set-invocation', slug, invocation: 'manual' });
    assert.equal(again.payload.changed, false);

    const turnedOn = await post(service, { action: 'set-invocation', slug, invocation: 'auto' });
    assert.equal(turnedOn.status, 200);
    assert.equal(turnedOn.payload.changed, true);
    assert.doesNotMatch(await readFile(file, 'utf8'), /disable-model-invocation/);
  } finally {
    await cleanup(root);
  }
});

test('skills from outside the panel are listed, marked external and use their frontmatter name', async () => {
  const { root, service, layout } = await setup();
  try {
    const dir = `${layout.skills}/kb-tool`;
    await mkdir(dir, { recursive: true });
    await writeFile(
      `${dir}/SKILL.md`,
      '---\nname: kb-tool\ndescription: 外部导入的知识库工具\n---\n\n# 知识库工具\n\n正文。\n',
      'utf8',
    );

    const state = await callRoute(service, '/dsh-skill-manager/state');
    assert.equal(state.status, 200);
    const found = state.payload.skills.find((skill) => skill.slug === 'kb-tool');
    assert.ok(found);
    assert.equal(found.displayName, 'Kb Tool');
    assert.equal(found.managed, false);
    assert.equal(found.name, 'kb-tool');
    assert.equal(found.token, '/kb-tool');
    assert.equal(found.invocation, 'auto');

    const toggled = await post(service, { action: 'set-invocation', slug: 'kb-tool', invocation: 'manual' });
    assert.equal(toggled.status, 200);
    assert.equal(toggled.payload.skill.name, 'kb-tool');
    assert.match(await readFile(`${dir}/SKILL.md`, 'utf8'), /disable-model-invocation: true/);
  } finally {
    await cleanup(root);
  }
});

test('directory name and name mismatches are reported, and directory order does not matter', async () => {
  const { root, service, layout } = await setup();
  try {
    const dir = `${layout.skills}/folder-name`;
    await mkdir(dir, { recursive: true });
    await writeFile(`${dir}/SKILL.md`, '---\nname: other-name\ndescription: 名称不同的技能\n---\n\n# 正文\n\n内容。\n', 'utf8');

    const state = await callRoute(service, '/dsh-skill-manager/state');
    const found = state.payload.skills.find((skill) => skill.slug === 'folder-name');
    assert.ok(found);
    assert.equal(found.name, 'other-name');
    assert.equal(found.token, '/other-name');
    assert.equal(found.nameMismatch, true);
  } finally {
    await cleanup(root);
  }
});

test('unloadable directories are reported as invalid instead of disappearing', async () => {
  const { root, service, layout } = await setup();
  try {
    const bad = `${layout.skills}/Bad_Dir`;
    await mkdir(bad, { recursive: true });
    await writeFile(`${bad}/SKILL.md`, '---\nname: Bad_Dir\ndescription: 本地目录\n---\n\n# 正文\n\n内容。\n', 'utf8');
    const emptyFile = `${layout.skills}/no-frontmatter`;
    await mkdir(emptyFile, { recursive: true });
    await writeFile(`${emptyFile}/SKILL.md`, '# 没有 frontmatter\n', 'utf8');

    const state = await callRoute(service, '/dsh-skill-manager/state');
    assert.equal(state.payload.skills.length, 0);
    const bySlug = Object.fromEntries(state.payload.invalid.map((item) => [item.slug, item.message]));
    assert.match(bySlug['Bad_Dir'] || '', /kebab-case/);
    assert.match(bySlug['no-frontmatter'] || '', /frontmatter/);
  } finally {
    await cleanup(root);
  }
});

test('AI creation also generates the card summary and usage lines', async () => {
  const { root, service, layout } = await setup({
    replies: [
      '{"displayName":"要点整理"}',
      JSON.stringify({ summary: '把长文压缩成要点清单。', usage: '用 /<name> 显式调用，或自动注入时处理长文。' }),
    ],
  });
  try {
    const created = await post(service, { action: 'create', body: '# 要点整理\n\n把长文整理成 3-6 条要点。', invocation: 'manual' });
    assert.equal(created.status, 200);
    const slug = created.payload.skill.slug;
    const state = await callRoute(service, '/dsh-skill-manager/state');
    const skill = state.payload.skills.find((item) => item.slug === slug);
    assert.equal(skill.summary, '把长文压缩成要点清单。');
    assert.match(skill.usage, /显式调用/);
    assert.equal(skill.summaryStale, false);
    assert.ok(existsSync(`${layout.manager}/summaries/${slug}.json`));
  } finally {
    await cleanup(root);
  }
});

test('manual create keeps the filled summary and skips the model when asked', async () => {
  const { root, service } = await setup({ replies: ['not json'] });
  try {
    const created = await post(service, {
      action: 'create',
      displayName: '手写技能',
      body: '# 手写技能\n\n正文。',
      summary: '用户自己写的摘要。',
      usage: '用 /手写 调用。',
      autoSummary: false,
    });
    assert.equal(created.status, 200);
    assert.equal(created.payload.warnings.length, 0);
    const state = await callRoute(service, '/dsh-skill-manager/state');
    const skill = state.payload.skills.find((item) => item.slug === created.payload.skill.slug);
    assert.equal(skill.summary, '用户自己写的摘要。');
    assert.equal(skill.usage, '用 /手写 调用。');
  } finally {
    await cleanup(root);
  }
});

test('generate-summary reruns the model for an existing skill and tracks staleness', async () => {
  const { root, service, layout } = await setup({
    replies: [
      JSON.stringify({ summary: '第一版摘要。', usage: '用 /first 调用。' }),
      JSON.stringify({ summary: '第二版摘要。', usage: '用 /second 调用。' }),
    ],
  });
  try {
    const created = await post(service, { action: 'create', displayName: '重新总结', body: '# 重新总结\n\n初版正文。', invocation: 'manual' });
    const slug = created.payload.skill.slug;

    const file = `${layout.skills}/${slug}/SKILL.md`;
    const edited = `${await readFile(file, 'utf8')}\n\n补充一段新步骤。\n`;
    await writeFile(file, edited, 'utf8');

    const staleState = await callRoute(service, '/dsh-skill-manager/state');
    assert.equal(staleState.payload.skills.find((item) => item.slug === slug).summaryStale, true);

    const regenerated = await post(service, { action: 'generate-summary', slug });
    assert.equal(regenerated.status, 200);
    assert.equal(regenerated.payload.summary, '第二版摘要。');

    const freshState = await callRoute(service, '/dsh-skill-manager/state');
    const skill = freshState.payload.skills.find((item) => item.slug === slug);
    assert.equal(skill.summary, '第二版摘要。');
    assert.equal(skill.summaryStale, false);
  } finally {
    await cleanup(root);
  }
});

test('deleting a skill removes its stored summary', async () => {
  const { root, service, layout } = await setup({
    replies: [JSON.stringify({ summary: '临时摘要。', usage: '临时用法。' })],
  });
  try {
    const created = await post(service, { action: 'create', displayName: '待删除', body: '# 待删除\n\n正文。' });
    const slug = created.payload.skill.slug;
    assert.ok(existsSync(`${layout.manager}/summaries/${slug}.json`));
    const removed = await post(service, { action: 'delete', slug });
    assert.equal(removed.status, 200);
    assert.equal(existsSync(`${layout.manager}/summaries/${slug}.json`), false);
  } finally {
    await cleanup(root);
  }
});
