import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { SkillCatalog } from '../lib/catalog.js';
import { resolveLayout } from '../lib/paths.js';
import { stagingEntryExists } from '../lib/staging.js';
import { StagingStore } from '../lib/staging.js';
import { cleanup, makeZipFixture, tempDir } from './helpers.mjs';

async function stageZip(root, layout, zipPath) {
  const store = new StagingStore(layout);
  const { id, dir } = await store.begin();
  const archiveFile = path.join(dir, 'archive.bin');
  await copyFile(zipPath, archiveFile);
  const preview = await store.prepare(id, archiveFile, { originalName: path.basename(zipPath) });
  return { store, id, preview };
}

test('staging accepts a <name>-skill wrapper archive', async () => {
  const root = await tempDir();
  try {
    const layout = resolveLayout(root);
    const zip = await makeZipFixture(root);
    const { store, id, preview } = await stageZip(root, layout, zip);
    assert.equal(preview.stagingId, id);
    assert.equal(preview.name, 'demo-skill');
    assert.equal(preview.displayName, '示例技能');
    assert.deepEqual(
      preview.scripts.map((file) => file.path),
      ['scripts/run.sh'],
    );
    const staged = await store.readStaged(id);
    assert.equal(staged.parsed.name, 'demo-skill');
    assert.match(staged.parsed.body, /步骤/);
  } finally {
    await cleanup(root);
  }
});

test('staging accepts skill files directly at the archive root', async () => {
  const root = await tempDir();
  try {
    const layout = resolveLayout(root);
    const zip = await makeZipFixture(root, { wrapper: '' });
    const { preview } = await stageZip(root, layout, zip);
    assert.equal(preview.name, 'demo-skill');
    assert.equal(preview.files, 2);
  } finally {
    await cleanup(root);
  }
});

test('staging normalizes a lowercase skill.md to SKILL.md', async () => {
  const root = await tempDir();
  try {
    const layout = resolveLayout(root);
    const zip = await makeZipFixture(root, { skillFile: 'skill.md' });
    const { store, id } = await stageZip(root, layout, zip);
    const staged = await store.readStaged(id);
    assert.ok(staged.skillDir.endsWith(path.join('skill')));
    assert.equal(staged.parsed.name, 'demo-skill');
  } finally {
    await cleanup(root);
  }
});

test('staging ignores unsupported files inside the skill directory', async () => {
  const root = await tempDir();
  try {
    const layout = resolveLayout(root);
    const zip = await makeZipFixture(root, { extra: { 'notes.txt': '不会导入', 'README.md': '# 说明' } });
    const { store, id } = await stageZip(root, layout, zip);
    const staged = await store.readStaged(id);
    assert.deepEqual(staged.meta.files.map((file) => file.path).sort(), ['SKILL.md', 'scripts/run.sh']);
    const preview = store.previewOf(staged.meta);
    assert.ok(preview.warnings.some((warning) => warning.includes('notes.txt')));
    assert.ok(preview.warnings.some((warning) => warning.includes('README.md')));
    assert.equal(existsSync(path.join(staged.skillDir, 'notes.txt')), false);
    assert.equal(existsSync(path.join(staged.skillDir, 'README.md')), false);
  } finally {
    await cleanup(root);
  }
});

test('staging rejects an archive without SKILL.md', async () => {
  const root = await tempDir();
  try {
    const layout = resolveLayout(root);
    const source = path.join(root, 'empty-skill');
    await mkdir(path.join(source, 'scripts'), { recursive: true });
    await writeFile(path.join(source, 'README.txt'), 'no skill file');
    const zip = path.join(root, 'empty.zip');
    execFileSync('/usr/bin/bsdtar', ['-a', '-c', '-f', zip, '-C', source, '.'], { stdio: 'ignore' });
    await assert.rejects(
      () => stageZip(root, layout, zip),
      (error) => error.code === 'invalid_skill',
    );
  } finally {
    await cleanup(root);
  }
});

test('staging refuses path traversal entries', async () => {
  const root = await tempDir();
  try {
    const layout = resolveLayout(root);
    const zip = path.join(root, 'evil.zip');
    const script = [
      'import zipfile, sys',
      `path = sys.argv[1]`,
      'with zipfile.ZipFile(path, "w") as archive:',
      '    archive.writestr("demo-skill/SKILL.md", "---\\nname: demo-skill\\ndescription: x\\n---\\nbody")',
      '    archive.writestr("../../evil.txt", "pwned")',
    ].join('\n');
    let available = true;
    try {
      execFileSync('python3', ['-c', script, zip], { stdio: 'ignore' });
    } catch {
      available = false;
    }
    if (!available) return;
    await assert.rejects(
      () => stageZip(root, layout, zip),
      (error) => error.code === 'bad_archive',
    );
  } finally {
    await cleanup(root);
  }
});

test('staging prune drops expired jobs and keeps fresh ones', async () => {
  const root = await tempDir();
  try {
    const layout = resolveLayout(root);
    const zip = await makeZipFixture(root);
    const store = new StagingStore(layout);
    const fresh = await stageZip(root, layout, zip);
    const old = await stageZip(root, layout, zip);
    const past = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(path.join(layout.staging, old.id, 'meta.json'), past, past);
    await store.prune();
    assert.equal(await stagingEntryExists(path.join(layout.staging, old.id)), false);
    assert.equal(await stagingEntryExists(path.join(layout.staging, fresh.id, 'meta.json')), true);
  } finally {
    await cleanup(root);
  }
});

test('catalog creates, reads, conflicts and deletes a managed skill', async () => {
  const root = await tempDir();
  try {
    const layout = resolveLayout(root);
    const catalog = new SkillCatalog(layout);
    const created = await catalog.create({
      slug: 'demo-skill',
      displayName: '示例技能',
      description: '测试技能',
      body: '# 示例\n\n步骤一',
    });
    assert.equal(created.name, 'demo-skill');
    assert.equal(created.displayName, '示例技能');
    assert.equal(created.modelInvocable, false);

    const read = await catalog.read('demo-skill');
    assert.match(read.text, /disable-model-invocation: true/);

    await assert.rejects(
      () => catalog.create({ slug: 'demo-skill', displayName: '重复', description: 'x', body: 'y' }),
      (error) => error.code === 'conflict',
    );

    await catalog.writeScript('demo-skill', 'run.sh', '#!/bin/sh\n');
    const withScripts = await catalog.read('demo-skill');
    assert.deepEqual(withScripts.scripts.map((file) => file.path), ['run.sh']);

    await catalog.delete('demo-skill');
    await assert.rejects(() => catalog.read('demo-skill'), (error) => error.code === 'not_found');
  } finally {
    await cleanup(root);
  }
});

test('catalog installs a staged archive and keeps its scripts', async () => {
  const root = await tempDir();
  try {
    const layout = resolveLayout(root);
    const zip = await makeZipFixture(root);
    const { store, id } = await stageZip(root, layout, zip);
    const staged = await store.readStaged(id);
    const catalog = new SkillCatalog(layout);
    const skill = await catalog.createFromStaging(
      { skillDir: staged.skillDir },
      { slug: 'demo-skill', displayName: '示例技能', description: '来自压缩包', body: staged.parsed.body },
    );
    assert.equal(skill.slug, 'demo-skill');
    assert.deepEqual(skill.scripts.map((file) => file.path), ['run.sh']);
    const text = await readFile(path.join(layout.skills, 'demo-skill', 'SKILL.md'), 'utf8');
    assert.match(text, /name: "demo-skill"/);
    assert.equal(await stagingEntryExists(staged.skillDir), false);
  } finally {
    await cleanup(root);
  }
});
