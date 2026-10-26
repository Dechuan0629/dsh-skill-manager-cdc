import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { cleanup, tempDir } from './helpers.mjs';
import { SkillError } from '../lib/errors.js';
import {
  hashSlug,
  isManagedSkillId,
  normalizeSlug,
  resolveLayout,
  safeJoin,
  writeFileAtomic,
} from '../lib/paths.js';
import { findSkillFile, parseSkillMarkdown, serializeSkillMarkdown, validateFinalSkill } from '../lib/manifest.js';
import {
  deriveSlug,
  normalizeAiDisplayName,
  normalizeManualDisplayName,
  parseModelJson,
} from '../lib/naming.js';
import { MountStore } from '../lib/store.js';

function expectCode(fn, code) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof SkillError, `expected SkillError, got ${error}`);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`expected ${code}`);
}

test('layout lives under the DSH home', async () => {
  const root = await tempDir();
  try {
    const layout = resolveLayout(root);
    assert.equal(layout.home, path.resolve(root));
    assert.equal(layout.skills, path.join(path.resolve(root), 'skills'));
    assert.equal(layout.stateFile, path.join(path.resolve(root), 'skill-manager', 'state.json'));
  } finally {
    await cleanup(root);
  }
});

test('slug rules: managed ids end with -skill and stay ascii kebab', () => {
  assert.equal(normalizeSlug('Doc Parser'), 'doc-parser-skill');
  assert.equal(normalizeSlug('doc-parser-skill'), 'doc-parser-skill');
  assert.ok(isManagedSkillId('demo-skill'));
  assert.ok(!isManagedSkillId('demo'));
  assert.ok(!isManagedSkillId('Demo-Skill'));
  assert.ok(hashSlug('中文名', 'body').startsWith('custom-'));
});

test('safeJoin refuses traversal and absolute paths', () => {
  const root = path.resolve('/tmp/skills');
  assert.equal(safeJoin(root, 'a/b.txt'), path.join(root, 'a', 'b.txt'));
  expectCode(() => safeJoin(root, '../evil.txt'), 'bad_request');
  expectCode(() => safeJoin(root, '/etc/passwd'), 'bad_request');
});

test('SKILL.md frontmatter round trips and validates', () => {
  const text = serializeSkillMarkdown({
    name: 'demo-skill',
    description: '一句话描述',
    displayName: '示例技能',
    whenToUse: '需要示例时',
    body: '# 标题\n\n步骤一',
    modelInvocable: false,
  });
  const parsed = parseSkillMarkdown(text);
  assert.equal(parsed.name, 'demo-skill');
  assert.equal(parsed.description, '一句话描述');
  assert.equal(parsed.displayName, '示例技能');
  assert.equal(parsed.modelInvocable, false);
  assert.equal(parsed.userInvocable, true);
  assert.match(parsed.body, /步骤一/);
  validateFinalSkill(parsed, { expectedSlug: 'demo-skill' });
  expectCode(() => validateFinalSkill(parsed, { expectedSlug: 'other-skill' }), 'invalid_skill');
});

test('findSkillFile accepts a lowercase skill.md', async () => {
  const root = await tempDir();
  try {
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, 'skill.md'), 'a');
    const files = await findSkillFile(root);
    assert.equal(files.length, 1);
    assert.equal(path.basename(files[0]), 'skill.md');
  } finally {
    await cleanup(root);
  }
});

test('display name policy: ai names are 3-6 chars, manual names require input', () => {
  assert.equal(normalizeAiDisplayName('文档解析助手'), '文档解析助手');
  assert.equal(Array.from(normalizeAiDisplayName('超长名称示例技能')).length, 6);
  assert.equal(normalizeAiDisplayName(''), '自定义技能');
  expectCode(() => normalizeManualDisplayName('  '), 'invalid_skill');
  assert.equal(deriveSlug({ explicitSlug: 'My Skill' }), 'my-skill');
});

test('parseModelJson accepts fenced and bare json', () => {
  assert.deepEqual(parseModelJson('```json\n{"displayName":"文档助手"}\n```'), { displayName: '文档助手' });
  assert.deepEqual(parseModelJson('前缀 {"displayName":"文档助手"} 后缀'), { displayName: '文档助手' });
  assert.equal(parseModelJson('not json'), undefined);
});

test('mount store persists per-session mounts and clears deleted skills', async () => {
  const root = await tempDir();
  try {
    const layout = resolveLayout(root);
    const store = new MountStore(layout.stateFile);
    assert.deepEqual(await store.get('session-1'), []);
    assert.deepEqual(await store.set('session-1', ['a-skill', 'b-skill']), ['a-skill', 'b-skill']);
    await store.flush();

    const reopened = new MountStore(layout.stateFile);
    assert.deepEqual(await reopened.get('session-1'), ['a-skill', 'b-skill']);
    assert.equal(await reopened.removeSkill('a-skill'), 1);
    assert.deepEqual(await reopened.get('session-1'), ['b-skill']);
    assert.deepEqual(await reopened.counts(), { 'b-skill': 1 });
  } finally {
    await cleanup(root);
  }
});

test('mount store recovers from a corrupt state file', async () => {
  const root = await tempDir();
  try {
    const layout = resolveLayout(root);
    await mkdir(path.dirname(layout.stateFile), { recursive: true });
    await writeFileAtomic(layout.stateFile, '{not json', 0o600);
    const store = new MountStore(layout.stateFile);
    assert.deepEqual(await store.get('session-1'), []);
    assert.deepEqual(await store.snapshot(), { version: 1, sessions: {} });
  } finally {
    await cleanup(root);
  }
});
