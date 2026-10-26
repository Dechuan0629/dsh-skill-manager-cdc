/**
 * Minimal, dependency-free SKILL.md reader/writer.
 *
 * The shipped DSH filesystem provider reads YAML frontmatter. This parser is
 * intentionally narrow: top-level scalars, quoted strings and `|`/`>` blocks
 * cover the skill format. Unknown scalar fields are preserved on rewrite.
 */

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fail } from './errors.js';
import { humanizeSlug } from './naming.js';

const MAX_SKILL_BYTES = 2 * 1024 * 1024;
const SKILL_FILE_RE = /^skill\.md$/i;

function parseScalar(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return '';
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, value.endsWith('"') ? -1 : undefined);
    }
  }
  if (value.startsWith("'")) {
    const body = value.slice(1, value.endsWith("'") ? -1 : undefined);
    return body.replace(/''/g, "'");
  }
  return value.replace(/\s+#.*$/, '').trim();
}

function collectBlock(lines, start, keyIndent, folded) {
  const collected = [];
  let index = start;
  let minIndent = Infinity;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      collected.push('');
      index += 1;
      continue;
    }
    const indent = line.match(/^ */)[0].length;
    if (indent <= keyIndent) break;
    minIndent = Math.min(minIndent, indent);
    collected.push(line);
    index += 1;
  }
  const stripped = collected.map((line) => (line ? line.slice(minIndent === Infinity ? 0 : minIndent) : ''));
  while (stripped.length && stripped[stripped.length - 1] === '') stripped.pop();
  return {
    value: folded ? stripped.join(' ').replace(/\s+/g, ' ').trim() : stripped.join('\n'),
    next: index,
  };
}

export function parseFrontmatter(text) {
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  if (lines[0]?.trim() !== '---') return { hasFrontmatter: false, frontmatter: {}, extra: {}, body: normalized };
  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---' || lines[index].trim() === '...') {
      end = index;
      break;
    }
  }
  if (end < 0) return { hasFrontmatter: false, frontmatter: {}, extra: {}, body: normalized };
  const frontmatter = {};
  const extra = {};
  for (let index = 1; index < end; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const match = line.match(/^([A-Za-z0-9_.-]+):(?:\s*(.*))?$/);
    if (!match) continue;
    const key = match[1];
    let raw = (match[2] ?? '').trim();
    if (/^[|>][+-]?$/.test(raw)) {
      const block = collectBlock(lines, index + 1, line.match(/^ */)[0].length, raw.startsWith('>'));
      frontmatter[key] = block.value;
      index = block.next - 1;
      continue;
    }
    frontmatter[key] = parseScalar(raw);
  }
  for (const [key, value] of Object.entries(frontmatter)) {
    if (!['name', 'description', 'displayName', 'display_name', 'whenToUse', 'when-to-use', 'user-invocable', 'disable-model-invocation'].includes(key)) {
      extra[key] = value;
    }
  }
  return { hasFrontmatter: true, frontmatter, extra, body: lines.slice(end + 1).join('\n') };
}

function pickString(frontmatter, ...keys) {
  for (const key of keys) {
    const value = frontmatter[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function pickBool(frontmatter, key, fallback) {
  const value = frontmatter[key];
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return fallback;
}

export function parseSkillMarkdown(text) {
  const parsed = parseFrontmatter(text);
  const fm = parsed.frontmatter;
  const name = pickString(fm, 'name');
  const description = pickString(fm, 'description');
  const displayName = pickString(fm, 'displayName', 'display_name') || (name ? humanizeSlug(name) : '');
  const whenToUse = pickString(fm, 'whenToUse', 'when-to-use');
  const userInvocable = pickBool(fm, 'user-invocable', true);
  const modelInvocable = !pickBool(fm, 'disable-model-invocation', false);
  const body = parsed.body.replace(/^\n+/, '').trimEnd();
  return {
    hasFrontmatter: parsed.hasFrontmatter,
    frontmatter: fm,
    extra: parsed.extra,
    name,
    description,
    displayName,
    whenToUse,
    userInvocable,
    modelInvocable,
    body,
    text: String(text ?? ''),
  };
}

function quote(value) {
  return JSON.stringify(String(value ?? ''));
}

export function serializeSkillMarkdown(skill) {
  const name = String(skill.name ?? '').trim();
  const description = String(skill.description ?? '').trim();
  const displayName = String(skill.displayName ?? '').trim() || humanizeSlug(name);
  const whenToUse = String(skill.whenToUse ?? '').trim();
  const body = String(skill.body ?? '').replace(/\r\n?/g, '\n').replace(/^\n+/, '').trimEnd();
  const lines = ['---', `name: ${quote(name)}`, `description: ${quote(description)}`, `displayName: ${quote(displayName)}`];
  if (whenToUse) lines.push(`whenToUse: ${quote(whenToUse)}`);
  if (skill.userInvocable === false) lines.push('user-invocable: false');
  if (skill.modelInvocable === false) lines.push('disable-model-invocation: true');
  for (const [key, value] of Object.entries(skill.extra ?? {})) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'boolean') lines.push(`${key}: ${value ? 'true' : 'false'}`);
    else if (typeof value === 'string' && value.includes('\n')) {
      lines.push(`${key}: |`);
      for (const line of value.split('\n')) lines.push(`  ${line}`);
    } else lines.push(`${key}: ${quote(value)}`);
  }
  lines.push('---', '', body || `# ${displayName}`, '');
  return lines.join('\n');
}

/** Find the one SKILL.md in a skill directory, rejecting duplicate case variants. */
export async function findSkillFile(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const matches = entries.filter((entry) => entry.isFile() && SKILL_FILE_RE.test(entry.name));
  if (matches.length > 1) fail('invalid_skill', '目录内存在多个 skill.md / SKILL.md');
  return matches.map((entry) => path.join(dir, entry.name));
}

export async function readSkillMarkdown(dir) {
  const files = await findSkillFile(dir);
  if (files.length === 0) return undefined;
  const file = files[0];
  const info = await stat(file);
  if (info.size > MAX_SKILL_BYTES) fail('too_large', 'SKILL.md 超过 2 MB');
  const text = await import('node:fs/promises').then((fs) => fs.readFile(file, 'utf8'));
  const parsed = parseSkillMarkdown(text);
  return { ...parsed, file, size: info.size };
}

export function validateFinalSkill(parsed, { expectedSlug } = {}) {
  if (!parsed?.hasFrontmatter) fail('invalid_skill', 'SKILL.md 缺少 frontmatter');
  if (!parsed.name) fail('invalid_skill', 'SKILL.md frontmatter 缺少 name');
  if (!parsed.description) fail('invalid_skill', 'SKILL.md frontmatter 缺少 description');
  if (!parsed.body.trim()) fail('invalid_skill', 'SKILL.md 正文不能为空');
  if (expectedSlug && parsed.name !== expectedSlug) {
    fail('invalid_skill', `SKILL.md 的 name（${parsed.name}）与目录名（${expectedSlug}）不一致`);
  }
  return parsed;
}

export { MAX_SKILL_BYTES };
