/**
 * Two-phase archive import.
 *
 * `begin()` reserves a random staging directory; `materialize()` copies the
 * validated archive payload there and records a small metadata file. Nothing
 * reaches `<DSH_HOME>/skills` until the user confirms the import, so a broken
 * or rejected archive never leaves a half-installed skill behind.
 */

import { randomUUID } from 'node:crypto';
import { copyFile, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { extractArchive, inspectExtracted, listArchive, ARCHIVE_LIMITS } from './archive.js';
import { fail } from './errors.js';
import { parseSkillMarkdown, readSkillMarkdown } from './manifest.js';
import { cleanDisplayName, defaultDescription } from './naming.js';
import { ensureDir, exists, removeQuietly, safeJoin, writeFileAtomic } from './paths.js';

export const STAGING_TTL_MS = 30 * 60 * 1000;
export const MAX_STAGING = 5;
const STAGING_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertStagingId(id) {
  if (typeof id !== 'string' || !STAGING_ID_RE.test(id)) fail('bad_request', '导入任务标识无效');
  return id;
}

async function entryExists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

export class StagingStore {
  constructor(layout) {
    this.layout = layout;
  }

  get root() {
    return this.layout.staging;
  }

  dirOf(id) {
    return path.join(this.root, assertStagingId(id));
  }

  /** Reserve a new staging directory and return its identifier. */
  async begin() {
    await this.prune();
    await ensureDir(this.root);
    const entries = (await readdir(this.root, { withFileTypes: true })).filter((entry) => entry.isDirectory());
    if (entries.length >= MAX_STAGING) {
      await this.#pruneOldest(entries.length - MAX_STAGING + 1);
    }
    const id = randomUUID();
    const dir = path.join(this.root, id);
    await ensureDir(dir);
    return { id, dir };
  }

  /**
   * Unpack and validate an archive that was already written into the staging
   * directory, then move the validated payload into `<staging>/<id>/skill`.
   */
  async prepare(id, archiveFile, { originalName = 'skill.zip' } = {}) {
    const dir = this.dirOf(id);
    const extractDir = path.join(dir, 'extract');
    await ensureDir(extractDir);
    const names = await listArchive(archiveFile);
    if (names.length > ARCHIVE_LIMITS.files) fail('too_large', `压缩包内文件数量超过 ${ARCHIVE_LIMITS.files} 个`);
    await extractArchive(archiveFile, extractDir);
    const descriptor = await inspectExtracted(extractDir);
    try {
      const preview = await this.#materialize(id, descriptor, { originalName });
      return preview;
    } finally {
      await removeQuietly(extractDir);
      await removeQuietly(archiveFile);
    }
  }

  async #materialize(id, descriptor, { originalName }) {
    const dir = this.dirOf(id);
    const skillDir = path.join(dir, 'skill');
    await ensureDir(skillDir);
    await ensureDir(path.join(skillDir, 'scripts'));

    const copied = [];
    const ignored = [];
    for (const file of descriptor.files) {
      const relative = file.path;
      let targetRelative = relative;
      if (!relative.includes('/') && /^skill\.md$/i.test(relative)) targetRelative = 'SKILL.md';
      if (targetRelative !== 'SKILL.md' && !targetRelative.startsWith('scripts/')) {
        ignored.push(relative);
        continue;
      }
      const target = safeJoin(skillDir, targetRelative);
      await ensureDir(path.dirname(target));
      await copyFile(file.absolute, target);
      copied.push({ path: targetRelative, size: file.size });
    }

    const skillFile = path.join(skillDir, 'SKILL.md');
    const text = await readFile(skillFile, 'utf8');
    if (Buffer.byteLength(text, 'utf8') > 2 * 1024 * 1024) fail('too_large', 'SKILL.md 超过 2 MB');
    const parsed = parseSkillMarkdown(text);
    const warnings = [...descriptor.warnings];
    if (ignored.length > 0) {
      const shown = ignored.slice(0, 8).join('、');
      warnings.push(`已忽略 ${ignored.length} 个未使用的文件（不会导入）：${shown}${ignored.length > 8 ? ' 等' : ''}`);
    }

    const meta = {
      version: 1,
      id,
      createdAt: new Date().toISOString(),
      originalName: cleanDisplayName(originalName) || 'skill.zip',
      frontmatterName: parsed.hasFrontmatter ? parsed.name : '',
      hasFrontmatter: parsed.hasFrontmatter,
      displayName: parsed.displayName || '',
      description: parsed.description || '',
      whenToUse: parsed.whenToUse || '',
      body: parsed.body,
      files: copied,
      totalBytes: copied.reduce((total, file) => total + file.size, 0),
      warnings,
    };
    await writeFileAtomic(path.join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 0o600);
    return this.previewOf(meta);
  }

  previewOf(meta) {
    const scripts = meta.files.filter((file) => file.path.startsWith('scripts/'));
    return {
      stagingId: meta.id,
      originalName: meta.originalName,
      createdAt: meta.createdAt,
      name: meta.frontmatterName || '',
      displayName: meta.displayName || '',
      description: meta.description || '',
      whenToUse: meta.whenToUse || '',
      hasFrontmatter: meta.hasFrontmatter,
      bodyExcerpt: String(meta.body || '').slice(0, 400),
      scripts,
      files: meta.files.length,
      bytes: meta.totalBytes,
      warnings: meta.warnings,
    };
  }

  /** Load staged metadata. */
  async load(id) {
    const dir = this.dirOf(id);
    let raw;
    try {
      raw = await readFile(path.join(dir, 'meta.json'), 'utf8');
    } catch {
      fail('not_found', '导入任务不存在或已过期，请重新上传压缩包');
    }
    let meta;
    try {
      meta = JSON.parse(raw);
    } catch {
      fail('not_found', '导入任务已损坏，请重新上传压缩包');
    }
    if (!meta || meta.id !== id) fail('not_found', '导入任务不存在或已过期，请重新上传压缩包');
    return meta;
  }

  /** Read the staged SKILL.md and parsed representation. */
  async readStaged(id) {
    const meta = await this.load(id);
    const skillDir = path.join(this.dirOf(id), 'skill');
    const parsed = await readSkillMarkdown(skillDir);
    if (!parsed) fail('invalid_skill', '暂存内容缺少 SKILL.md');
    return { meta, parsed, skillDir };
  }

  /** Drop one staging directory. */
  async discard(id) {
    await removeQuietly(this.dirOf(id));
  }

  /** Remove expired staging directories and enforce the count budget. */
  async prune() {
    let entries;
    try {
      entries = (await readdir(this.root, { withFileTypes: true })).filter((entry) => entry.isDirectory());
    } catch {
      return;
    }
    const now = Date.now();
    const alive = [];
    for (const entry of entries) {
      const dir = path.join(this.root, entry.name);
      const metaFile = path.join(dir, 'meta.json');
      let createdAt = 0;
      try {
        createdAt = (await stat(metaFile)).mtimeMs;
      } catch {
        try {
          createdAt = (await stat(dir)).mtimeMs;
        } catch {
          createdAt = 0;
        }
      }
      if (now - createdAt > STAGING_TTL_MS) {
        await removeQuietly(dir);
        continue;
      }
      alive.push({ name: entry.name, createdAt });
    }
    if (alive.length > MAX_STAGING) {
      alive.sort((left, right) => left.createdAt - right.createdAt);
      for (const entry of alive.slice(0, alive.length - MAX_STAGING)) {
        await removeQuietly(path.join(this.root, entry.name));
      }
    }
  }

  async #pruneOldest(count) {
    if (count <= 0) return;
    const entries = (await readdir(this.root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(this.root, entry.name));
    const detailed = [];
    for (const dir of entries) {
      try {
        detailed.push({ dir, createdAt: (await stat(path.join(dir, 'meta.json'))).mtimeMs });
      } catch {
        detailed.push({ dir, createdAt: 0 });
      }
    }
    detailed.sort((left, right) => left.createdAt - right.createdAt);
    for (const entry of detailed.slice(0, count)) await removeQuietly(entry.dir);
  }

  /** Number of live staging jobs (for the panel state route). */
  async count() {
    try {
      const entries = (await readdir(this.root, { withFileTypes: true })).filter((entry) => entry.isDirectory());
      return entries.filter((entry) => exists(path.join(this.root, entry.name))).length;
    } catch {
      return 0;
    }
  }
}

export { entryExists as stagingEntryExists };
