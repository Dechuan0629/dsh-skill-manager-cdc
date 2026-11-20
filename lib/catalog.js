/**
 * The managed skill store under `<DSH_HOME>/skills`.
 *
 * Every ASCII kebab directory under `<DSH_HOME>/skills` that holds a SKILL.md is
 * a skill: DSH identifies skills by the frontmatter `name`, not by the directory
 * name, so the directory is only a stable key for mounts and file operations.
 * This module owns listing, reading, writing and deleting those directories; it
 * never mutates files outside the store root.
 */

import { cp, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fail } from './errors.js';
import { bodyDigest } from './summaries.js';
import {
  MAX_SKILL_BYTES,
  findSkillFile,
  parseSkillMarkdown,
  readSkillMarkdown,
  rewriteInvocationPolicy,
  serializeSkillMarkdown,
  skillLoadIssues,
  validateFinalSkill,
} from './manifest.js';
import { humanizeSlug } from './naming.js';
import { assertDirId, assertInside, ensureDir, exists, isSkillDirName, safeJoin, writeFileAtomic } from './paths.js';

const MANAGED_BY = 'managed-by';
const MANAGED_BY_VALUE = 'dsh-skill-manager';
const BACKUP_KEEP = 20;

function readFileUtf8(file) {
  return readFile(file, 'utf8');
}

async function listScripts(dir, prefix = '') {
  const files = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return files;
    throw error;
  }
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listScripts(absolute, relative)));
      continue;
    }
    if (!entry.isFile()) continue;
    const info = await stat(absolute);
    files.push({ path: relative, size: info.size });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function isManaged(parsed) {
  return parsed.extra?.[MANAGED_BY] === MANAGED_BY_VALUE || Boolean(parsed.frontmatter?.displayName || parsed.frontmatter?.display_name);
}

function summarize(slug, parsed, dir) {
  const modelInvocable = parsed.modelInvocable !== false;
  return {
    slug,
    name: parsed.name,
    token: `/${parsed.name}`,
    displayName: parsed.displayName || humanizeSlug(parsed.name),
    description: parsed.description,
    whenToUse: parsed.whenToUse || '',
    modelInvocable,
    userInvocable: parsed.userInvocable !== false,
    invocation: modelInvocable ? 'auto' : 'manual',
    managed: isManaged(parsed),
    nameMismatch: parsed.name !== slug,
    bodyHash: bodyDigest(parsed.text),
    dir,
    skillFile: parsed.file,
  };
}

export class SkillCatalog {
  constructor(layout) {
    this.layout = layout;
  }

  get root() {
    return this.layout.skills;
  }

  dirOf(slug) {
    return path.join(this.root, assertDirId(slug));
  }

  /** List every loadable skill plus the directories that DSH will not load. */
  async list() {
    let entries;
    try {
      entries = (await readdir(this.root, { withFileTypes: true })).filter((entry) => entry.isDirectory());
    } catch (error) {
      if (error?.code === 'ENOENT') return { skills: [], invalid: [] };
      throw error;
    }
    const skills = [];
    const invalid = [];
    const seenNames = new Map();
    for (const entry of entries) {
      const slug = entry.name;
      if (slug.startsWith('.')) continue;
      if (!isSkillDirName(slug)) {
        invalid.push({ slug, code: 'invalid_skill', message: '目录名必须是 kebab-case（a-z 0-9 与 -）' });
        continue;
      }
      const dir = path.join(this.root, slug);
      let parsed;
      try {
        parsed = await readSkillMarkdown(dir);
      } catch (error) {
        invalid.push({ slug, code: error?.code ?? 'invalid_skill', message: error instanceof Error ? error.message : String(error) });
        continue;
      }
      if (!parsed) continue; // No SKILL.md: not a skill directory at all.
      const issues = skillLoadIssues(parsed);
      if (issues.length > 0) {
        invalid.push({ slug, code: 'invalid_skill', message: issues.join('；') });
        continue;
      }
      const owner = seenNames.get(parsed.name);
      if (owner) {
        invalid.push({ slug, code: 'invalid_skill', message: `name（${parsed.name}）与其他技能（${owner}）重复` });
        continue;
      }
      seenNames.set(parsed.name, slug);
      const scripts = await listScripts(path.join(dir, 'scripts'));
      skills.push({ ...summarize(slug, parsed, dir), scripts, bytes: scripts.reduce((total, file) => total + file.size, 0) });
    }
    skills.sort((left, right) => left.displayName.localeCompare(right.displayName, 'zh-Hans-CN'));
    return { skills, invalid };
  }

