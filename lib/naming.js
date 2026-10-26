/**
 * Display-name and slug policy.
 *
 * DSH itself only accepts an ASCII kebab-case `name`. This plugin keeps a
 * Chinese `displayName` in the SKILL.md frontmatter for the UI, while every
 * directory, mount entry and `/mySkills` token uses the ASCII `name`.
 */

import { createHash } from 'node:crypto';
import { SKILL_SUFFIX, hashSlug, isManagedSkillId, normalizeSlug, slugifyAscii } from './paths.js';
import { fail } from './errors.js';

const CONTROL_RE = /[\u0000-\u001f\u007f]/g;
const MODEL_MAX = 6;
const MODEL_MIN = 3;
const MANUAL_MAX = 30;

export function cleanDisplayName(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(CONTROL_RE, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MANUAL_MAX * 2);
}

/** Model-proposed names are expected to be 3-6 Chinese characters. */
export function normalizeAiDisplayName(value) {
  let name = cleanDisplayName(value).replace(/^["'「『]+|["'」』]+$/g, '').trim();
  if (!name) return '自定义技能';
  let chars = Array.from(name);
  if (chars.length > MODEL_MAX) chars = chars.slice(0, MODEL_MAX);
  while (chars.length < MODEL_MIN) chars.push('技能');
  name = chars.join('').slice(0, MODEL_MAX);
  return name || '自定义技能';
}

export function normalizeManualDisplayName(value) {
  const name = cleanDisplayName(value);
  if (!name) fail('invalid_skill', '请填写 Skill 名称');
  if (Array.from(name).length > MANUAL_MAX) fail('invalid_skill', `Skill 名称不能超过 ${MANUAL_MAX} 个字符`);
  return name;
}

export function humanizeSlug(slug) {
  const base = String(slug || '').replace(/-skill$/, '').replace(/-/g, ' ').trim();
  if (!base) return '未命名技能';
  return base.replace(/\b[a-z]/g, (char) => char.toUpperCase());
}

/**
 * Resolve the final slug. Priority:
 * explicit user slug > frontmatter name > AI slug > displayName > hash.
 */
export function deriveSlug({ explicitSlug, frontmatterName, aiSlug, displayName, body = '' } = {}) {
  if (typeof explicitSlug === 'string' && explicitSlug.trim()) {
    return normalizeSlug(explicitSlug);
  }
  for (const candidate of [frontmatterName, aiSlug]) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    try {
      return normalizeSlug(candidate);
    } catch {
      /* Try the next source. */
    }
  }
  const fromDisplay = slugifyAscii(displayName);
  if (fromDisplay) {
    try {
      return normalizeSlug(fromDisplay);
    } catch {
      /* Fall through to the hash. */
    }
  }
  return hashSlug(displayName || 'skill', body);
}

export function assertSlugAvailable(slug) {
  if (!isManagedSkillId(slug)) fail('invalid_skill', 'Skill 标识必须为小写 kebab-case 且以 -skill 结尾');
  return slug;
}

export function slugDigest(...parts) {
  return createHash('sha256').update(parts.join('\0'), 'utf8').digest('hex').slice(0, 10);
}

/** Pull the first JSON object out of a model response (fenced or bare). */
export function parseModelJson(text) {
  if (typeof text !== 'string' || !text.trim()) return undefined;
  const cleaned = text.replace(/^\uFEFF/, '').trim();
  const fenced = cleaned.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  const candidates = [];
  if (fenced) candidates.push(fenced[1].trim());
  candidates.push(cleaned);
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(cleaned.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      /* Try the next candidate. */
    }
  }
  return undefined;
}

export function stripFrontmatter(body) {
  if (typeof body !== 'string') return '';
  const normalized = body.replace(/\r\n?/g, '\n');
  if (!normalized.startsWith('---\n')) return normalized.trim();
  const end = normalized.indexOf('\n---', 4);
  if (end < 0) return normalized.trim();
  return normalized.slice(end + 4).replace(/^\n+/, '').trim();
}

/** Normalize a parsed AI draft into the fields accepted by createSkill. */
export function normalizeAiDraft(data, { prompt = '' } = {}) {
  if (!data || typeof data !== 'object') fail('model_error', '模型没有返回有效的 JSON');
  const displayName = normalizeAiDisplayName(data.displayName ?? data.display_name ?? data.title);
  const description = cleanDisplayName(data.description ?? data.summary) || `根据「${prompt.slice(0, 40) || '自定义需求'}」创建的自定义 Skill`;
  const whenToUse = cleanDisplayName(data.whenToUse ?? data.when_to_use ?? '') || undefined;
  const rawBody = typeof data.body === 'string' ? data.body : '';
  const body = stripFrontmatter(rawBody) || `# ${displayName}\n\n${description}`;
  const aiSlug = typeof data.slug === 'string' ? data.slug : typeof data.name === 'string' ? data.name : '';
  const slug = deriveSlug({ aiSlug, displayName, body });
  return {
    displayName,
    slug,
    description,
    ...(whenToUse ? { whenToUse } : {}),
    body,
    modelInvocable: data.modelInvocable === false ? false : true,
  };
}

export function normalizeAiName(data, { body = '', description = '' } = {}) {
  const obj = data && typeof data === 'object' ? data : {};
  const displayName = normalizeAiDisplayName(obj.displayName ?? obj.display_name ?? obj.name);
  const aiSlug = typeof obj.slug === 'string' ? obj.slug : '';
  const desc = cleanDisplayName(obj.description ?? '') || description;
  return {
    displayName,
    slug: deriveSlug({ aiSlug, displayName, body }),
    ...(desc ? { description: desc } : {}),
  };
}

export function defaultDescription(displayName) {
  return `${displayName} 自定义 Skill`;
}

export { SKILL_SUFFIX };
