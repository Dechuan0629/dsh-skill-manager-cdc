import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { cleanup, tempDir } from './helpers.mjs';
import { SkillError } from '../lib/errors.js';
import {
  hashSlug,
  isSkillDirName,
  normalizeSlug,
  normalizeUserSlug,
  resolveLayout,
  safeJoin,
  writeFileAtomic,
} from '../lib/paths.js';
import { SummaryStore, bodyDigest } from '../lib/summaries.js';
import {
  findSkillFile,
  parseSkillMarkdown,
  rewriteInvocationPolicy,
  serializeSkillMarkdown,
  skillLoadIssues,
  validateFinalSkill,
} from '../lib/manifest.js';
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

test('slug rules: skill directories are any ascii kebab name', () => {
  assert.equal(normalizeSlug('Doc Parser'), 'doc-parser-skill');
  assert.equal(normalizeSlug('doc-parser-skill'), 'doc-parser-skill');
  assert.equal(normalizeUserSlug('Demo Tool'), 'demo-tool');
  assert.equal(normalizeUserSlug('tdd'), 'tdd');
  assert.ok(isSkillDirName('demo'));
  assert.ok(isSkillDirName('demo-skill'));
  assert.ok(!isSkillDirName('Demo-Skill'));
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
  validateFinalSkill(parsed, { expectedSlug: null });
  expectCode(() => validateFinalSkill(parsed, { expectedSlug: 'other-skill' }), 'invalid_skill');
});

test('skillLoadIssues mirrors DSH load rules and flags legacy keys', () => {
  const ok = parseSkillMarkdown(serializeSkillMarkdown({ name: 'tdd', description: '测试驱动', body: '# TDD' }));
  assert.deepEqual(skillLoadIssues(ok), []);
  const missing = parseSkillMarkdown('---\nname: tdd\n---\nbody');
  assert.ok(skillLoadIssues(missing).some((issue) => issue.includes('description')));
  const legacy = parseSkillMarkdown('---\nname: tdd\ndescription: d\nmodelInvocable: true\n---\nbody');
  assert.deepEqual(legacy.legacyKeys.map((entry) => entry.key), ['modelInvocable']);
  assert.ok(skillLoadIssues(legacy).some((issue) => issue.includes('modelInvocable')));
});

test('rewriteInvocationPolicy only touches the policy line', () => {
  const manual = '---\nname: "demo"\ndescription: "d"\ndisplayName: "演示"\nwhenToUse: "x"\n---\n\n# body\n';
  const toAuto = rewriteInvocationPolicy(`${manual.replace('whenToUse: "x"\n', 'whenToUse: "x"\ndisable-model-invocation: true\n')}`, { modelInvocable: true });
  assert.equal(toAuto.changed, true);
  assert.ok(!toAuto.text.includes('disable-model-invocation'));
  assert.ok(toAuto.text.includes('displayName: "演示"'));
  const toManual = rewriteInvocationPolicy(manual, { modelInvocable: false });
  assert.equal(toManual.changed, true);
  assert.equal(
    toManual.text,
    '---\nname: "demo"\ndescription: "d"\ndisplayName: "演示"\nwhenToUse: "x"\ndisable-model-invocation: true\n---\n\n# body\n',
  );
  const idempotent = rewriteInvocationPolicy(toManual.text, { modelInvocable: false });
  assert.equal(idempotent.changed, false);
  assert.equal(idempotent.text, toManual.text);
});

test('rewriteInvocationPolicy preserves CRLF and repairs legacy keys', () => {
  const crlf = '---\r\nname: "demo"\r\ndescription: "d"\r\ndisable-model-invocation: true\r\nmodelInvocable: true\r\n---\r\n\r\nbody\r\n';
  const result = rewriteInvocationPolicy(crlf, { modelInvocable: true });
  assert.equal(result.changed, true);
  assert.deepEqual(result.repaired, ['modelInvocable']);
  assert.ok(!result.text.includes('disable-model-invocation'));
  assert.ok(result.text.includes('\r\nname: "demo"\r\n'));
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

test('script names are normalized and whitelisted', async () => {
  const { normalizeScriptList, normalizeScriptName, withEnvironmentNote } = await import('../lib/scripts.js');
  assert.equal(normalizeScriptName('scripts/run.py'), 'run.py');
  assert.equal(normalizeScriptName('run.PS1'), 'run.ps1');
  expectCode(() => normalizeScriptName('../evil.py'), 'invalid_skill');
  expectCode(() => normalizeScriptName('bin/tool.py'), 'invalid_skill');
  expectCode(() => normalizeScriptName('payload.exe'), 'invalid_skill');
  const { scripts, warnings } = normalizeScriptList([
    { path: 'scripts/run.sh', content: '#!/bin/sh\necho hi\n' },
    { name: 'run.sh', content: 'duplicate' },
  ]);
  assert.deepEqual(scripts.map((script) => script.name), ['run.sh']);
  assert.ok(warnings.some((warning) => warning.includes('重复')));
  assert.ok(warnings.some((warning) => warning.includes('Windows')));
  const body = withEnvironmentNote('# demo\n\n步骤。', scripts);
  assert.match(body, /脚本与环境/);
  assert.equal(withEnvironmentNote(body, scripts), body);
});

test('summary records are keyed by directory and detect stale bodies', async () => {
  const root = await tempDir();
  try {
    const layout = resolveLayout(root);
    const store = new SummaryStore(layout);
    await store.load();
    assert.equal(store.get('demo-skill'), undefined);

    await store.set('demo-skill', { summary: '把文本整理成要点', usage: '用 /demo-skill 调用', bodyHash: bodyDigest('one') });
    assert.equal(store.get('demo-skill').summary, '把文本整理成要点');

    const reloaded = new SummaryStore(layout);
    await reloaded.load();
    assert.equal(reloaded.get('demo-skill').usage, '用 /demo-skill 调用');

    const fresh = await reloaded.snapshot('demo-skill', 'one');
    assert.equal(fresh.stale, false);
    const stale = await reloaded.snapshot('demo-skill', 'two');
    assert.equal(stale.stale, true);

    await reloaded.remove('demo-skill');
    assert.equal(reloaded.get('demo-skill'), undefined);
    assert.equal(existsSync(`${layout.manager}/summaries/demo-skill.json`), false);
  } finally {
    await cleanup(root);
  }
});