  /** Read one skill including its prompt body and script inventory. */
  async read(slug) {
    const dir = this.dirOf(slug);
    if (!exists(dir)) fail('not_found', `Skill 不存在：${slug}`);
    const parsed = await readSkillMarkdown(dir);
    if (!parsed) fail('not_found', `Skill 目录缺少 SKILL.md：${slug}`);
    const scripts = await listScripts(path.join(dir, 'scripts'));
    return {
      ...summarize(slug, parsed, dir),
      scripts,
      body: parsed.body,
      text: parsed.text,
      bytes: scripts.reduce((total, file) => total + file.size, 0),
    };
  }

  /**
   * Create a new managed skill directory.
   * @returns {Promise<object>} the stored skill summary.
   */
  async create({ slug, displayName, description, whenToUse, body, modelInvocable = false, extra = {} }) {
    const dir = this.dirOf(slug);
    if (exists(dir)) fail('conflict', `Skill 标识已被占用：${slug}`);
    const finalBody = String(body ?? '').replace(/\r\n?/g, '\n').replace(/^\n+/, '').trimEnd();
    if (!finalBody) fail('invalid_skill', 'Skill 提示词内容不能为空');
    const text = serializeSkillMarkdown({
      name: slug,
      description: String(description ?? '').trim() || `${displayName} 自定义 Skill`,
      displayName: String(displayName ?? '').trim() || humanizeSlug(slug),
      whenToUse: String(whenToUse ?? '').trim(),
      body: finalBody,
      userInvocable: true,
      modelInvocable: modelInvocable === true,
      extra: { [MANAGED_BY]: MANAGED_BY_VALUE, ...extra },
    });
    validateFinalSkill(parseSkillMarkdown(text), { expectedSlug: slug });
    await ensureDir(path.join(dir, 'scripts'));
    await writeFileAtomic(path.join(dir, 'SKILL.md'), text, 0o644);
    return this.read(slug);
  }

  /**
   * Install a staged import by moving its validated directory into the store.
   * @returns {Promise<object>} the stored skill summary.
   */
  async createFromStaging(staged, { slug, displayName, description, whenToUse, body, modelInvocable = false, extra = {} }) {
    const target = this.dirOf(slug);
    if (exists(target)) fail('conflict', `Skill 标识已被占用：${slug}`);
    if (!exists(staged.skillDir)) fail('not_found', '导入任务不存在或已过期，请重新上传压缩包');
    await ensureDir(this.root);
    try {
      await rename(staged.skillDir, target);
    } catch (error) {
      if (error?.code !== 'EXDEV') throw error;
      await cp(staged.skillDir, target, { recursive: true });
      await rm(staged.skillDir, { recursive: true, force: true });
    }
    assertInside(this.root, target);
    await ensureDir(path.join(target, 'scripts'));
    const finalBody = String(body ?? '').replace(/\r\n?/g, '\n').replace(/^\n+/, '').trimEnd();
    if (!finalBody) fail('invalid_skill', 'Skill 提示词内容不能为空');
    const text = serializeSkillMarkdown({
      name: slug,
      description: String(description ?? '').trim() || `${displayName} 自定义 Skill`,
      displayName: String(displayName ?? '').trim() || humanizeSlug(slug),
      whenToUse: String(whenToUse ?? '').trim(),
      body: finalBody,
      userInvocable: true,
      modelInvocable: modelInvocable === true,
      extra: { [MANAGED_BY]: MANAGED_BY_VALUE, ...extra },
    });
    const issues = skillLoadIssues(parseSkillMarkdown(text));
    if (issues.length > 0) fail('invalid_skill', issues.join('；'));
    await writeFileAtomic(path.join(target, 'SKILL.md'), text, 0o644);
    return this.read(slug);
  }

