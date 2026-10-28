/**
 * Script helpers shared by the AI draft flow, manual creation and validation.
 *
 * Skills may ship runnable scripts under `<slug>/scripts/`. This module owns the
 * whitelist, path/name normalization and the cross-platform pairing heuristics
 * used when a model returns a script bundle.
 */

import { fail } from './errors.js';

/** Extensions we accept for scripts; all are plain text and runnable. */
export const SCRIPT_EXTENSIONS = [
  '.py',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.sh',
  '.bash',
  '.zsh',
  '.rb',
  '.ps1',
  '.bat',
  '.cmd',
  '.pl',
  '.php',
  '.lua',
];

export const MAX_SCRIPT_BYTES = 128 * 1024;
export const MAX_SCRIPTS = 20;
export const SCRIPT_ACCEPT = SCRIPT_EXTENSIONS.join(',');

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const WINDOWS_EXT = new Set(['.ps1', '.bat', '.cmd']);
const SHELL_EXT = new Set(['.sh', '.bash', '.zsh']);

function extensionOf(name) {
  const index = name.lastIndexOf('.');
  return index < 0 ? '' : name.slice(index).toLowerCase();
}

/**
 * Normalize a script file name (`scripts/foo.py` and `foo.py` both become
 * `foo.py`). Only plain file names are allowed; sub-directories are rejected so
 * the imported layout stays predictable.
 */
export function normalizeScriptName(value) {
  if (typeof value !== 'string') fail('invalid_skill', '脚本名称必须是字符串');
  let name = value.trim().replace(/^\uFEFF/, '');
  if (!name) fail('invalid_skill', '脚本名称不能为空');
  name = name.replace(/\\/g, '/');
  while (name.startsWith('./')) name = name.slice(2);
  while (name.toLowerCase().startsWith('scripts/')) name = name.slice('scripts/'.length);
  name = name.replace(/^\/+/, '');
  if (!name) fail('invalid_skill', '脚本名称不能为空');
  if (name.includes('/')) fail('invalid_skill', `脚本只能放在 scripts/ 根目录，不能包含子目录：${value}`);
  if (name === '.' || name === '..') fail('invalid_skill', '脚本名称无效');
  if (!NAME_RE.test(name)) fail('invalid_skill', `脚本名称只能包含字母、数字、点、下划线与短横线：${value}`);
  const extension = extensionOf(name);
  if (!SCRIPT_EXTENSIONS.includes(extension)) {
    fail('invalid_skill', `不支持的脚本类型：${name}（支持 ${SCRIPT_EXTENSIONS.join(' / ')}）`);
  }
  if (extension !== name.slice(name.lastIndexOf('.') + 1)) {
    name = `${name.slice(0, name.lastIndexOf('.'))}${extension}`;
  }
  return name;
}

/** Normalize script text: UTF-8, LF endings, bounded size, no binary payload. */
export function normalizeScriptContent(value, { name = 'script' } = {}) {
  if (typeof value !== 'string') fail('invalid_skill', `脚本内容必须是文本：${name}`);
  const text = value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!text.trim()) fail('invalid_skill', `脚本内容不能为空：${name}`);
  if (text.includes('\u0000')) fail('invalid_skill', `脚本内容不能包含二进制字节：${name}`);
  if (Buffer.byteLength(text, 'utf8') > MAX_SCRIPT_BYTES) {
    fail('too_large', `脚本超过 ${Math.round(MAX_SCRIPT_BYTES / 1024)} KB：${name}`);
  }
  return text;
}

/**
 * Normalize a list such as `[{path:'scripts/run.py', content:'…'}]`.
 * Duplicate names are dropped with a warning instead of failing the request.
 *
 * @returns {{scripts: {name: string, content: string, bytes: number}[], warnings: string[]}}
 */
export function normalizeScriptList(list, { max = MAX_SCRIPTS } = {}) {
  if (list === undefined || list === null) return { scripts: [], warnings: [] };
  if (!Array.isArray(list)) fail('invalid_skill', 'scripts 必须是数组');
  if (list.length > max) fail('invalid_skill', `一次最多导入 ${max} 个脚本`);
  const scripts = [];
  const warnings = [];
  const seen = new Set();
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') fail('invalid_skill', 'scripts 每一项必须是 { name, content } 对象');
    const rawName = entry.name ?? entry.path ?? entry.filename ?? entry.file ?? '';
    const rawContent = entry.content ?? entry.text ?? entry.body ?? '';
    const name = normalizeScriptName(rawName);
    const key = name.toLowerCase();
    if (seen.has(key)) {
      warnings.push(`已忽略重复的脚本：${name}`);
      continue;
    }
    seen.add(key);
    const content = normalizeScriptContent(rawContent, { name });
    scripts.push({ name, content, bytes: Buffer.byteLength(content, 'utf8') });
  }

  const names = scripts.map((script) => script.name.toLowerCase());
  const hasShell = names.some((name) => SHELL_EXT.has(extensionOf(name)));
  const hasWindows = names.some((name) => WINDOWS_EXT.has(extensionOf(name)));
  if (hasShell && !hasWindows) {
    warnings.push('提供了 Linux/macOS 的 shell 脚本，但没有配套的 Windows 脚本（.ps1 / .bat）');
  }
  return { scripts, warnings };
}

/** Markdown section telling the agent how to pick a script for its platform. */
export const SCRIPT_ENVIRONMENT_NOTE = [
  '## 脚本与环境',
  '本 Skill 的脚本位于 `scripts/` 目录，执行前先识别当前 agent 环境：',
  'Linux/macOS 使用 `.sh`、`.py`、`.js` 等；Windows 使用 `.ps1` 或 `.bat`。',
  '同一功能有多种实现时，选择与当前平台匹配的脚本，并用绝对路径调用；',
  '脚本运行失败时先检查解释器与执行权限，再回退到其它平台的等价脚本。',
].join('\n');

/**
 * Append the environment note when scripts exist and the prompt does not
 * already mention them. Returns the (possibly unchanged) body.
 */
export function withEnvironmentNote(body, scripts) {
  const text = String(body ?? '');
  if (!Array.isArray(scripts) || scripts.length === 0) return text;
  if (/scripts\//i.test(text)) return text;
  return `${text.replace(/\s+$/, '')}\n\n${SCRIPT_ENVIRONMENT_NOTE}\n`;
}

/** Short summary of scripts, used in API results and tests. */
export function summarizeScripts(scripts) {
  return (scripts || []).map((script) => ({ name: script.name, bytes: script.bytes }));
}

const FILE_MARKER = /^===\s*FILE:\s*(.+?)\s*===$/i;
const END_MARKER = /^===\s*END\s*===$/i;

/**
 * Parse the marker-delimited script format the model is asked to produce:
 *
 *   ===FILE: scripts/run.py===
 *   <source>
 *   ===END===
 *
 * Markers are matched line by line, so script bodies may contain any JSON-ish
 * or regex syntax without escaping problems.
 *
 * @param {string} text
 * @returns {{ path:string, content:string }[]}
 */
export function parseScriptBlocks(text) {
  const blocks = [];
  let current = null;
  const lines = String(text ?? '').split(/\r?\n/);
  for (const line of lines) {
    const start = FILE_MARKER.exec(line.trim());
    if (start && !current) {
      current = { path: start[1].trim(), lines: [] };
      continue;
    }
    if (current && END_MARKER.test(line.trim())) {
      blocks.push({ path: current.path, content: current.lines.join('\n') });
      current = null;
      continue;
    }
    if (current) current.lines.push(line);
  }
  return blocks;
}
