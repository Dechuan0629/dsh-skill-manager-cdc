/**
 * AI-written card copy for one skill (a short "what it is" summary and a
 * short "how to use it" hint), kept beside the mounts state instead of inside
 * SKILL.md so external skill directories are never rewritten.
 */

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fail } from './errors.js';
import { ensureDir, isSkillDirName, removeQuietly, safeJoin, writeFileAtomic } from './paths.js';

export const SUMMARY_VERSION = 1;

export function bodyDigest(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 16);
}

function cleanText(value, max) {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Shape one stored record; empty fields survive so the UI can show "未生成". */
export function normalizeSummaryRecord(input = {}) {
  return {
    summary: cleanText(input.summary, 120),
    usage: cleanText(input.usage, 160),
    bodyHash: typeof input.bodyHash === 'string' ? input.bodyHash : '',
    model: typeof input.model === 'string' ? input.model : '',
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : '',
  };
}

export class SummaryStore {
  #loaded = false;
  #records = new Map();
  #queue = Promise.resolve();
  #now;

  constructor(layout, { now = () => new Date().toISOString() } = {}) {
    this.layout = layout;
    this.dir = path.join(layout.manager, 'summaries');
    this.#now = now;
  }

  #file(slug) {
    if (!isSkillDirName(slug)) fail('bad_request', 'Skill 目录名无效');
    return safeJoin(this.dir, `${slug}.json`);
  }

  async load() {
    if (this.#loaded) return this;
    this.#loaded = true;
    let entries = [];
    try {
      entries = await readdir(this.dir, { withFileTypes: true });
    } catch {
      return this;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const slug = entry.name.slice(0, -5);
      if (!isSkillDirName(slug)) continue;
      try {
        const parsed = JSON.parse(await readFile(safeJoin(this.dir, entry.name), 'utf8'));
        this.#records.set(slug, normalizeSummaryRecord(parsed));
      } catch {
        /* Ignore unreadable records; the button regenerates them. */
      }
    }
    return this;
  }

  get(slug) {
    return this.#records.get(slug);
  }

  all() {
    return new Map(this.#records);
  }

  count() {
    return this.#records.size;
  }

  /** Persist one record (empty fields are allowed and still stored). */
  async set(slug, record) {
    const file = this.#file(slug);
    const normalized = normalizeSummaryRecord({ ...record, updatedAt: record?.updatedAt || this.#now() });
    this.#records.set(slug, normalized);
    await ensureDir(this.dir, 0o700);
    this.#queue = this.#queue.then(() =>
      writeFileAtomic(file, `${JSON.stringify({ version: SUMMARY_VERSION, slug, ...normalized }, null, 2)}\n`, 0o600),
    );
    await this.#queue;
    return normalized;
  }

  async remove(slug) {
    if (!isSkillDirName(slug)) return false;
    const existed = this.#records.delete(slug);
    await ensureDir(this.dir, 0o700);
    await removeQuietly(this.#file(slug));
    return existed;
  }

  /** Read the current SKILL.md text and say whether the stored copy is stale. */
  async snapshot(slug, text) {
    const record = this.get(slug);
    if (!record) return null;
    const hash = bodyDigest(text);
    return {
      ...record,
      stale: Boolean(record.bodyHash && record.bodyHash !== hash),
    };
  }
}
