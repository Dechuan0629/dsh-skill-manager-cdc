/**
 * Durable per-session mount set.
 *
 * The state file is intentionally small and versioned:
 *   {version:1, sessions:{[sessionId]:{skills:[slug], updatedAt}}}
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fail } from './errors.js';
import { STATE_VERSION } from './paths.js';

const MAX_SESSIONS = 500;
const MAX_MOUNTS = 100;

function isSessionRecord(value) {
  return Boolean(value) && typeof value === 'object' && Array.isArray(value.skills);
}

export class MountStore {
  constructor(stateFile, { maxSessions = MAX_SESSIONS, maxMounts = MAX_MOUNTS, now = () => new Date().toISOString() } = {}) {
    this.stateFile = stateFile;
    this.maxSessions = maxSessions;
    this.maxMounts = maxMounts;
    this.now = now;
    this.state = { version: STATE_VERSION, sessions: {} };
    this.loaded = false;
    this.loading = undefined;
    this.writeQueue = Promise.resolve();
    this.writeError = undefined;
  }

  async load() {
    if (this.loaded) return this.state;
    if (this.loading) return this.loading;
    this.loading = this.#load().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  async #load() {
    let raw;
    try {
      raw = await readFile(this.stateFile, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.loaded = true;
        return this.state;
      }
      throw error;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || parsed.version !== STATE_VERSION || typeof parsed.sessions !== 'object' || parsed.sessions === null) {
        throw new Error('unsupported state shape');
      }
      const sessions = {};
      for (const [sessionId, record] of Object.entries(parsed.sessions)) {
        if (typeof sessionId !== 'string' || !isSessionRecord(record)) continue;
        const skills = record.skills.filter((slug) => typeof slug === 'string' && slug.length > 0 && slug.length <= 64);
        sessions[sessionId] = {
          skills: [...new Set(skills)].slice(0, this.maxMounts),
          updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : this.now(),
        };
      }
      this.state = { version: STATE_VERSION, sessions };
    } catch {
      const backup = `${this.stateFile}.corrupt-${Date.now()}`;
      try {
        await rename(this.stateFile, backup);
      } catch {
        /* If the backup cannot be made, start from an empty state in memory. */
      }
      this.state = { version: STATE_VERSION, sessions: {} };
    }
    this.loaded = true;
    return this.state;
  }

  #prune() {
    const entries = Object.entries(this.state.sessions);
    if (entries.length <= this.maxSessions) return;
    entries.sort((left, right) => String(left[1].updatedAt).localeCompare(String(right[1].updatedAt)));
    for (const [sessionId] of entries.slice(0, entries.length - this.maxSessions)) {
      delete this.state.sessions[sessionId];
    }
  }

  async #persist() {
    const dir = path.dirname(this.stateFile);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = path.join(dir, `.state-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
    await writeFile(temp, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, this.stateFile);
  }

  async #enqueue(task) {
    const run = this.writeQueue.then(task, task);
    this.writeQueue = run.catch(() => {});
    return run;
  }

  async get(sessionId) {
    await this.load();
    const record = this.state.sessions[sessionId];
    return record ? [...record.skills] : [];
  }

  async set(sessionId, skills) {
    if (typeof sessionId !== 'string' || !sessionId) fail('bad_request', '缺少会话 ID');
    if (!Array.isArray(skills)) fail('bad_request', 'skills 必须是数组');
    const unique = [...new Set(skills.filter((slug) => typeof slug === 'string' && slug.trim()))];
    if (unique.length > this.maxMounts) fail('too_large', `单个会话最多挂载 ${this.maxMounts} 个 Skill`);
    return this.#enqueue(async () => {
      await this.load();
      this.state.sessions[sessionId] = { skills: unique, updatedAt: this.now() };
      this.#prune();
      await this.#persist();
      return [...unique];
    });
  }

  async removeSkill(slug) {
    if (typeof slug !== 'string' || !slug) return 0;
    return this.#enqueue(async () => {
      await this.load();
      let removed = 0;
      for (const record of Object.values(this.state.sessions)) {
        const before = record.skills.length;
        record.skills = record.skills.filter((item) => item !== slug);
        removed += before - record.skills.length;
        if (record.skills.length !== before) record.updatedAt = this.now();
      }
      if (removed > 0) await this.#persist();
      return removed;
    });
  }

  async counts() {
    await this.load();
    const counts = {};
    for (const record of Object.values(this.state.sessions)) {
      for (const slug of record.skills) counts[slug] = (counts[slug] ?? 0) + 1;
    }
    return counts;
  }

  async snapshot() {
    await this.load();
    return JSON.parse(JSON.stringify(this.state));
  }

  /** Wait for pending writes (used by tests and route shutdown). */
  async flush() {
    await this.writeQueue;
  }
}

export { MAX_MOUNTS, MAX_SESSIONS };
