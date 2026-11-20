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

const LEGACY_INVOCATION_KEYS = [
  ['disableModelInvocation', 'disable-model-invocation'],
  ['modelInvocable', 'disable-model-invocation'],
  ['userInvocable', 'user-invocable'],
];

function asBool(value) {
  if (value === true || value === false) return value;
  const text = String(value ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(text)) return true;
  if (['false', '0', 'no', 'off'].includes(text)) return false;
  return undefined;
}

function pickBool(frontmatter, key, fallback) {
  const parsed = asBool(frontmatter[key]);
  return parsed === undefined ? fallback : parsed;
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
  const legacyKeys = LEGACY_INVOCATION_KEYS.filter(([key]) => Object.prototype.hasOwnProperty.call(fm, key)).map(
    ([key, replacement]) => ({ key, replacement }),
  );
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
    legacyKeys,
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


const KEBAB_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Problems that make DSH skip a skill entirely, in DSH's own terms.
 * @returns {string[]} human readable reasons (empty when loadable).
 */
export function skillLoadIssues(parsed) {
  const issues = [];
  if (!parsed?.hasFrontmatter) return ['SKILL.md 缺少 frontmatter'];
  if (!parsed.name) issues.push('frontmatter 缺少 name');
  else if (!KEBAB_NAME_RE.test(parsed.name) || parsed.name.length > 64) issues.push('name 必须是 kebab-case（a-z 0-9 与 -）');
  if (!parsed.description) issues.push('frontmatter 缺少 description');
  for (const { key, replacement } of parsed.legacyKeys ?? []) {
    issues.push(`frontmatter 字段 "${key}" 不受支持，请改成 "${replacement}"`);
  }
  return issues;
}

/**
 * Rewrite only the invocation policy of an existing SKILL.md.
 * Every other line keeps its exact bytes (including CRLF and comments).
 *
 * @returns {{text: string, changed: boolean, repaired: string[]}}
 */
export function rewriteInvocationPolicy(text, { modelInvocable }) {
  const source = String(text ?? '');
  const parsed = parseFrontmatter(source);
  if (!parsed.hasFrontmatter) fail('invalid_skill', 'SKILL.md 缺少 frontmatter');
  const target = modelInvocable !== false;
  const rawLines = source.split(/(?<=\n)/);
  const eolOf = (line) => (line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : '');
  let endIndex = -1;
  for (let index = 1; index < rawLines.length; index += 1) {
    const trimmed = rawLines[index].replace(/\r?\n$/, '').trim();
    if (trimmed === '---' || trimmed === '...') {
      endIndex = index;
      break;
    }
  }
  if (endIndex < 0) fail('invalid_skill', 'SKILL.md frontmatter 没有结束标记');

  const POLICY_RE = /^(\s*)disable-model-invocation\s*:/;
  const LEGACY_RE = /^\s*(disableModelInvocation|modelInvocable)\s*:/;
  const repaired = [];
  const lines = [];
  let policyIndex = -1;
  let lastContent = -1;
  for (let index = 1; index < endIndex; index += 1) {
    const line = rawLines[index];
    const bare = line.replace(/\r?\n$/, '');
    if (bare.trim()) lastContent = lines.length;
    const legacy = bare.match(LEGACY_RE);
    if (legacy) {
      repaired.push(legacy[1]);
      continue;
    }
    if (POLICY_RE.test(bare)) {
      policyIndex = lines.length;
      lines.push(line);
      continue;
    }
    lines.push(line);
  }

  let changed = repaired.length > 0;
  if (target) {
    // Automatic: the key must be absent.
    if (policyIndex >= 0) {
      lines.splice(policyIndex, 1);
      changed = true;
    }
  } else if (policyIndex >= 0) {
    // Manual: force the value to true, keeping indentation and line ending.
    const line = lines[policyIndex];
    const bare = line.replace(/\r?\n$/, '');
    const indent = POLICY_RE.exec(bare)[1];
    const desired = `${indent}disable-model-invocation: true`;
    if (bare !== desired) {
      lines[policyIndex] = `${desired}${eolOf(line)}`;
      changed = true;
    }
  } else {
    // Manual: insert after the last non-empty frontmatter line.
    const previous = lastContent >= 0 ? lines[lastContent] : rawLines[0];
    const insertAt = lastContent >= 0 ? lastContent + 1 : 0;
    lines.splice(insertAt, 0, `disable-model-invocation: true${eolOf(previous) || '\n'}`);
    changed = true;
  }

  if (!changed) return { text: source, changed: false, repaired };
  const rebuilt = [rawLines[0], ...lines, rawLines[endIndex], ...rawLines.slice(endIndex + 1)].join('');
  return { text: rebuilt, changed: true, repaired };
}

export function validateFinalSkill(parsed, { expectedSlug = null } = {}) {
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
