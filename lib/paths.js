/**
 * Path and identifier rules for the custom skill store.
 *
 * Layout owned by this plugin:
 *   <DSH_HOME>/skills/<slug>/SKILL.md
 *   <DSH_HOME>/skills/<slug>/scripts/...
 *   <DSH_HOME>/skill-manager/state.json
 *   <DSH_HOME>/skill-manager/staging/<token>/
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SkillError, fail } from './errors.js';

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_SLUG = 64;
export const SKILL_SUFFIX = '-skill';
export const STATE_VERSION = 1;

export function resolveDshHome(env = process.env, homedir = os.homedir()) {
  const configured = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  return path.resolve(configured || path.join(homedir, '.dsh'));
}

export function resolveLayout(dshHome = resolveDshHome()) {
  const home = path.resolve(dshHome);
  const manager = path.join(home, 'skill-manager');
  return Object.freeze({
    home,
    skills: path.join(home, 'skills'),
    manager,
    stateFile: path.join(manager, 'state.json'),
    staging: path.join(manager, 'staging'),
  });
}

export function isValidSlug(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_SLUG && SLUG_RE.test(value);
}

/** Directory name for a managed skill must be an ASCII kebab slug ending -skill. */
export function isManagedSkillId(value) {
  return isValidSlug(value) && value.endsWith(SKILL_SUFFIX);
}

/** Best-effort ASCII slug. Non-ASCII input falls back to an empty string. */
export function slugifyAscii(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

/** Normalize a user/AI supplied identifier into a managed slug. Throws if empty. */
export function normalizeSlug(value) {
  const raw = slugifyAscii(typeof value === 'string' ? value : '');
  if (!raw) fail('invalid_skill', 'Skill 标识必须包含 ASCII 字母或数字');
  let slug = raw;
  if (!slug.endsWith(SKILL_SUFFIX)) slug = `${slug}${SKILL_SUFFIX}`;
  if (slug.length > MAX_SLUG) slug = `${slug.slice(0, MAX_SLUG - SKILL_SUFFIX.length).replace(/-+$/g, '')}${SKILL_SUFFIX}`;
  if (!isManagedSkillId(slug)) fail('invalid_skill', 'Skill 标识格式无效，应为小写 kebab-case 且以 -skill 结尾');
  return slug;
}

/** Validate an existing directory identifier without silently rewriting it. */
export function assertSkillId(value) {
  if (!isValidSlug(value)) fail('bad_request', 'Skill 标识无效');
  if (!isManagedSkillId(value)) fail('invalid_skill', '目录名必须以 -skill 结尾');
  return value;
}

/** Stable fallback slug for a Chinese display name and body. */
export function hashSlug(displayName, body = '') {
  const digest = createHash('sha256').update(`${displayName}\0${body}`, 'utf8').digest('hex').slice(0, 8);
  return `custom-${digest}-skill`;
}

export function assertInside(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    fail('bad_request', '路径越界');
  }
  return resolved;
}

/**
 * Join user supplied path segments under a trusted root.
 * Rejects absolute paths, drive letters, empty segments, dot-dot and NUL.
 */
export function safeJoin(root, ...segments) {
  const parts = segments.flat();
  const checked = [];
  for (const segment of parts) {
    if (typeof segment !== 'string') fail('bad_request', '路径片段无效');
    if (segment.length === 0) continue;
    if (segment.includes('\0') || segment.includes('\n') || segment.includes('\r')) {
      fail('bad_request', '路径包含非法字符');
    }
    if (path.isAbsolute(segment) || /^[A-Za-z]:[\\/]/.test(segment)) {
      fail('bad_request', '不允许绝对路径');
    }
    const normalized = segment.replace(/\\/g, '/');
    for (const piece of normalized.split('/')) {
      if (!piece || piece === '.') continue;
      if (piece === '..') fail('bad_request', '路径不允许包含 ..');
      checked.push(piece);
    }
  }
  return assertInside(root, path.join(path.resolve(root), ...checked));
}

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o755 });
}

export async function readTextFile(file, maxBytes = 2 * 1024 * 1024) {
  const stat = await import('node:fs/promises').then((fs) => fs.stat(file));
  if (stat.size > maxBytes) fail('too_large', '文件超过大小限制');
  return readFile(file, 'utf8');
}

export function exists(file) {
  return existsSync(file);
}

/** Write a file through a sibling temporary path, then rename it into place. */
export async function writeFileAtomic(file, data, mode = 0o600) {
  const dir = path.dirname(file);
  await ensureDir(dir);
  const temp = path.join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await writeFile(temp, data, { mode });
  await rename(temp, file);
}

export async function removeQuietly(target) {
  try {
    await rm(target, { recursive: true, force: true });
  } catch {
    /* Best effort cleanup. */
  }
}

export { SkillError };
