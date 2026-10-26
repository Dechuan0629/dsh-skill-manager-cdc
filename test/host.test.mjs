import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

    const confirmed = await post(service, { action: 'create-imported', stagingId: preview.stagingId });
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
