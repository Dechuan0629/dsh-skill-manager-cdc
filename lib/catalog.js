/**
 * The managed skill store under `<DSH_HOME>/skills`.
 *
 * Each managed skill is a directory whose name is an ASCII kebab slug ending
 * in `-skill`, holding exactly `SKILL.md` (frontmatter + prompt body) and a
 * `scripts/` directory. This module owns listing, reading, writing and deleting
 * those directories; it never mutates files outside the store root.
 */

import { cp, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fail } from './errors.js';
import {
  MAX_SKILL_BYTES,
  findSkillFile,
  parseSkillMarkdown,
  readSkillMarkdown,
  serializeSkillMarkdown,
  validateFinalSkill,
} from './manifest.js';
import { humanizeSlug } from './naming.js';
import { assertInside, assertSkillId, ensureDir, exists, isManagedSkillId, safeJoin, writeFileAtomic } from './paths.js';

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

function summarize(slug, parsed, dir) {
  return {
    slug,
    name: parsed.name,
    displayName: parsed.displayName || humanizeSlug(parsed.name),
    description: parsed.description,
    whenToUse: parsed.whenToUse || '',
    modelInvocable: parsed.modelInvocable !== false,
    userInvocable: parsed.userInvocable !== false,
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
    return path.join(this.root, assertSkillId(slug));
  }

  /** List every managed skill plus the directories that failed validation. */
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
    for (const entry of entries) {
      const slug = entry.name;
      if (!isManagedSkillId(slug)) {
        invalid.push({ slug, code: 'invalid_skill', message: '目录名不是以小写 -skill 结尾的标识，DSH 不会加载该目录' });
        continue;
      }
      const dir = path.join(this.root, slug);
      try {
        const parsed = await readSkillMarkdown(dir);
        if (!parsed) {
          invalid.push({ slug, code: 'invalid_skill', message: '目录内缺少 SKILL.md' });
          continue;
        }
        validateFinalSkill(parsed, { expectedSlug: slug });
        const scripts = await listScripts(path.join(dir, 'scripts'));
        skills.push({ ...summarize(slug, parsed, dir), scripts, bytes: scripts.reduce((total, file) => total + file.size, 0) });
      } catch (error) {
        invalid.push({ slug, code: error?.code ?? 'invalid_skill', message: error instanceof Error ? error.message : String(error) });
      }
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
      extra,
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
  async createFromStaging(staged, { slug, displayName, description, whenToUse, body, extra = {} }) {
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
      modelInvocable: false,
      extra,
    });
    validateFinalSkill(parseSkillMarkdown(text), { expectedSlug: slug });
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