  /** Delete a managed skill directory. */
  async delete(slug) {
    const dir = this.dirOf(slug);
    if (!exists(dir)) fail('not_found', `Skill 不存在：${slug}`);
    assertInside(this.root, dir);
    await rm(dir, { recursive: true, force: true });
    return { slug };
  }

  /**
   * Flip the model-invocation policy of an existing skill by rewriting only the
   * `disable-model-invocation` frontmatter line. Backs the old file up first and
   * verifies the rewrite by re-parsing before returning.
   */
  async setInvocation(slug, modelInvocable, { log } = {}) {
    const dir = this.dirOf(slug);
    if (!exists(dir)) fail('not_found', `Skill 不存在：${slug}`);
    const files = await findSkillFile(dir);
    if (files.length === 0) fail('not_found', `Skill 目录缺少 SKILL.md：${slug}`);
    const file = files[0];
    const info = await stat(file);
    if (info.size > MAX_SKILL_BYTES) fail('too_large', 'SKILL.md 超过 2 MB');
    const original = await readFileUtf8(file);
    const rewritten = rewriteInvocationPolicy(original, { modelInvocable });
    if (!rewritten.changed) {
      const summary = await this.read(slug);
      return { changed: false, repaired: rewritten.repaired, summary };
    }
    const expected = modelInvocable === false ? false : true;
    const check = parseSkillMarkdown(rewritten.text);
    if (check.modelInvocable !== expected) {
      fail('internal_error', '改写 frontmatter 后自检失败，已放弃写入');
    }
    const backup = await this.backupFile(slug, original).catch((error) => {
      log?.(`backup failed for ${slug}: ${error?.message ?? error}`);
      return '';
    });
    try {
      await writeFileAtomic(file, rewritten.text, 0o644);
    } catch (error) {
      throw error;
    }
    const summary = await this.read(slug);
    return { changed: true, repaired: rewritten.repaired, summary, ...(backup ? { backup } : {}) };
  }

  /** Copy the current SKILL.md into <manager>/backups, keeping the newest 20. */
  async backupFile(slug, text) {
    const dir = path.join(this.layout.manager, 'backups');
    await ensureDir(dir);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = safeJoin(dir, `${assertDirId(slug)}.${stamp}.md`);
    await writeFileAtomic(target, text, 0o600);
    try {
      const entries = (await readdir(dir)).filter((name) => name.endsWith('.md'));
      const detailed = [];
      for (const name of entries) {
        const full = path.join(dir, name);
        detailed.push({ full, mtime: (await stat(full)).mtimeMs });
      }
      detailed.sort((left, right) => right.mtime - left.mtime);
      for (const stale of detailed.slice(BACKUP_KEEP)) await rm(stale.full, { force: true });
    } catch {
      /* Pruning is best effort. */
    }
    return target;
  }

  /** Write a script file inside a managed skill (used by tests only). */
  async writeScript(slug, relativePath, content) {
    const dir = this.dirOf(slug);
    if (!exists(dir)) fail('not_found', `Skill 不存在：${slug}`);
    const target = safeJoin(dir, 'scripts', relativePath);
    await ensureDir(path.dirname(target));
    await writeFileAtomic(target, content, 0o644);
    return target;
  }

  /** The single SKILL.md file of a managed skill, for diagnostics. */
  async skillFileOf(slug) {
    const dir = this.dirOf(slug);
    const files = await findSkillFile(dir);
    return files[0];
  }
}

export { MAX_SKILL_BYTES };
